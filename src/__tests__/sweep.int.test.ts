import type { Payload } from 'payload'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type {
  ConversionDraft,
  ConversionEventDoc,
  DeliveryDoc,
  Destination,
} from '../types/index.js'

import { DELIVERIES_SLUG, EVENTS_SLUG, LEASE_MS, TASK_DELIVER } from '../constants.js'
import { claimDelivery } from '../server/deliveries/claimDelivery.js'
import { redeliverConversion } from '../server/deliveries/redeliver.js'
import { sweepDeliveries } from '../server/deliveries/sweep.js'
import { recordConversion } from '../server/record/recordConversion.js'
import { ConflictError } from '../server/utilities/errors.js'
import {
  bootPayload,
  databaseName,
  destroyPayloads,
  recordingDispatcher,
} from './helpers/bootPayload.js'

const MINUTE = 60_000
const DAY = 86_400_000

const { calls, dispatcher } = recordingDispatcher()
let payload: Payload

const at = (value?: null | string): number => Date.parse(value ?? '')

const lead = (eventKey: string, overrides: Partial<ConversionDraft> = {}): ConversionDraft => ({
  name: 'generate_lead',
  buyer: { email: 'buyer@example.com' },
  consent: { adUserData: 'granted' },
  context: { ipAddress: '203.0.113.9', userAgent: 'Vitest' },
  eventKey,
  occurredAt: '2026-09-14T10:00:00.000Z',
  ...overrides,
})

const deliveriesFor = async (eventId: number | string): Promise<DeliveryDoc[]> =>
  (
    await payload.find({
      collection: DELIVERIES_SLUG as never,
      depth: 0,
      limit: 100,
      overrideAccess: true,
      sort: 'key',
      where: { event: { equals: eventId } },
    })
  ).docs as unknown as DeliveryDoc[]

const readDelivery = async (id: number | string): Promise<DeliveryDoc> =>
  (await payload.findByID({
    id,
    collection: DELIVERIES_SLUG as never,
    depth: 0,
    overrideAccess: true,
  })) as unknown as DeliveryDoc

const readEvent = async (id: number | string): Promise<ConversionEventDoc> =>
  (await payload.findByID({
    id,
    collection: EVENTS_SLUG as never,
    depth: 0,
    joins: false,
    overrideAccess: true,
  })) as unknown as ConversionEventDoc

const updateDelivery = (id: number | string, data: Partial<DeliveryDoc>) =>
  payload.update({
    id,
    collection: DELIVERIES_SLUG as never,
    data: data as never,
    depth: 0,
    overrideAccess: true,
  })

const expectPurged = async (eventId: number | string, at_: Date): Promise<void> => {
  const event = await readEvent(eventId)
  expect(event.identifiers?.google ?? null).toBeNull()
  expect(event.identifiers?.meta ?? null).toBeNull()
  expect(event.context?.ipAddress ?? null).toBeNull()
  expect(event.context?.userAgent ?? null).toBeNull()
  expect(at(event.identifiersPurgedAt)).toBe(at_.getTime())
  for (const row of await deliveriesFor(eventId)) {
    expect(row.request ?? null).toBeNull()
  }
}

