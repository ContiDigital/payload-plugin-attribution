import type { Payload } from 'payload'

import { setTimeout as delay } from 'node:timers/promises'
import { createLocalReq } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type {
  AttributionPluginOptions,
  ConversionEventDoc,
  DeliveryDoc,
  DeliveryStatus,
  Destination,
} from '../types/index.js'

import { DELIVERIES_SLUG, EVENTS_SLUG } from '../constants.js'
import { getPluginContext } from '../plugin/getPluginContext.js'
import { runDelivery } from '../server/deliveries/runDelivery.js'
import { recordConversion } from '../server/record/recordConversion.js'
import { currentTransactionReq } from '../server/utilities/transaction.js'
import {
  bootPayload,
  databaseName,
  destroyPayloads,
  recordingDispatcher,
} from './helpers/bootPayload.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Math.floor(Date.now() / 1000) * 1000
const CONVERSION_ROWS = 1050

const { dispatcher } = recordingDispatcher()
const basic = (value: string): string => `Basic ${Buffer.from(value).toString('base64')}`
const goodAuth = basic('feed-user:feed-password')
const iso = (ms: number): string => new Date(ms).toISOString()
const googleTime = (ms: number): string => `${iso(ms).slice(0, 19).replace('T', ' ')}+0000`

const options: AttributionPluginOptions = {
  destinations: {
    googleAds: {
      adjustments: { enabled: true },
      conversionActions: { lead: 'Business lead', sale: 'Business sale' },
      feed: {
        lookbackDays: 30,
        password: () => Promise.resolve('feed-password'),
        username: 'feed-user',
      },
      transport: 'feed',
    },
  },
  dispatcher,
  secret: 'feed-test-secret',
}

let payload: Payload
let unconfigured: Payload

const pull = async (
  target: Payload,
  file: 'adjustments' | 'conversions',
  authorization?: string,
): Promise<Response> => {
  const endpoint = target.config.endpoints.find(
    (candidate) =>
      candidate.method === 'get' && candidate.path === `/attribution/google-ads/${file}.csv`,
  )
  if (!endpoint) {
    throw new Error(`${file} feed endpoint is not registered`)
  }
  const req = await createLocalReq({}, target)
  req.headers = new Headers(authorization ? { authorization } : {})
  return endpoint.handler(req)
}

const createEvent = async (
  data: Partial<ConversionEventDoc> & Pick<ConversionEventDoc, 'eventKey'>,
): Promise<ConversionEventDoc> =>
  (await payload.create({
    collection: EVENTS_SLUG as never,
    data: {
      name: 'purchase',
      consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
      currency: 'USD',
      googleAdsAction: 'sale',
      googleAdsKind: 'conversion',
      occurredAt: iso(NOW - 2 * DAY),
      revision: 1,
      ...data,
    } as never,
    depth: 0,
    overrideAccess: true,
  })) as unknown as ConversionEventDoc

const createDelivery = async (
  event: ConversionEventDoc,
  destination: Destination,
  status: DeliveryStatus,
  extra: Partial<DeliveryDoc> = {},
): Promise<DeliveryDoc> =>
  (await payload.create({
    collection: DELIVERIES_SLUG as never,
    data: {
      attempt: 0,
      destination,
      event: event.id,
      key: `${event.id}:${destination}:r1:s0`,
      revision: 1,
      sequence: 0,
      status,
      ...extra,
    } as never,
    depth: 0,
    overrideAccess: true,
  })) as unknown as DeliveryDoc

const readDelivery = async (id: number | string): Promise<DeliveryDoc> =>
  (await payload.findByID({
    id,
    collection: DELIVERIES_SLUG as never,
    depth: 0,
    overrideAccess: true,
  })) as unknown as DeliveryDoc

const dataLines = (body: string): string[] => body.split('\n').slice(2, -1)

const conversion = async (index: number, createdAt: string): Promise<DeliveryDoc> => {
  const order = `order-${String(index).padStart(4, '0')}`
  const event = await createEvent({
    attribution: { clickCapturedAt: iso(NOW - 3 * DAY), gclid: `gclid_${order}_abcdef` },
    eventKey: `purchase:${order}`,
    transactionId: order,
    valueCents: 10000 + index,
  })
  return createDelivery(event, 'googleAds', 'eligible', { createdAt })
}

