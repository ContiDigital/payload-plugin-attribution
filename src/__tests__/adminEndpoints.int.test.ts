import type { Payload } from 'payload'

import { handleEndpoints } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { ConversionDraft, DeliveryDoc, DeliveryStatus, Destination } from '../types/index.js'

import { DELIVERIES_SLUG, DELIVERY_STATUSES } from '../constants.js'
import { recordConversion } from '../server/record/recordConversion.js'
import {
  bootPayload,
  databaseName,
  destroyPayloads,
  recordingDispatcher,
} from './helpers/bootPayload.js'

const LABEL = 'admin_endpoints'
const PASSWORD = 'admin-endpoints-password'

const { calls, dispatcher } = recordingDispatcher()
let payload: Payload
let adminToken: string
let customerToken: string

type Call = { body: Record<string, unknown>; status: number }

// Requests go through Payload's REST router, which matches the registered endpoint by method
// and path, fills routeParams and authenticates the JWT header.
const api = async (
  method: 'GET' | 'POST',
  path: string,
  { body, token }: { body?: unknown; token?: string } = {},
): Promise<Call> => {
  const headers = new Headers()
  if (token) {
    headers.set('Authorization', `JWT ${token}`)
  }
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await handleEndpoints({
    config: payload.config,
    payloadInstanceCacheKey: `attribution-${LABEL}`,
    request: new Request(`http://localhost/api${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    }),
  })
  return { body: (await response.json()) as Record<string, unknown>, status: response.status }
}

const login = async (collection: string, email: string): Promise<string> => {
  await payload.create({
    collection: collection as never,
    data: { email, password: PASSWORD } as never,
    overrideAccess: true,
  })
  const { token } = await payload.login({
    collection: collection as never,
    data: { email, password: PASSWORD },
  })
  if (!token) {
    throw new Error(`no token for ${email}`)
  }
  return token
}

const draft = (eventKey: string): ConversionDraft => ({
  name: 'generate_lead',
  buyer: { email: 'buyer@example.com' },
  consent: { adUserData: 'granted' },
  context: { ipAddress: '203.0.113.9', userAgent: 'Vitest' },
  eventKey,
  occurredAt: new Date().toISOString(),
})

const deliveries = async (where: Record<string, unknown> = {}): Promise<DeliveryDoc[]> =>
  (
    await payload.find({
      collection: DELIVERIES_SLUG as never,
      depth: 0,
      limit: 0,
      overrideAccess: true,
      pagination: false,
      sort: 'sequence',
      where: where as never,
    })
  ).docs as unknown as DeliveryDoc[]

const recordGa4 = async (
  eventKey: string,
): Promise<{ eventId: number | string; row: DeliveryDoc }> => {
  const event = await recordConversion({ draft: draft(eventKey), payload })
  if (!event) {
    throw new Error(`${eventKey} was not recorded`)
  }
  const [row] = await deliveries({ event: { equals: event.id } })
  expect(row).toMatchObject({ destination: 'ga4' satisfies Destination, sequence: 0 })
  return { eventId: event.id, row }
}

const setStatus = (id: number | string, status: DeliveryStatus) =>
  payload.update({
    id,
    collection: DELIVERIES_SLUG as never,
    data: { status } as never,
    depth: 0,
    overrideAccess: true,
  })

beforeAll(async () => {
  payload = await bootPayload({
    collections: [{ slug: 'customers', auth: true, fields: [] }],
    label: LABEL,
    options: {
      destinations: { ga4: { apiSecret: 'ga4-secret', measurementId: 'G-TEST' } },
      dispatcher,
      secret: 'admin-endpoints-secret',
    },
  })
  adminToken = await login('users', 'admin@example.com')
  customerToken = await login('customers', 'customer@example.com')
})

beforeEach(() => {
  calls.length = 0
})

afterAll(destroyPayloads)

describe(`admin endpoints through the Payload router on ${databaseName}`, () => {
  it('answers 403 to anonymous requests and to users of another auth collection', async () => {
    const { eventId } = await recordGa4('forbidden')
    for (const token of [undefined, customerToken]) {
      expect(
        await api('POST', `/attribution/events/${eventId}/redeliver`, { body: {}, token }),
      ).toEqual({
        body: { error: 'forbidden' },
        status: 403,
      })
      expect((await api('GET', '/attribution/health', { token })).status).toBe(403)
    }
    expect(await deliveries({ event: { equals: eventId } })).toHaveLength(1)
  })

  it.each<DeliveryStatus>(['pending', 'dead'])(
    'redelivers a %s delivery for an admin user',
    async (status) => {
      const { eventId, row } = await recordGa4(`redeliver-${status}`)
      await setStatus(row.id, status)
      calls.length = 0
      const result = await api('POST', `/attribution/events/${eventId}/redeliver`, {
        body: { destinations: ['ga4'] },
        token: adminToken,
      })
      const rows = await deliveries({ event: { equals: eventId } })
      expect(result).toEqual({
        body: { deliveries: [{ id: rows[1].id, destination: 'ga4', status: 'pending' }] },
        status: 200,
      })
      expect(rows.map((item) => [item.sequence, item.status])).toEqual([
        [0, status === 'pending' ? 'superseded' : 'dead'],
        [1, 'pending'],
      ])
      expect(calls.map((call) => call.deliveryId)).toEqual([rows[1].id])
    },
  )

  it('refuses a sent delivery with 409, then force creates the next sequence', async () => {
    const { eventId, row } = await recordGa4('redeliver-sent')
    await setStatus(row.id, 'sent')
    const path = `/attribution/events/${eventId}/redeliver`

    expect(await api('POST', path, { body: { destinations: ['ga4'] }, token: adminToken })).toEqual(
      {
        body: { error: 'already_sent' },
        status: 409,
      },
    )
    expect(await deliveries({ event: { equals: eventId } })).toHaveLength(1)

    const forced = await api('POST', path, {
      body: { destinations: ['ga4'], force: true },
      token: adminToken,
    })
    expect(forced.status).toBe(200)
    const rows = await deliveries({ event: { equals: eventId } })
    expect(rows.map((item) => [item.sequence, item.status])).toEqual([
      [row.sequence, 'sent'],
      [row.sequence + 1, 'pending'],
    ])
  })

  it('answers 400 for an invalid id and 404 for a missing event', async () => {
    expect(
      // Invalid for both numeric and text id databases.
      await api('POST', '/attribution/events/not.an.id/redeliver', {
        body: {},
        token: adminToken,
      }),
    ).toEqual({ body: { error: 'invalid_event_id' }, status: 400 })
    expect(
      await api('POST', '/attribution/events/987654321/redeliver', { body: {}, token: adminToken }),
    ).toEqual({ body: { error: 'event_not_found' }, status: 404 })
  })

  it('reports health counts that match the delivery rows', async () => {
    const { row } = await recordGa4('health-dead')
    await setStatus(row.id, 'dead')
    const all = await deliveries()
    const result = await api('GET', '/attribution/health', { token: adminToken })
    expect(result.status).toBe(200)

    const expected = Object.fromEntries(
      DELIVERY_STATUSES.map((status) => [
        status,
        all.filter((item) => item.status === status).length,
      ]),
    )
    const pending = all
      .filter((item) => item.status === 'pending')
      .map((item) => item.createdAt)
      .sort()
    expect(result.body).toEqual({
      counts: expected,
      deadLast24h: all.filter((item) => item.status === 'dead').length,
      expiredLeases: 0,
      oldestPendingAt: pending[0] ?? null,
    })
    expect(expected.dead).toBeGreaterThan(0)
    expect(expected.pending).toBeGreaterThan(0)
  })
})