const expectKept = async (eventId: number | string): Promise<void> => {
  const event = await readEvent(eventId)
  expect(event.identifiers?.google?.emailSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(event.context?.ipAddress).toBeTruthy()
  expect(event.identifiersPurgedAt ?? null).toBeNull()
}

const record = async (eventKey: string, overrides: Partial<ConversionDraft> = {}) => {
  const event = await recordConversion({ draft: lead(eventKey, overrides), payload })
  if (!event) {
    throw new Error(`${eventKey} was not recorded`)
  }
  const rows = await deliveriesFor(event.id)
  calls.length = 0
  return {
    event,
    row: (destination: Destination): DeliveryDoc => {
      const found = rows.find((candidate) => candidate.destination === destination)
      if (!found) {
        throw new Error(`${eventKey} has no ${destination} delivery`)
      }
      return found
    },
    rows,
  }
}

beforeAll(async () => {
  payload = await bootPayload({
    label: 'sweep',
    options: {
      destinations: {
        ga4: { apiSecret: 'ga4-secret', measurementId: 'G-TEST' },
        meta: { accessToken: 'meta-token', pixelId: '42' },
      },
      dispatcher,
      secret: 'sweep-test-secret',
    },
  })
})

beforeEach(() => {
  calls.length = 0
})

afterAll(destroyPayloads)

describe(`sweepDeliveries on ${databaseName}`, () => {
  it('recovers an expired lease and re-dispatches it', async () => {
    const ga4 = (await record('sweep-lease')).row('ga4')
    const claimedAt = new Date(Date.now() - LEASE_MS - 1000)
    expect(await claimDelivery(payload, ga4, claimedAt, { clock: () => claimedAt })).not.toBeNull()

    const now = new Date()
    const result = await sweepDeliveries({ now, payload })
    expect(result.recovered).toBeGreaterThanOrEqual(1)
    expect(result.redispatched).toBeGreaterThanOrEqual(1)
    const stored = await readDelivery(ga4.id)
    expect(stored).toMatchObject({ attempt: 1, reason: 'lease_expired', status: 'retry' })
    expect(at(stored.nextAttemptAt)).toBe(now.getTime())
    expect(stored.leaseExpiresAt ?? null).toBeNull()
    expect(calls.map((call) => call.deliveryId)).toContain(ga4.id)

    expect(await claimDelivery(payload, stored, now)).toMatchObject({ attempt: 2 })
  })

  it('re-dispatches due retries and stale pending rows, not fresh ones', async () => {
    const { row } = await record('sweep-due')
    const ga4 = row('ga4')
    const meta = row('meta')
    const now = new Date()
    const overdue = new Date(now.getTime() - 6 * MINUTE).toISOString()
    await updateDelivery(ga4.id, {
      attempt: 1,
      lastDispatchedAt: overdue,
      nextAttemptAt: overdue,
      status: 'retry',
    } as Partial<DeliveryDoc>)

    await sweepDeliveries({ now, payload })
    const early = calls.map((call) => call.deliveryId)
    expect(early).toContain(ga4.id)
    expect(early).not.toContain(meta.id)

    calls.length = 0
    await sweepDeliveries({ now: new Date(Date.now() + 6 * MINUTE), payload })
    expect(calls.map((call) => call.deliveryId)).toContain(meta.id)
  })

  it('closes a wait whose deadline has passed without dispatching it', async () => {
    const { event, row } = await record('sweep-deadline')
    const ga4 = row('ga4')
    const now = new Date()
    await updateDelivery(ga4.id, {
      deadlineAt: new Date(now.getTime() - MINUTE).toISOString(),
      nextAttemptAt: new Date(now.getTime() - MINUTE).toISOString(),
      reason: 'feed_window',
      status: 'retry',
    })
    await sweepDeliveries({ now, payload })
    expect(await readDelivery(ga4.id)).toMatchObject({
      reason: 'deadline_passed',
      status: 'withheld',
    })
    expect(calls.map((call) => call.deliveryId)).not.toContain(ga4.id)
    expect((await readEvent(event.id)).deliverySummary?.ga4).toEqual({
      reason: 'deadline_passed',
      status: 'withheld',
    })
  })

  it('purges identifiers of settled events older than the retention period', async () => {
    const now = Date.now()
    const sweepNow = new Date(now + 91 * DAY)
    const expired = await record('sweep-purge-expired', { occurredAt: new Date(now).toISOString() })
    const recent = await record('sweep-purge-recent', {
      occurredAt: new Date(now + 10 * DAY).toISOString(),
    })
    const open = await record('sweep-purge-open', { occurredAt: new Date(now).toISOString() })
    for (const row of [...expired.rows, ...recent.rows]) {
      await updateDelivery(row.id, { request: { user_data: { em: 'hash' } }, status: 'sent' })
    }
    await updateDelivery(open.row('meta').id, { status: 'sent' })

    const result = await sweepDeliveries({ now: sweepNow, payload })
    expect(result.purged).toBeGreaterThanOrEqual(1)
    await expectPurged(expired.event.id, sweepNow)
    await expectKept(recent.event.id)
    await expectKept(open.event.id)
  })

  it('clears click ids, Meta browser ids and GA identity from stored attribution on purge', async () => {
    const now = Date.now()
    const sweepNow = new Date(now + 91 * DAY)
    const fbclid = 'IwAR_purge_fbclid_123'
    const { event, rows } = await record('sweep-purge-attribution', {
      attribution: {
        clickCapturedAt: new Date(now).toISOString(),
        fbc: `fb.1.${now}.${fbclid}`,
        fbclid,
        fbp: 'fb.1.1757779200000.123456789',
        gaClientId: '123456789.1700000000',
        gaSessionId: '1700000000',
        gaSessionNumber: 3,
        gbraid: 'gbraid_purge_0123456',
        gclid: 'gclid_purge_0123456',
        landingPath: '/artists',
        msclkid: 'msclkid_purge_01234',
        utmSource: 'google',
      },
      occurredAt: new Date(now).toISOString(),
    })
    for (const row of rows) {
      await updateDelivery(row.id, { status: 'sent' })
    }
    await sweepDeliveries({ limit: 1000, now: sweepNow, payload })
    await expectPurged(event.id, sweepNow)
    const attribution = (await readEvent(event.id)).attribution ?? {}
    for (const key of [
      'clickCapturedAt',
      'fbc',
      'fbclid',
      'fbp',
      'gaClientId',
      'gaSessionId',
      'gaSessionNumber',
      'gaSessionStartedAt',
      'gbraid',
      'gclid',
      'msclkid',
    ] as const) {
      expect(attribution[key] ?? null).toBeNull()
    }
    expect(attribution).toMatchObject({ landingPath: '/artists', utmSource: 'google' })
  })

  it('purges events whose deliveries are only served or only eligible', async () => {
    const sweepNow = new Date(Date.now() + 91 * DAY)
    const served = await record('sweep-purge-served')
    const eligible = await record('sweep-purge-eligible')
    for (const row of served.rows) {
      await updateDelivery(row.id, { request: { user_data: { em: 'hash' } }, status: 'served' })
    }
    for (const row of eligible.rows) {
      await updateDelivery(row.id, { request: { user_data: { em: 'hash' } }, status: 'eligible' })
    }
    await sweepDeliveries({ limit: 1000, now: sweepNow, payload })
    await expectPurged(served.event.id, sweepNow)
    await expectPurged(eligible.event.id, sweepNow)
  })

  it('keeps purging past a long run of old unsettled events', async () => {
    const sweepNow = new Date(Date.now() + 91 * DAY)
    await sweepDeliveries({ limit: 1000, now: sweepNow, payload })
    for (let index = 0; index < 25; index++) {
      await record(`sweep-unsettled-${index}`)
    }
    const settled = [await record('sweep-settled-a'), await record('sweep-settled-b')]
    for (const { rows } of settled) {
      for (const row of rows) {
        await updateDelivery(row.id, { status: 'sent' })
      }
    }
    const result = await sweepDeliveries({ limit: 2, now: sweepNow, payload })
    expect(result.purged).toBe(2)
    for (const { event } of settled) {
      await expectPurged(event.id, sweepNow)
    }
  })

  it('measures retention from the last write and applies it again after a revision', async () => {
    const now = Date.now()
    const occurredAt = new Date(now - 100 * DAY).toISOString()
    const first = await record('sweep-repurge', { occurredAt })
    for (const row of first.rows) {
      await updateDelivery(row.id, { status: 'sent' })
    }
    await sweepDeliveries({ now: new Date(now), payload })
    await expectKept(first.event.id)

    const sweepNow = new Date(now + 91 * DAY)
    await sweepDeliveries({ now: sweepNow, payload })
    await expectPurged(first.event.id, sweepNow)

    const second = await recordConversion({
      draft: lead('sweep-repurge', {
        buyer: { email: 'second@example.com' },
        context: { ipAddress: '198.51.100.4', userAgent: 'Vitest' },
        occurredAt,
        revision: 2,
      }),
      payload,
    })
    expect(second?.identifiersPurgedAt ?? null).toBeNull()
    expect((await readEvent(first.event.id)).context?.ipAddress).toBe('198.51.100.4')
    for (const row of await deliveriesFor(first.event.id)) {
      if (row.revision === 2) {
        await updateDelivery(row.id, { status: 'sent' })
      }
    }
    const later = new Date(sweepNow.getTime() + DAY)
    await sweepDeliveries({ now: later, payload })
    await expectPurged(first.event.id, later)
  })

  it('ends a crash loop at dead once maxAttempts is reached', async () => {
    const { event, row } = await record('sweep-crash-loop')
    let delivery = row('ga4')
    let clock = Date.now() - DAY
    for (let attempt = 1; attempt <= 6; attempt++) {
      const claimedAt = new Date(clock)
      const claimed = await claimDelivery(payload, delivery, claimedAt, { clock: () => claimedAt })
      expect(claimed).toMatchObject({ attempt })
      clock += LEASE_MS + 1000
      await sweepDeliveries({ now: new Date(clock), payload })
      delivery = await readDelivery(delivery.id)
    }
    expect(delivery).toMatchObject({ attempt: 6, reason: 'retry_exhausted', status: 'dead' })
    expect((await readEvent(event.id)).deliverySummary?.ga4).toEqual({
      reason: 'retry_exhausted',
      status: 'dead',
    })
    await updateDelivery(delivery.id, {
      nextAttemptAt: new Date(clock).toISOString(),
      status: 'retry',
    })
    expect(
      await claimDelivery(payload, await readDelivery(delivery.id), new Date(clock)),
    ).toBeNull()
  })
})

describe(`sweep after maxAttempts was lowered on ${databaseName}`, () => {
  it('settles a due row that already used its attempts as dead instead of re-dispatching it', async () => {
    const { event, row } = await record('sweep-lowered-max')
    const ga4 = row('ga4')
    const past = new Date(Date.now() - DAY).toISOString()
    await updateDelivery(ga4.id, {
      attempt: 6,
      lastDispatchedAt: past,
      nextAttemptAt: past,
      status: 'retry',
    })

    await sweepDeliveries({ payload })
    expect(calls.map((call) => call.deliveryId)).not.toContain(ga4.id)
    expect(await readDelivery(ga4.id)).toMatchObject({ reason: 'retry_exhausted', status: 'dead' })
    expect((await readEvent(event.id)).deliverySummary?.ga4).toEqual({
      reason: 'retry_exhausted',
      status: 'dead',
    })
  })
})

describe(`redeliverConversion on ${databaseName}`, () => {
  it('refuses to resend a sent delivery unless forced', async () => {
    const { event, row } = await record('redeliver-sent')
    const ga4 = row('ga4')
    await updateDelivery(ga4.id, { attempt: 1, status: 'sent' })

    const refusal = redeliverConversion({ destinations: ['ga4'], eventId: event.id, payload })
    await expect(refusal).rejects.toBeInstanceOf(ConflictError)
    await expect(refusal).rejects.toThrow('already_sent')
    expect(await deliveriesFor(event.id)).toHaveLength(2)
    expect(calls).toHaveLength(0)

    const created = await redeliverConversion({
      destinations: ['ga4'],
      eventId: event.id,
      force: true,
      payload,
    })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      attempt: 0,
      destination: 'ga4',
      key: `${event.id}:ga4:r1:s1`,
      revision: 1,
      sequence: 1,
      status: 'pending',
    })
    expect(calls.map((call) => call.deliveryId)).toEqual([created[0].id])
    expect(await readDelivery(ga4.id)).toMatchObject({ status: 'sent' })
    expect((await readEvent(event.id)).revision).toBe(1)
  })

  it('refuses to supersede a delivery a feed already served unless forced', async () => {
    const { event, row } = await record('redeliver-served')
    const ga4 = row('ga4')
    const servedAt = new Date(Date.now() - DAY).toISOString()
    await updateDelivery(ga4.id, {
      firstServedAt: servedAt,
      lastServedAt: servedAt,
      status: 'served',
    })

    const refusal = redeliverConversion({ destinations: ['ga4'], eventId: event.id, payload })
    await expect(refusal).rejects.toThrow('already_sent')
    expect(await readDelivery(ga4.id)).toMatchObject({ status: 'served' })

    const created = await redeliverConversion({
      destinations: ['ga4'],
      eventId: event.id,
      force: true,
      payload,
    })
    expect(created.map((item) => [item.destination, item.sequence])).toEqual([['ga4', 1]])
  })

  it('refuses to resend a sent Meta delivery unless forced', async () => {
    const { event, row } = await record('redeliver-meta-sent')
    const meta = row('meta')
    await updateDelivery(meta.id, { attempt: 1, status: 'sent' })

    const refusal = redeliverConversion({ destinations: ['meta'], eventId: event.id, payload })
    await expect(refusal).rejects.toBeInstanceOf(ConflictError)
    await expect(refusal).rejects.toThrow('already_sent')
    expect(await deliveriesFor(event.id)).toHaveLength(2)

    const created = await redeliverConversion({
      destinations: ['meta'],
      eventId: event.id,
      force: true,
      payload,
    })
    expect(created.map((item) => [item.destination, item.sequence, item.status])).toEqual([
      ['meta', 1, 'pending'],
    ])
  })

  it('refuses to redeliver an event whose identifiers were purged unless forced', async () => {
    const now = Date.now()
    const { event, row } = await record('redeliver-purged', {
      occurredAt: new Date(now).toISOString(),
    })
    for (const destination of ['ga4', 'meta'] as const) {
      await updateDelivery(row(destination).id, { status: 'dead' })
    }
    await sweepDeliveries({ now: new Date(now + 91 * DAY), payload })
    expect((await readEvent(event.id)).identifiersPurgedAt).toBeTruthy()

    const refusal = redeliverConversion({ destinations: ['meta'], eventId: event.id, payload })
    await expect(refusal).rejects.toBeInstanceOf(ConflictError)
    await expect(refusal).rejects.toThrow('identifiers_purged')

    const created = await redeliverConversion({
      destinations: ['meta'],
      eventId: event.id,
      force: true,
      payload,
    })
    expect(created.map((item) => item.destination)).toEqual(['meta'])
  })

  it('judges an in-flight lease against the supplied now', async () => {
    const { event, row } = await record('redeliver-now')
    const claimedAt = new Date()
    await claimDelivery(payload, row('ga4'), claimedAt, { clock: () => claimedAt })
    await expect(
      redeliverConversion({ destinations: ['ga4'], eventId: event.id, payload }),
    ).rejects.toThrow('delivery_in_progress')
    const created = await redeliverConversion({
      destinations: ['ga4'],
      eventId: event.id,
      now: new Date(claimedAt.getTime() + LEASE_MS + 1),
      payload,
    })
    expect(created[0]).toMatchObject({ destination: 'ga4', sequence: 1 })
  })

  it('never consumes a host revision, so revision 2 still records', async () => {
    const { event } = await record('redeliver-revision')
    const created = await redeliverConversion({ eventId: event.id, payload })
    expect(created.map((row) => [row.destination, row.revision, row.sequence])).toEqual([
      ['ga4', 1, 1],
      ['meta', 1, 1],
    ])
    expect((await readEvent(event.id)).revision).toBe(1)

    const second = await recordConversion({
      draft: lead('redeliver-revision', { revision: 2 }),
      payload,
    })
    expect(second).toMatchObject({ id: event.id, revision: 2 })
    const rows = await deliveriesFor(event.id)
    for (const row of rows.filter((candidate) => candidate.revision === 1)) {
      expect(row.status).toBe('superseded')
    }
    expect(
      rows
        .filter((row) => row.revision === 2)
        .map((row) => [row.destination, row.sequence, row.status]),
    ).toEqual([
      ['ga4', 0, 'withheld'],
      ['meta', 0, 'withheld'],
    ])
  })
})

