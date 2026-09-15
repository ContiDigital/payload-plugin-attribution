import type { Payload, PayloadRequest } from 'payload'

import { setTimeout as delay } from 'node:timers/promises'
import { createLocalReq } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AttributionPluginOptions,
  ConversionDraft,
  ConversionEventDoc,
  DeliveryDoc,
} from '../types/index.js'

import { DELIVERIES_SLUG, EVENTS_SLUG, WRITE_CONFLICT_RETRY_DELAY_MS } from '../constants.js'
import { recordConversion } from '../server/record/recordConversion.js'
import { isMongoWriteConflict, isUniqueConflict, PluginError } from '../server/utilities/errors.js'
import { withTransaction } from '../server/utilities/transaction.js'
import {
  bootPayload,
  databaseName,
  destroyPayloads,
  isSqlite,
  mongodbUrl,
  postgresUrl,
  recordingDispatcher,
} from './helpers/bootPayload.js'

const { calls, dispatcher, hooks } = recordingDispatcher()
const gate = { entered: (): void => undefined, opened: Promise.resolve() }
let payload: Payload

const options: AttributionPluginOptions = {
  destinations: {
    ga4: { apiSecret: 'ga4-secret', measurementId: 'G-TEST' },
    googleAds: {
      adjustments: { enabled: true },
      conversionActions: { lead: '111', sale: '222' },
      feed: { password: 'feed-password', username: 'feed-user' },
      operatingAccountId: '1234567890',
      serviceAccountJson: '{}',
      transport: 'dataManager',
    },
    meta: { accessToken: 'meta-token', pixelId: '42' },
  },
  dispatcher,
  identity: {
    defaultPhoneCountry: 'US',
    resolve: ({ customerId }) => {
      if (customerId === 'explode') {
        return Promise.reject(new Error('identity resolver unavailable'))
      }
      if (customerId === 'gated') {
        gate.entered()
        return gate.opened.then(() => ({ userId: 'customer-gated' }))
      }
      if (customerId === 'invalid-user-id') {
        return Promise.resolve({ userId: '' })
      }
      if (customerId === 'nested') {
        return recordConversion({ draft: lead('from-resolver'), payload }).then(() => ({
          userId: 'customer-nested',
        }))
      }
      return Promise.resolve({
        email: 'Buyer@Example.com',
        marketingConsent: true,
        userId: `customer-${customerId}`,
      })
    },
  },
  secret: 'record-test-secret',
}

const lead = (eventKey: string, overrides: Partial<ConversionDraft> = {}): ConversionDraft => ({
  name: 'generate_lead',
  consent: { adUserData: 'granted' },
  eventKey,
  googleAds: { action: 'lead' },
  occurredAt: '2026-09-14T10:00:00.000Z',
  transactionId: `tx-${eventKey}`,
  ...overrides,
})

const purchase = (eventKey: string, transactionId: string): ConversionDraft => ({
  name: 'purchase',
  eventKey,
  items: [{ item_id: 'artwork-1', price: 1200, quantity: 1 }],
  occurredAt: '2026-09-14T09:00:00.000Z',
  transactionId,
  valueCents: 120000,
})

const eventsByKey = async (eventKey: string, req?: PayloadRequest) =>
  (
    await payload.find({
      collection: EVENTS_SLUG as never,
      depth: 0,
      overrideAccess: true,
      req,
      where: { eventKey: { equals: eventKey } },
    })
  ).docs as unknown as ConversionEventDoc[]

const deliveriesFor = async (eventId: number | string) =>
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

const countDeliveries = async () =>
  (await payload.count({ collection: DELIVERIES_SLUG as never, overrideAccess: true })).totalDocs

const hostRequest = async (): Promise<PayloadRequest> => {
  const req = await createLocalReq({}, payload)
  req.transactionID = (await payload.db.beginTransaction()) ?? undefined
  expect(req.transactionID).toBeTruthy()
  return req
}

beforeAll(async () => {
  payload = await bootPayload({ label: 'record', options })
})

beforeEach(() => {
  calls.length = 0
  hooks.onDispatch = undefined
})

afterAll(destroyPayloads)

