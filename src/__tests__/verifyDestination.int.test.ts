import type { Payload } from 'payload'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type {
  AttributionPluginOptions,
  ConversionEventDoc,
  DeliveryDoc,
  DeliveryStatus,
  Destination,
} from '../types/index.js'

import { DELIVERIES_SLUG, EVENTS_SLUG } from '../constants.js'
import { deliveryLookup } from '../server/deliveries/lookup.js'
import { verifyDestination } from '../server/verify/verifyDestination.js'
import {
  bootPayload,
  databaseName,
  destroyPayloads,
  recordingDispatcher,
} from './helpers/bootPayload.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Math.floor(Date.now() / 1000) * 1000
const iso = (ms: number): string => new Date(ms).toISOString()

const { dispatcher } = recordingDispatcher()

const options: AttributionPluginOptions = {
  destinations: {
    googleAds: {
      adjustments: { enabled: true },
      conversionActions: { lead: 'Business lead', sale: 'Business sale' },
      feed: { password: () => Promise.resolve('feed-password'), username: 'feed-user' },
      transport: 'feed',
    },
  },
  dispatcher,
  secret: 'verify-test-secret',
}

let payload: Payload

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

beforeAll(async () => {
  payload = await bootPayload({ label: 'verify_adjustment', options })
})

afterAll(async () => {
  await destroyPayloads()
})