beforeAll(async () => {
  payload = await bootPayload({ label: 'feed', options })
  unconfigured = await bootPayload({
    label: 'feed_unconfigured',
    options: { destinations: {}, dispatcher, secret: 'feed-test-secret' },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await destroyPayloads()
})

describe(`Google Ads feeds on ${databaseName}`, () => {
  it('answers 401 without authorization when the feed is not configured', async () => {
    for (const file of ['conversions', 'adjustments'] as const) {
      const anonymous = await pull(unconfigured, file)
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get('WWW-Authenticate')).toContain('Basic')
      expect((await pull(unconfigured, file, goodAuth)).status).toBe(401)
    }
  })

  it('answers 401 for a missing or wrong password', async () => {
    expect((await pull(payload, 'conversions')).status).toBe(401)
    const wrong = await pull(payload, 'conversions', basic('feed-user:wrong'))
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('WWW-Authenticate')).toContain('Basic')
  })

  it('serves every eligible row across pages in a deterministic order and writes only once', async () => {
    const base = NOW - HOUR
    const expected: string[] = []
    const created: DeliveryDoc[] = []
    for (let index = 0; index < CONVERSION_ROWS; index++) {
      // Rows share createdAt in groups of seven, so ties straddle the 500 row page boundary.
      created.push(await conversion(index, iso(base + Math.floor(index / 7))))
      expected.push(`order-${String(index).padStart(4, '0')}`)
    }
    expect(Date.parse(created[500].createdAt)).toBe(Date.parse(created[497].createdAt))

    const old = await createEvent({
      attribution: { clickCapturedAt: iso(NOW - 41 * DAY), gclid: 'gclid_outside_lookback' },
      eventKey: 'purchase:old',
      occurredAt: iso(NOW - 40 * DAY),
      transactionId: 'old',
    })
    await createDelivery(old, 'googleAds', 'eligible')
    for (const status of ['pending', 'withheld', 'sent'] as const) {
      const other = await createEvent({
        attribution: { clickCapturedAt: iso(NOW - 3 * DAY), gclid: `gclid_status_${status}` },
        eventKey: `purchase:${status}`,
        transactionId: status,
      })
      await createDelivery(other, 'googleAds', status)
    }
    const staleClick = await createEvent({
      attribution: { clickCapturedAt: iso(NOW - 100 * DAY), gclid: 'gclid_stale_click_1' },
      eventKey: 'purchase:stale-click',
      transactionId: 'stale-click',
    })
    const noAction = await createEvent({
      attribution: { clickCapturedAt: iso(NOW - 3 * DAY), gclid: 'gclid_no_action_1' },
      eventKey: 'purchase:no-action',
      googleAdsAction: 'none',
      transactionId: 'no-action',
    })
    const noOrder = await createEvent({
      attribution: { clickCapturedAt: iso(NOW - 3 * DAY), gclid: 'gclid_no_order_1' },
      eventKey: 'purchase:no-order',
    })
    const lapsed: DeliveryDoc[] = []
    for (const event of [staleClick, noAction, noOrder]) {
      lapsed.push(await createDelivery(event, 'googleAds', 'eligible'))
    }

    const first = await pull(payload, 'conversions', goodAuth)
    expect(first.status).toBe(200)
    expect(first.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(first.headers.get('Cache-Control')).toBe('no-store')
    expect(first.headers.get('X-Conversion-Rows')).toBe(String(CONVERSION_ROWS))
    const body = await first.text()
    const lines = dataLines(body)
    expect(lines.map((line) => line.split(',')[5])).toEqual(expected)
    expect(lines[1]).toBe(
      `gclid_order-0001_abcdef,Business sale,${googleTime(NOW - 2 * DAY)},100.01,USD,order-0001,Granted,Granted`,
    )

    const stamped = await Promise.all(
      [created[0], created[499], created[1049]].map((row) => readDelivery(row.id)),
    )
    for (const row of stamped) {
      expect(row.status).toBe('served')
      expect(row.firstServedAt).toBeTruthy()
      expect(row.lastServedAt).toBe(row.firstServedAt)
    }
    expect(
      (await Promise.all(lapsed.map((row) => readDelivery(row.id)))).map((row) => [
        row.status,
        row.reason,
      ]),
    ).toEqual([
      ['withheld', 'click_window_closed'],
      ['withheld', 'not_applicable'],
      ['withheld', 'not_applicable'],
    ])

    const update = vi.spyOn(payload, 'update')
    const insert = vi.spyOn(payload.db, 'create')
    const second = await pull(payload, 'conversions', goodAuth)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe(body)
    expect(update).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    expect((await readDelivery(created[0].id)).firstServedAt).toBe(stamped[0].firstServedAt)
  }, 600_000)

  it('lets recordConversion complete while the feed is being built', async () => {
    const find = payload.find.bind(payload)
    let recorded: 'timeout' | ConversionEventDoc | null | undefined
    let insideTransaction: boolean | undefined
    vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      if (
        recorded === undefined &&
        args.collection === EVENTS_SLUG &&
        args.where &&
        'id' in args.where
      ) {
        recorded = null
        insideTransaction = currentTransactionReq(payload) !== undefined
        recorded = await Promise.race([
          recordConversion({
            draft: {
              name: 'generate_lead',
              attribution: { gclid: 'gclid_concurrent_lead' },
              consent: { adUserData: 'granted' },
              eventKey: 'lead:concurrent',
              googleAds: { action: 'lead' },
              occurredAt: iso(NOW - HOUR),
              transactionId: 'concurrent',
            },
            payload,
          }),
          delay(20_000).then(() => 'timeout' as const),
        ])
      }
      return find(args as never) as never
    })

    const response = await pull(payload, 'conversions', goodAuth)
    expect(response.status).toBe(200)
    expect(insideTransaction).toBe(false)
    expect(recorded).not.toBe('timeout')
    expect(recorded).toMatchObject({ eventKey: 'lead:concurrent' })
  }, 120_000)

  it('serves open adjustments, withholds rows that no longer qualify, with batched lookups', async () => {
    const adjustmentTime = NOW - 12 * HOUR
    const adjustmentEvent = (order: string, overrides: Partial<ConversionEventDoc> = {}) =>
      createEvent({
        name: 'refund',
        adjustedValueCents: 5000,
        eventKey: `refund:${order}:${overrides.googleAdsKind ?? 'restatement'}`,
        googleAdsKind: 'restatement',
        occurredAt: iso(adjustmentTime),
        transactionId: order,
        valueCents: 20000,
        ...overrides,
      })
    const pair = async (
      order: string,
      original: { status: DeliveryStatus } & Partial<DeliveryDoc>,
      overrides: Partial<ConversionEventDoc> = {},
      adjustment: { status: DeliveryStatus } & Partial<DeliveryDoc> = { status: 'eligible' },
    ): Promise<DeliveryDoc> => {
      const purchase = await createEvent({
        eventKey: `purchase:${order}`,
        occurredAt: iso(NOW - 70 * DAY),
        transactionId: order,
        valueCents: 20000,
      })
      await createDelivery(purchase, 'googleAds', original.status, original)
      const refund = await adjustmentEvent(order, overrides)
      return createDelivery(refund, 'googleAdsAdjustment', adjustment.status, adjustment)
    }
    const retraction = { adjustedValueCents: null, googleAdsKind: 'retraction' as const }

    const restated = await pair('adj-a', { firstServedAt: iso(NOW - 2 * DAY), status: 'served' })
    const closed = await pair('adj-b', { sentAt: iso(NOW - 60 * DAY), status: 'sent' }, retraction)
    const retracted = await pair(
      'adj-c',
      { sentAt: iso(NOW - 3 * DAY), status: 'sent' },
      retraction,
    )
    const valueless = await pair(
      'adj-d',
      { sentAt: iso(NOW - 3 * DAY), status: 'sent' },
      { adjustedValueCents: null, valueCents: null },
    )
    const servedRetraction = await pair(
      'adj-e',
      { sentAt: iso(NOW - 3 * DAY), status: 'sent' },
      retraction,
      { firstServedAt: iso(NOW - DAY), lastServedAt: iso(NOW - DAY), status: 'served' },
    )
    const afterRetraction = await createDelivery(
      await adjustmentEvent('adj-e'),
      'googleAdsAdjustment',
      'eligible',
    )
    const noAction = await pair(
      'adj-f',
      { sentAt: iso(NOW - 3 * DAY), status: 'sent' },
      { googleAdsAction: 'none' },
    )

    const find = vi.spyOn(payload, 'find')
    const response = await pull(payload, 'adjustments', goodAuth)
    expect(response.status).toBe(200)
    // One page: deliveries, their events, then originals and retractions in two queries.
    expect(find).toHaveBeenCalledTimes(4)
    expect(response.headers.get('X-Conversion-Rows')).toBe('3')
    const body = await response.text()
    expect(body).toBe(
      'Parameters:TimeZone=UTC\n' +
        'Order ID,Conversion Name,Adjustment Time,Adjustment Type,Adjusted Value,Adjusted Value Currency\n' +
        `adj-a,Business sale,${googleTime(adjustmentTime)},RESTATE,50.00,USD\n` +
        `adj-c,Business sale,${googleTime(adjustmentTime)},RETRACT,,\n` +
        `adj-e,Business sale,${googleTime(adjustmentTime)},RETRACT,,\n`,
    )
    expect((await readDelivery(restated.id)).status).toBe('served')
    expect((await readDelivery(retracted.id)).status).toBe('served')
    expect((await readDelivery(servedRetraction.id)).firstServedAt).toBe(iso(NOW - DAY))
    const outcomes = await Promise.all(
      [closed, valueless, afterRetraction, noAction].map((row) => readDelivery(row.id)),
    )
    expect(outcomes.map((row) => [row.status, row.reason, row.firstServedAt ?? null])).toEqual([
      ['withheld', 'adjustment_window_closed', null],
      ['withheld', 'missing_value', null],
      ['withheld', 'retracted', null],
      ['withheld', 'not_applicable', null],
    ])

    find.mockClear()
    const update = vi.spyOn(payload, 'update')
    const insert = vi.spyOn(payload.db, 'create')
    const second = await pull(payload, 'adjustments', goodAuth)
    expect(await second.text()).toBe(body)
    expect(find).toHaveBeenCalledTimes(4)
    expect(update).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  }, 120_000)

  it('never withholds a served braid conversion after allowBraidsInFeed is turned off, and still retracts it', async () => {
    const googleAds = getPluginContext(payload).options.destinations.googleAds
    if (!googleAds) {
      throw new Error('googleAds is not configured')
    }
    const purchase = await createEvent({
      attribution: { clickCapturedAt: iso(NOW - 3 * DAY), gbraid: 'gbraid_braid_order_abcdef' },
      eventKey: 'purchase:braid-order',
      transactionId: 'braid-order',
      valueCents: 4200,
    })
    const original = await createDelivery(purchase, 'googleAds', 'eligible')

    googleAds.allowBraidsInFeed = true
    try {
      const first = await (await pull(payload, 'conversions', goodAuth)).text()
      expect(dataLines(first).some((line) => line.startsWith('gbraid_braid_order_abcdef,'))).toBe(
        true,
      )
    } finally {
      googleAds.allowBraidsInFeed = false
    }
    const served = await readDelivery(original.id)
    expect(served).toMatchObject({ status: 'served' })
    // Move the first serving back past the 24 hour adjustment opening delay.
    const servedAt = iso(NOW - 2 * DAY)
    await payload.update({
      id: original.id,
      collection: DELIVERIES_SLUG as never,
      data: { firstServedAt: servedAt, lastServedAt: servedAt } as never,
      depth: 0,
      overrideAccess: true,
    })

    const second = await pull(payload, 'conversions', goodAuth)
    expect(second.status).toBe(200)
    expect((await second.text()).includes('gbraid_braid_order_abcdef')).toBe(false)
    expect(await readDelivery(original.id)).toMatchObject({
      firstServedAt: servedAt,
      status: 'served',
    })

    const refundTime = NOW - HOUR
    const refund = await createDelivery(
      await createEvent({
        name: 'refund',
        adjustedValueCents: null,
        eventKey: 'refund:braid-order',
        googleAdsKind: 'retraction',
        occurredAt: iso(refundTime),
        transactionId: 'braid-order',
      }),
      'googleAdsAdjustment',
      'eligible',
    )
    const adjustments = await (await pull(payload, 'adjustments', goodAuth)).text()
    expect(dataLines(adjustments)).toContain(
      `braid-order,Business sale,${googleTime(refundTime)},RETRACT,,`,
    )
    expect(await readDelivery(refund.id)).toMatchObject({ status: 'served' })
  }, 120_000)

  it('withholds an adjustment for an order whose retraction already reached Google', async () => {
    await createDelivery(
      await createEvent({ eventKey: 'purchase:gone', transactionId: 'gone' }),
      'googleAds',
      'served',
      { firstServedAt: iso(NOW - 3 * DAY) },
    )
    await createDelivery(
      await createEvent({
        name: 'refund',
        eventKey: 'refund:gone:retraction',
        googleAdsKind: 'retraction',
        occurredAt: iso(NOW - 2 * DAY),
        transactionId: 'gone',
      }),
      'googleAdsAdjustment',
      'sent',
      { sentAt: iso(NOW - 2 * DAY) },
    )
    const restatement = await createDelivery(
      await createEvent({
        name: 'refund',
        adjustedValueCents: 100,
        eventKey: 'refund:gone:restatement',
        googleAdsKind: 'restatement',
        occurredAt: iso(NOW - HOUR),
        transactionId: 'gone',
      }),
      'googleAdsAdjustment',
      'pending',
    )
    expect(
      await runDelivery({ deliveryId: restatement.id, now: new Date(NOW), payload }),
    ).toMatchObject({ reason: 'retracted', status: 'withheld' })
  })

  it('withholds an adjustment whose original was never delivered instead of retrying it', async () => {
    const purchase = await createEvent({ eventKey: 'purchase:never', transactionId: 'never' })
    await createDelivery(purchase, 'googleAds', 'withheld', { reason: 'feed_requires_click_id' })
    const refund = await createEvent({
      name: 'refund',
      eventKey: 'refund:never',
      googleAdsKind: 'retraction',
      occurredAt: iso(NOW - HOUR),
      transactionId: 'never',
    })
    const adjustment = await createDelivery(refund, 'googleAdsAdjustment', 'pending')

    expect(
      await runDelivery({ deliveryId: adjustment.id, now: new Date(NOW), payload }),
    ).toMatchObject({
      reason: 'original_not_delivered',
      status: 'withheld',
    })
  })

  it('withholds an adjustment still waiting on its original at the seven day deadline', async () => {
    const originalCreatedAt = NOW - HOUR
    const deadline = originalCreatedAt + 7 * DAY
    const purchase = await createEvent({ eventKey: 'purchase:waiting', transactionId: 'waiting' })
    await createDelivery(purchase, 'googleAds', 'pending', { createdAt: iso(originalCreatedAt) })
    const refund = await createEvent({
      name: 'refund',
      eventKey: 'refund:waiting',
      googleAdsKind: 'retraction',
      occurredAt: iso(NOW - HOUR),
      transactionId: 'waiting',
    })
    const adjustment = await createDelivery(refund, 'googleAdsAdjustment', 'pending')

    const waited = await runDelivery({ deliveryId: adjustment.id, now: new Date(NOW), payload })
    expect(waited).toMatchObject({ reason: 'awaiting_original', status: 'retry' })
    expect(Date.parse(waited.nextAttemptAt ?? '')).toBe(NOW + 6 * HOUR)
    expect(Date.parse((await readDelivery(adjustment.id)).deadlineAt ?? '')).toBe(deadline)

    const late = await runDelivery({
      deliveryId: adjustment.id,
      now: new Date(deadline - HOUR),
      payload,
    })
    expect(late).toMatchObject({ reason: 'awaiting_original', status: 'retry' })
    expect(Date.parse(late.nextAttemptAt ?? '')).toBe(deadline)

    expect(
      await runDelivery({ deliveryId: adjustment.id, now: new Date(deadline), payload }),
    ).toMatchObject({
      reason: 'deadline_passed',
      status: 'withheld',
    })
    expect(await readDelivery(adjustment.id)).toMatchObject({ attempt: 0, status: 'withheld' })
  })
})
