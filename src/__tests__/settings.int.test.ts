import type { Payload } from 'payload'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { DeliveryDoc } from '../types/index.js'

import { DELIVERIES_SLUG } from '../constants.js'
import { runDelivery } from '../server/deliveries/runDelivery.js'
import { recordConversion } from '../server/record/recordConversion.js'
import { verifyDestination } from '../server/verify/verifyDestination.js'
import {
  bootPayload,
  databaseName,
  destroyPayloads,
  recordingDispatcher,
} from './helpers/bootPayload.js'

const { dispatcher } = recordingDispatcher()
let payload: Payload
let secretOutage = true

beforeAll(async () => {
  payload = await bootPayload({
    label: 'settings',
    options: {
      destinations: {
        ga4: {
          apiSecret: () => {
            if (secretOutage) {
              throw new Error('secret manager unavailable')
            }
            return 'ga4-secret'
          },
          measurementId: 'G-TEST',
        },
      },
      dispatcher,
      // Never contacted: fetch is replaced below.
      endpoints: { ga4: 'http://127.0.0.1:9' },
      secret: 'settings-test-secret',
    },
  })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await destroyPayloads()
})

describe(`function settings that throw on ${databaseName}`, () => {
  it('retries a delivery with settings_unavailable and sends it once the setting resolves', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetchMock)
    // Payload's own boot telemetry also goes through fetch; only GA4 collect calls count here.
    const collectCalls = (): unknown[] =>
      fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]).includes('/mp/collect'))
    const errorLog = vi.spyOn(payload.logger, 'error').mockImplementation(() => undefined)
    const warnLog = vi.spyOn(payload.logger, 'warn').mockImplementation(() => undefined)
    const event = await recordConversion({
      draft: {
        name: 'generate_lead',
        eventKey: 'settings-outage',
        occurredAt: new Date().toISOString(),
      },
      payload,
    })
    const { docs } = await payload.find({
      collection: DELIVERIES_SLUG as never,
      depth: 0,
      overrideAccess: true,
      where: { event: { equals: event?.id } },
    })
    const ga4 = docs[0] as unknown as DeliveryDoc
    const now = new Date()

    secretOutage = true
    expect(await verifyDestination({ destination: 'ga4', eventId: event!.id, payload })).toEqual({
      details: { reason: 'settings_unavailable' },
      ok: false,
    })
    const first = await runDelivery({ deliveryId: ga4.id, now, payload })
    expect(first).toMatchObject({ reason: 'settings_unavailable', status: 'retry' })
    expect(collectCalls()).toHaveLength(0)

    secretOutage = false
    const due = new Date(Date.parse(first.nextAttemptAt!) + 1000)
    expect(await runDelivery({ deliveryId: ga4.id, now: due, payload })).toMatchObject({
      status: 'sent',
    })
    expect(collectCalls()).toHaveLength(1)
    errorLog.mockRestore()
    warnLog.mockRestore()
  })
})