// These cover the real googleAdsAdjustmentHandler decision (src/server/destinations/googleAdsFeed/handler.ts),
// exercised through verifyDestination's read-only DeliveryLookup, against a booted Payload: an
// event-only check (adjustmentNotApplicable alone) would wrongly report an adjustment as ready
// when a real delivery would withhold it or make it wait.
describe(`verifyDestination googleAdsAdjustment on ${databaseName}`, () => {
  it('withholds original_not_delivered when the original conversion was never delivered', async () => {
    const order = 'verify-adj-never-delivered'
    await createEvent({ eventKey: `purchase:${order}`, transactionId: order, valueCents: 20000 })
    // No googleAds delivery row is created for the purchase above: the lookup finds no original.
    const refund = await createEvent({
      name: 'refund',
      adjustedValueCents: 5000,
      eventKey: `refund:${order}`,
      googleAdsKind: 'restatement',
      transactionId: order,
      valueCents: 20000,
    })

    const result = await verifyDestination({
      destination: 'googleAdsAdjustment',
      eventId: refund.id,
      payload,
    })

    expect(result).toEqual({ details: { reason: 'original_not_delivered' }, ok: false })
  })

  it('returns the RESTATE row that would be served when the original is served and the window is open', async () => {
    const order = 'verify-adj-window-open'
    const purchase = await createEvent({
      eventKey: `purchase:${order}`,
      transactionId: order,
      valueCents: 20000,
    })
    await createDelivery(purchase, 'googleAds', 'served', { firstServedAt: iso(NOW - 2 * DAY) })
    const refund = await createEvent({
      name: 'refund',
      adjustedValueCents: 5000,
      eventKey: `refund:${order}`,
      googleAdsKind: 'restatement',
      transactionId: order,
      valueCents: 20000,
    })

    const result = await verifyDestination({
      destination: 'googleAdsAdjustment',
      eventId: refund.id,
      payload,
    })

    expect(result.ok).toBe(true)
    expect(result.details).toMatchObject({
      row: [order, 'Business sale', expect.any(String), 'RESTATE', '50.00', 'USD'],
    })
  })

  it('withholds adjustment_window_closed once the adjustment window has passed', async () => {
    const order = 'verify-adj-window-closed'
    const purchase = await createEvent({
      eventKey: `purchase:${order}`,
      transactionId: order,
      valueCents: 20000,
    })
    await createDelivery(purchase, 'googleAds', 'sent', { sentAt: iso(NOW - 60 * DAY) })
    const refund = await createEvent({
      name: 'refund',
      adjustedValueCents: 5000,
      eventKey: `refund:${order}`,
      googleAdsKind: 'restatement',
      transactionId: order,
      valueCents: 20000,
    })

    const result = await verifyDestination({
      destination: 'googleAdsAdjustment',
      eventId: refund.id,
      payload,
    })

    expect(result).toEqual({ details: { reason: 'adjustment_window_closed' }, ok: false })
  })

  it('withholds retracted when another retraction for the same order has already reached Google', async () => {
    const order = 'verify-adj-already-retracted'
    const purchase = await createEvent({
      eventKey: `purchase:${order}`,
      transactionId: order,
      valueCents: 20000,
    })
    await createDelivery(purchase, 'googleAds', 'served', { firstServedAt: iso(NOW - 2 * DAY) })
    const firstRetraction = await createEvent({
      name: 'refund',
      adjustedValueCents: null,
      eventKey: `refund:${order}:1`,
      googleAdsKind: 'retraction',
      transactionId: order,
      valueCents: null,
    })
    await createDelivery(firstRetraction, 'googleAdsAdjustment', 'sent', { sentAt: iso(NOW - DAY) })
    const secondRetraction = await createEvent({
      name: 'refund',
      adjustedValueCents: null,
      eventKey: `refund:${order}:2`,
      googleAdsKind: 'retraction',
      transactionId: order,
      valueCents: null,
    })

    const result = await verifyDestination({
      destination: 'googleAdsAdjustment',
      eventId: secondRetraction.id,
      payload,
    })

    expect(result).toEqual({ details: { reason: 'retracted' }, ok: false })
  })

  it('counts an original sent at revision 1 as delivered when its revision 2 row was withheld', async () => {
    const order = 'verify-adj-revision-withheld'
    const purchase = await createEvent({
      eventKey: `purchase:${order}`,
      revision: 2,
      transactionId: order,
      valueCents: 20000,
    })
    await createDelivery(purchase, 'googleAds', 'sent', { sentAt: iso(NOW - 3 * DAY) })
    await createDelivery(purchase, 'googleAds', 'withheld', {
      key: `${purchase.id}:googleAds:r2:s0`,
      reason: 'user_data_window_closed',
      revision: 2,
    })
    const refund = await createEvent({
      name: 'refund',
      adjustedValueCents: null,
      eventKey: `refund:${order}`,
      googleAdsKind: 'retraction',
      transactionId: order,
      valueCents: null,
    })

    const result = await verifyDestination({
      destination: 'googleAdsAdjustment',
      eventId: refund.id,
      payload,
    })

    expect(result.ok).toBe(true)
    expect(result.details).toMatchObject({
      row: [order, 'Business sale', expect.any(String), 'RETRACT', '', ''],
    })
    const original = await deliveryLookup(payload).originalConversion(refund)
    expect(original?.delivery).toMatchObject({ revision: 1, status: 'sent' })
  })

  it('counts a served original superseded by a withheld revision as delivered', async () => {
    const order = 'verify-adj-served-superseded'
    const purchase = await createEvent({
      eventKey: `purchase:${order}`,
      revision: 2,
      transactionId: order,
      valueCents: 20000,
    })
    await createDelivery(purchase, 'googleAds', 'superseded', {
      firstServedAt: iso(NOW - 3 * DAY),
      reason: 'revision_superseded',
    })
    await createDelivery(purchase, 'googleAds', 'withheld', {
      key: `${purchase.id}:googleAds:r2:s0`,
      reason: 'click_window_closed',
      revision: 2,
    })
    const restatement = await createEvent({
      name: 'refund',
      adjustedValueCents: 5000,
      eventKey: `refund:${order}`,
      googleAdsKind: 'restatement',
      transactionId: order,
      valueCents: 20000,
    })

    const result = await verifyDestination({
      destination: 'googleAdsAdjustment',
      eventId: restatement.id,
      payload,
    })

    expect(result.ok).toBe(true)
  })
})