describe(`sweep with Payload Jobs on ${databaseName}`, () => {
  it('leaves one queued job per delivery across repeated sweeps', async () => {
    const jobs = await bootPayload({
      label: 'sweep_jobs',
      options: {
        destinations: { ga4: { apiSecret: 'ga4-secret', measurementId: 'G-TEST' } },
        secret: 'sweep-jobs-secret',
      },
    })
    const event = await recordConversion({ draft: lead('sweep-jobs'), payload: jobs })
    const { docs } = await jobs.find({
      collection: DELIVERIES_SLUG as never,
      depth: 0,
      overrideAccess: true,
      where: { event: { equals: event?.id } },
    })
    const ga4 = docs[0] as unknown as DeliveryDoc
    const deliverJobs = { taskSlug: { equals: TASK_DELIVER } }
    await jobs.delete({
      collection: 'payload-jobs' as never,
      overrideAccess: true,
      where: deliverJobs,
    })
    const start = Date.now()
    const overdue = new Date(start - 10 * MINUTE).toISOString()
    await jobs.update({
      id: ga4.id,
      collection: DELIVERIES_SLUG as never,
      data: {
        attempt: 1,
        lastDispatchedAt: overdue,
        nextAttemptAt: overdue,
        status: 'retry',
      } as never,
      overrideAccess: true,
    })
    for (let run = 0; run < 5; run++) {
      await sweepDeliveries({ now: new Date(start + run * MINUTE), payload: jobs })
    }
    const { totalDocs } = await jobs.count({
      collection: 'payload-jobs' as never,
      overrideAccess: true,
      where: deliverJobs,
    })
    expect(totalDocs).toBe(1)
  })
})