describe(`recordConversion on ${databaseName}`, () => {
  it('rolls back the event, deliveries and dispatches with the host transaction', async () => {
    const before = await countDeliveries()
    const req = await hostRequest()
    const transactionID = req.transactionID

    const event = await recordConversion({ draft: lead('host-rollback'), payload, req })
    expect(event?.eventKey).toBe('host-rollback')
    expect(req.transactionID).toBe(transactionID)
    expect(await eventsByKey('host-rollback', req)).toHaveLength(1)
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call.req === req)).toBe(true)

    await payload.db.rollbackTransaction(transactionID as number | string)
    expect(await eventsByKey('host-rollback')).toHaveLength(0)
    expect(await countDeliveries()).toBe(before)
  })

  it('opens its own transaction without mutating a caller request that has none', async () => {
    const req = await createLocalReq({}, payload)
    const event = await recordConversion({ draft: lead('own-transaction'), payload, req })
    expect(req.transactionID).toBeUndefined()
    expect(await eventsByKey('own-transaction')).toHaveLength(1)
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call.req === undefined)).toBe(true)
    expect(event?.eventId).toBe('own-transaction')
  })

  it('stores an explicit eventId', async () => {
    const event = await recordConversion({
      draft: lead('explicit-event-id', { eventId: 'browser-event-1' }),
      payload,
    })
    expect(event?.eventId).toBe('browser-event-1')
  })

  it('returns the same event on replay without new deliveries', async () => {
    const first = await recordConversion({ draft: lead('replay'), payload })
    const deliveries = await deliveriesFor(first?.id as number | string)
    expect(deliveries.map((row) => [row.destination, row.status])).toEqual([
      ['ga4', 'pending'],
      ['googleAds', 'pending'],
      ['meta', 'pending'],
    ])
    calls.length = 0

    const replay = await recordConversion({ draft: lead('replay'), payload })
    expect(replay?.id).toBe(first?.id)
    expect(await deliveriesFor(first?.id as number | string)).toHaveLength(3)
    expect(calls).toHaveLength(0)
  })

  it('supersedes revision 1 deliveries and replaces the snapshot on revision 2', async () => {
    const first = await recordConversion({
      draft: lead('revision', {
        attribution: { fbclid: 'F'.repeat(20), gclid: 'G'.repeat(20) },
        buyer: { email: 'first@example.com', phone: '5555550100' },
        subject: { id: 7, collectionSlug: 'leads' },
        valueCents: 1000,
      }),
      payload,
    })
    expect(first?.attribution).toMatchObject({ fbclid: 'F'.repeat(20) })
    const id = first?.id as number | string
    const originalDeliveries = await deliveriesFor(id)
    calls.length = 0

    const second = await recordConversion({
      draft: lead('revision', {
        attribution: { gclid: 'G'.repeat(20) },
        buyer: { email: 'second@example.com' },
        revision: 2,
        valueCents: 2500,
      }),
      payload,
    })
    expect(second).toMatchObject({ id, revision: 2, valueCents: 2500 })
    const stored = (await eventsByKey('revision'))[0]
    expect(stored.attribution?.fbclid ?? undefined).toBeUndefined()
    expect(stored.attribution?.gclid).toBe('G'.repeat(20))
    expect(stored.identifiers?.google?.phoneSha256 ?? undefined).toBeUndefined()
    expect(stored.subject?.id ?? undefined).toBeUndefined()

    const rows = await deliveriesFor(id)
    expect(rows).toHaveLength(originalDeliveries.length + 3)
    for (const row of rows.filter((candidate) => candidate.revision === 1)) {
      expect(row.status).toBe('superseded')
    }
    const current = rows.filter((row) => row.revision === 2)
    expect(current.map((row) => [row.destination, row.status, row.reason ?? undefined])).toEqual([
      ['ga4', 'withheld', 'revision_not_resent'],
      ['googleAds', 'pending', undefined],
      ['meta', 'withheld', 'revision_not_resent'],
    ])
    expect(calls.map((call) => call.deliveryId).sort()).toEqual(
      current
        .filter((row) => row.status === 'pending')
        .map((row) => row.id)
        .sort(),
    )

    const warnLog = vi.spyOn(payload.logger, 'warn').mockImplementation(() => undefined)
    const identityChange = await recordConversion({
      draft: lead('revision', { occurredAt: '2026-09-15T10:00:00.000Z', revision: 3 }),
      payload,
    })
    expect(identityChange).toBeNull()
    expect((await eventsByKey('revision'))[0].revision).toBe(2)
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('event identity cannot change') }),
    )
    warnLog.mockRestore()
  })

  it('creates withheld deliveries without dispatching them', async () => {
    const event = await recordConversion({
      draft: lead('consent-denied', { consent: { adUserData: 'denied' } }),
      payload,
    })
    const rows = await deliveriesFor(event?.id as number | string)
    expect(rows.map((row) => [row.destination, row.status, row.reason ?? undefined])).toEqual([
      ['ga4', 'pending', undefined],
      ['googleAds', 'withheld', 'consent_denied'],
      ['meta', 'withheld', 'consent_denied'],
    ])
    expect(calls.map((call) => call.deliveryId)).toEqual([rows[0].id])
    expect(event?.deliverySummary).toEqual({
      ga4: { status: 'pending' },
      googleAds: { reason: 'consent_denied', status: 'withheld' },
      meta: { reason: 'consent_denied', status: 'withheld' },
    })
  })

  it('skips destinations the draft opts out of', async () => {
    const event = await recordConversion({
      draft: lead('opt-out', { destinations: { ga4: false, meta: false } }),
      payload,
    })
    const rows = await deliveriesFor(event?.id as number | string)
    expect(rows.map((row) => row.destination)).toEqual(['googleAds'])
  })

  it('resolves identity into hashed identifiers and host consent', async () => {
    const event = await recordConversion({
      draft: lead('identity', { consent: undefined, customerId: 9 }),
      payload,
    })
    expect(event).toMatchObject({
      consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'unknown' },
      userId: 'customer-9',
    })
    expect(event?.identifiers?.google?.emailSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(event?.identifiers?.meta?.em).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns null with a warning for an invalid draft', async () => {
    const warnLog = vi.spyOn(payload.logger, 'warn').mockImplementation(() => undefined)
    expect(
      await recordConversion({ draft: lead('invalid', { occurredAt: 'nope' }), payload }),
    ).toBeNull()
    expect(await eventsByKey('invalid')).toHaveLength(0)
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('invalid conversion draft') }),
    )
    warnLog.mockRestore()
  })

  it('keeps one purchase per transaction and requires an earlier purchase for refunds', async () => {
    const warnLog = vi.spyOn(payload.logger, 'warn').mockImplementation(() => undefined)
    const original = await recordConversion({ draft: purchase('purchase-a', 'order-9'), payload })
    const duplicate = await recordConversion({ draft: purchase('purchase-b', 'order-9'), payload })
    expect(duplicate?.id).toBe(original?.id)
    expect(await eventsByKey('purchase-b')).toHaveLength(0)

    const orphanRefund = await recordConversion({
      draft: {
        name: 'refund',
        eventKey: 'refund-orphan',
        occurredAt: '2026-09-14T11:00:00.000Z',
        transactionId: 'order-404',
      },
      payload,
    })
    expect(orphanRefund).toBeNull()

    const earlyRefund = await recordConversion({
      draft: {
        name: 'refund',
        eventKey: 'refund-early',
        occurredAt: '2026-09-14T08:00:00.000Z',
        transactionId: 'order-9',
      },
      payload,
    })
    expect(earlyRefund).toBeNull()

    const refund = await recordConversion({
      draft: {
        name: 'refund',
        eventKey: 'refund-ok',
        occurredAt: '2026-09-14T11:00:00.000Z',
        transactionId: 'order-9',
      },
      payload,
    })
    expect(refund?.eventKey).toBe('refund-ok')
    expect(warnLog).toHaveBeenCalledTimes(3)
    warnLog.mockRestore()
  })

  it('propagates an identity resolver failure and rolls back the host transaction', async () => {
    const req = await hostRequest()
    await payload.create({
      collection: 'users' as never,
      data: { email: 'host-write@example.com', password: 'host-password' } as never,
      overrideAccess: true,
      req,
    })
    await expect(
      recordConversion({ draft: lead('resolver-fails', { customerId: 'explode' }), payload, req }),
    ).rejects.toThrow('identity resolver unavailable')
    await payload.db.rollbackTransaction(req.transactionID as number | string)

    const users = await payload.count({
      collection: 'users' as never,
      overrideAccess: true,
      where: { email: { equals: 'host-write@example.com' } },
    })
    expect(users.totalDocs).toBe(0)
    expect(await eventsByKey('resolver-fails')).toHaveLength(0)
    expect(calls).toHaveLength(0)

    await expect(
      recordConversion({ draft: lead('resolver-fails', { customerId: 'explode' }), payload }),
    ).rejects.toThrow('identity resolver unavailable')
    expect(await eventsByKey('resolver-fails')).toHaveLength(0)
  })

  it('dispatches only after its own transaction commits', async () => {
    let visibleOutside = false
    hooks.onDispatch = async () => {
      visibleOutside = (await eventsByKey('dispatch-after-commit')).length === 1
    }
    await recordConversion({ draft: lead('dispatch-after-commit'), payload })
    expect(visibleOutside).toBe(true)
  })

  it('logs a dispatch failure after commit and keeps the recorded event', async () => {
    const errorLog = vi.spyOn(payload.logger, 'error').mockImplementation(() => undefined)
    hooks.onDispatch = () => Promise.reject(new Error('queue unavailable'))
    const event = await recordConversion({ draft: lead('dispatch-fails'), payload })
    expect(event?.eventKey).toBe('dispatch-fails')
    const rows = await deliveriesFor(event?.id as number | string)
    expect(rows.every((row) => row.status === 'pending')).toBe(true)
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('dispatch failed after commit') }),
    )
    errorLog.mockRestore()
  })

  it(
    'records from inside a plugin-owned transaction without deadlocking',
    { timeout: 2000 },
    async () => {
      const event = await withTransaction(payload, undefined, () =>
        recordConversion({ draft: lead('nested-in-owned'), payload }),
      )
      expect(event?.eventKey).toBe('nested-in-owned')
      expect(await eventsByKey('nested-in-owned')).toHaveLength(1)
    },
  )

  it(
    'lets a resolver record another conversion inside a plugin-owned transaction',
    { timeout: 2000 },
    async () => {
      const event = await withTransaction(payload, undefined, () =>
        recordConversion({ draft: lead('resolver-outer', { customerId: 'nested' }), payload }),
      )
      expect(event?.userId).toBe('customer-nested')
      expect(await eventsByKey('from-resolver')).toHaveLength(1)
    },
  )

  it(
    'lets a dispatcher record another conversion without deadlocking',
    { timeout: 2000 },
    async () => {
      hooks.onDispatch = async (call) => {
        hooks.onDispatch = undefined
        expect(call.deliveryId).toBeDefined()
        await recordConversion({ draft: lead('from-dispatcher'), payload })
      }
      await withTransaction(payload, undefined, () =>
        recordConversion({ draft: lead('dispatcher-outer'), payload }),
      )
      expect(await eventsByKey('from-dispatcher')).toHaveLength(1)
    },
  )

  it('resolves concurrent first recordings of one eventKey to one event', async () => {
    const [first, second] = await Promise.all([
      recordConversion({ draft: lead('duplicate-first'), payload }),
      recordConversion({ draft: lead('duplicate-first'), payload }),
    ])
    expect(first?.id).toBeDefined()
    expect(second?.id).toBe(first?.id)
    expect(await eventsByKey('duplicate-first')).toHaveLength(1)
    expect(await deliveriesFor(first?.id as number | string)).toHaveLength(3)
  })

  it.runIf(!isSqlite)(
    'propagates a duplicate first recording inside a host transaction unchanged',
    async () => {
      const [first, second] = [await hostRequest(), await hostRequest()]
      await recordConversion({ draft: lead('duplicate-host'), payload, req: first })
      const blocked = recordConversion({
        draft: lead('duplicate-host'),
        payload,
        req: second,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      await delay(200)
      await payload.db.commitTransaction(first.transactionID as number | string)
      const error = await blocked
      // MongoDB reports the uncommitted duplicate as a WriteConflict rather than a unique error.
      expect(mongodbUrl ? isMongoWriteConflict(error) : isUniqueConflict(error, 'eventKey')).toBe(
        true,
      )
      await payload.db.rollbackTransaction(second.transactionID as number | string)
      expect(await eventsByKey('duplicate-host')).toHaveLength(1)
    },
  )

  it.runIf(!isSqlite)('keeps a newer revision recorded in an open host transaction', async () => {
    await recordConversion({ draft: lead('locked-revision'), payload })
    const host = await hostRequest()
    await recordConversion({
      draft: lead('locked-revision', { revision: 3 }),
      payload,
      req: host,
    })
    const older = recordConversion({ draft: lead('locked-revision', { revision: 2 }), payload })
    // SQL adapters make the older revision wait on the lock. MongoDB fails it at once with a
    // WriteConflict and retries once after WRITE_CONFLICT_RETRY_DELAY_MS.min, so the host
    // commits before that retry and the retry replays revision 3.
    await delay(mongodbUrl ? WRITE_CONFLICT_RETRY_DELAY_MS.min / 5 : 200)
    await payload.db.commitTransaction(host.transactionID as number | string)
    const replay = await older
    expect(replay?.revision).toBe(3)
    const [stored] = await eventsByKey('locked-revision')
    expect(stored.revision).toBe(3)
    const rows = await deliveriesFor(stored.id)
    expect(rows.filter((row) => row.revision === 2)).toEqual([])
    expect(rows.some((row) => row.revision === 3 && row.status === 'pending')).toBe(true)
  })

  it.runIf(!isSqlite)(
    'records in two open host transactions concurrently without waiting',
    async () => {
      const [first, second] = [await hostRequest(), await hostRequest()]
      const both = Promise.all([
        recordConversion({ draft: lead('concurrent-a'), payload, req: first }),
        recordConversion({ draft: lead('concurrent-b'), payload, req: second }),
      ])
      const results = await Promise.race([
        both,
        delay(10_000).then(() => {
          throw new Error('concurrent recordings waited on each other')
        }),
      ])
      expect(results.map((event) => event?.eventKey)).toEqual(['concurrent-a', 'concurrent-b'])
      await payload.db.commitTransaction(first.transactionID as number | string)
      await payload.db.commitTransaction(second.transactionID as number | string)
      expect(await eventsByKey('concurrent-a')).toHaveLength(1)
      expect(await eventsByKey('concurrent-b')).toHaveLength(1)
    },
  )

  it('keeps one purchase per transaction when recordings under different eventKeys race', async () => {
    const warnLog = vi.spyOn(payload.logger, 'warn').mockImplementation(() => undefined)
    for (let index = 0; index < 5; index++) {
      const order = `race-order-${index}`
      const [webhook, thanks] = await Promise.all([
        recordConversion({ draft: purchase(`webhook:${order}`, order), payload }),
        recordConversion({ draft: purchase(`thanks:${order}`, order), payload }),
      ])
      expect(webhook?.id).toBeDefined()
      expect(thanks?.id).toBe(webhook?.id)
      const { docs } = await payload.find({
        collection: EVENTS_SLUG as never,
        depth: 0,
        overrideAccess: true,
        where: { transactionId: { equals: order } },
      })
      expect(docs).toHaveLength(1)
      const rows = await deliveriesFor(docs[0].id)
      expect(new Set(rows.map((row) => row.destination)).size).toBe(rows.length)
    }
    warnLog.mockRestore()
  })

  it('leaves no purchase claim behind when a host transaction records nothing', async () => {
    const warnLog = vi.spyOn(payload.logger, 'warn').mockImplementation(() => undefined)
    const order = 'claim-invalid-identity'
    const host = await hostRequest()
    const skipped = await recordConversion({
      draft: { ...purchase(`webhook:${order}`, order), customerId: 'invalid-user-id' },
      payload,
      req: host,
    })
    expect(skipped).toBeNull()
    await payload.db.commitTransaction(host.transactionID as number | string)
    const recorded = await recordConversion({ draft: purchase(`thanks:${order}`, order), payload })
    expect(recorded?.eventKey).toBe(`thanks:${order}`)
    warnLog.mockRestore()
  })

  it('names an orphan purchase claim instead of failing on a bare constraint error', async () => {
    const order = 'claim-orphan'
    await payload.db.create({
      collection: 'conversion-delivery-claims',
      data: { key: `purchase:${order}` },
    })
    const failure = await recordConversion({
      draft: purchase(`webhook:${order}`, order),
      payload,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(PluginError)
    expect(String((failure as Error).message)).toContain(`purchase:${order}`)
  })

  // Postgres READ COMMITTED gives each statement a fresh snapshot, so a host transaction whose
  // purchase lookup ran before a racing recording committed later sees that recording's claim.
  it.runIf(postgresUrl)(
    'returns the racing purchase when its claim and event commit after the host lookup',
    async () => {
      const warnLog = vi.spyOn(payload.logger, 'warn').mockImplementation(() => undefined)
      const order = 'claim-race-after-lookup'
      let open = (): void => undefined
      const entered = new Promise<void>((resolve) => {
        gate.entered = resolve
      })
      gate.opened = new Promise<void>((resolve) => {
        open = resolve
      })
      const host = await hostRequest()
      const loser = recordConversion({
        draft: { ...purchase(`webhook:${order}`, order), customerId: 'gated' },
        payload,
        req: host,
      }).then(
        (event) => ({ event }),
        (error: unknown) => ({ error }),
      )
      await entered
      const winner = await recordConversion({ draft: purchase(`thanks:${order}`, order), payload })
      expect(winner?.eventKey).toBe(`thanks:${order}`)
      open()
      const outcome = await loser
      await payload.db.commitTransaction(host.transactionID as number | string)
      expect(outcome).toEqual({ event: expect.objectContaining({ id: winner?.id }) })
      const { totalDocs } = await payload.count({
        collection: EVENTS_SLUG as never,
        overrideAccess: true,
        where: { transactionId: { equals: order } },
      })
      expect(totalDocs).toBe(1)
      gate.opened = Promise.resolve()
      warnLog.mockRestore()
    },
  )
})
