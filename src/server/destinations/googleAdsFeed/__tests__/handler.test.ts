import { describe, expect, it, vi } from 'vitest'

import type {
  ConversionEventDoc,
  DeliveryDoc,
  DeliveryLookup,
  DeliveryStatus,
  GoogleAdsDestinationOptions,
  NormalizedOptions,
} from '../../../../types/index.js'

import { normalizeOptions } from '../../../../plugin/normalizeOptions.js'
import { SettingUnavailableError } from '../../../utilities/errors.js'
import { googleAdsAdjustmentHandler } from '../handler.js'

const now = new Date('2026-09-14T12:00:00.000Z')
const HOUR = 3_600_000
const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString()

const googleAds = (
  overrides: Partial<GoogleAdsDestinationOptions> = {},
): GoogleAdsDestinationOptions => ({
  adjustments: { enabled: true },
  conversionActions: { lead: 'Business lead', sale: 'Business sale' },
  feed: { password: 'feed-password', username: 'feed-user' },
  transport: 'feed',
  ...overrides,
})

const optionsWith = (
  overrides: Partial<GoogleAdsDestinationOptions> = {},
  present = true,
): NormalizedOptions =>
  normalizeOptions({
    destinations: present ? { googleAds: googleAds(overrides) } : {},
    secret: 'plugin-secret',
  })

const adjustment = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 2,
  name: 'refund',
  adjustedValueCents: 5000,
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: now.toISOString(),
  currency: 'USD',
  eventKey: 'refund:order-1',
  googleAdsAction: 'sale',
  googleAdsKind: 'restatement',
  occurredAt: now.toISOString(),
  revision: 1,
  transactionId: 'order-1',
  updatedAt: now.toISOString(),
  ...overrides,
})

const original = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc =>
  adjustment({
    id: 1,
    name: 'purchase',
    adjustedValueCents: null,
    eventKey: 'purchase:order-1',
    googleAdsKind: 'conversion',
    ...overrides,
  })

const delivery = (overrides: Partial<DeliveryDoc> = {}): DeliveryDoc => ({
  id: 10,
  attempt: 0,
  createdAt: '2026-09-10T00:00:00.000Z',
  destination: 'googleAds',
  event: 1,
  key: '1:googleAds:r1:s0',
  revision: 1,
  sequence: 0,
  status: 'sent',
  updatedAt: now.toISOString(),
  ...overrides,
})

const deliver = (args: {
  event?: ConversionEventDoc
  found?: Awaited<ReturnType<DeliveryLookup['originalConversion']>>
  options?: NormalizedOptions
  retracted?: boolean
}) => {
  const originalConversion = vi.fn<DeliveryLookup['originalConversion']>(() =>
    Promise.resolve(args.found === undefined ? null : args.found),
  )
  const retracted = vi.fn<DeliveryLookup['retracted']>(() =>
    Promise.resolve(args.retracted === true),
  )
  const outcome = googleAdsAdjustmentHandler.deliver({
    delivery: delivery({ id: 20, destination: 'googleAdsAdjustment', event: 2, status: 'sending' }),
    event: args.event ?? adjustment(),
    lookup: { originalConversion, retracted },
    now,
    options: args.options ?? optionsWith(),
    payload: {} as never,
    signal: new AbortController().signal,
  })
  return { originalConversion, outcome, retracted }
}

const withOriginal = (overrides: Partial<DeliveryDoc>) => ({
  delivery: delivery(overrides),
  event: original(),
})

const awaitingOriginal = {
  deadlineAt: '2026-09-17T00:00:00.000Z',
  kind: 'wait',
  reason: 'awaiting_original',
  until: '2026-09-14T18:00:00.000Z',
}

describe('googleAdsAdjustmentHandler', () => {
  it('is registered for the googleAdsAdjustment destination', () => {
    expect(googleAdsAdjustmentHandler.destination).toBe('googleAdsAdjustment')
  })

  it('withholds retracted when a retraction for the order already reached Google', async () => {
    const { originalConversion, outcome, retracted } = deliver({
      found: withOriginal({ sentAt: ago(25 * HOUR), status: 'sent' }),
      retracted: true,
    })
    expect(await outcome).toEqual({ kind: 'withheld', reason: 'retracted' })
    expect(originalConversion).toHaveBeenCalledWith(adjustment())
    expect(retracted).toHaveBeenCalledWith(adjustment())
  })

  it('withholds retracted before waiting for the adjustment window', async () => {
    expect(
      await deliver({
        found: withOriginal({ sentAt: ago(23 * HOUR), status: 'sent' }),
        retracted: true,
      }).outcome,
    ).toEqual({ kind: 'withheld', reason: 'retracted' })
  })

  it('withholds missing_value for a restatement with no value, without a lookup', async () => {
    const { originalConversion, outcome } = deliver({
      event: adjustment({ adjustedValueCents: null, valueCents: null }),
      found: withOriginal({ sentAt: ago(25 * HOUR), status: 'sent' }),
    })
    expect(await outcome).toEqual({ kind: 'withheld', reason: 'missing_value' })
    expect(originalConversion).not.toHaveBeenCalled()
  })

  it('withholds original_not_delivered when there is no original conversion', async () => {
    const { originalConversion, outcome } = deliver({ found: null })
    expect(await outcome).toEqual({ kind: 'withheld', reason: 'original_not_delivered' })
    expect(originalConversion).toHaveBeenCalledWith(adjustment())
  })

  it('withholds original_not_delivered when the original has no Google Ads delivery', async () => {
    expect(await deliver({ found: { delivery: null, event: original() } }).outcome).toEqual({
      kind: 'withheld',
      reason: 'original_not_delivered',
    })
  })

  it.each<DeliveryStatus>(['withheld', 'dead', 'superseded'])(
    'withholds original_not_delivered, terminally, when the original delivery is %s',
    async (status) => {
      expect(await deliver({ found: withOriginal({ status }) }).outcome).toEqual({
        kind: 'withheld',
        reason: 'original_not_delivered',
      })
    },
  )

  it.each<DeliveryStatus>(['pending', 'retry', 'sending', 'eligible'])(
    'waits six hours, until seven days after the original delivery was created, when it is %s',
    async (status) => {
      expect(await deliver({ found: withOriginal({ status }) }).outcome).toEqual(awaitingOriginal)
    },
  )

  it('waits for an original served row that has no first serving time', async () => {
    expect(
      await deliver({ found: withOriginal({ firstServedAt: null, status: 'served' }) }).outcome,
    ).toEqual(awaitingOriginal)
  })

  it('waits until 24 hours after a sent original, closing 54 days after it', async () => {
    const sentAt = ago(23 * HOUR)
    expect(await deliver({ found: withOriginal({ sentAt, status: 'sent' }) }).outcome).toEqual({
      deadlineAt: '2026-11-06T13:00:00.000Z',
      kind: 'wait',
      reason: 'adjustment_window_pending',
      until: '2026-09-14T13:00:00.000Z',
    })
  })

  it('is eligible 25 hours after a sent original', async () => {
    expect(
      await deliver({ found: withOriginal({ sentAt: ago(25 * HOUR), status: 'sent' }) }).outcome,
    ).toEqual({ kind: 'eligible' })
  })

  it('times a served original from its first serving, not sentAt', async () => {
    expect(
      await deliver({
        found: withOriginal({
          firstServedAt: ago(25 * HOUR),
          sentAt: ago(23 * HOUR),
          status: 'served',
        }),
      }).outcome,
    ).toEqual({ kind: 'eligible' })
    expect(
      await deliver({
        found: withOriginal({
          firstServedAt: ago(23 * HOUR),
          sentAt: ago(30 * 24 * HOUR),
          status: 'served',
        }),
      }).outcome,
    ).toMatchObject({ kind: 'wait', reason: 'adjustment_window_pending' })
  })

  it('withholds adjustment_window_closed 55 days after the original was delivered', async () => {
    expect(
      await deliver({ found: withOriginal({ sentAt: ago(55 * 24 * HOUR), status: 'sent' }) })
        .outcome,
    ).toEqual({ kind: 'withheld', reason: 'adjustment_window_closed' })
  })

  it('treats a retraction like a restatement', async () => {
    expect(
      await deliver({
        event: adjustment({ adjustedValueCents: null, googleAdsKind: 'retraction' }),
        found: withOriginal({ sentAt: ago(25 * HOUR), status: 'sent' }),
      }).outcome,
    ).toEqual({ kind: 'eligible' })
  })

  it.each([
    ['Google Ads is not configured', optionsWith({}, false)],
    ['Google Ads is disabled', optionsWith({ enabled: false })],
    ['adjustments are disabled', optionsWith({ adjustments: { enabled: false } })],
    [
      'the feed username setting resolves empty',
      optionsWith({ feed: { password: 'feed-password', username: () => Promise.resolve('') } }),
    ],
  ])('withholds not_configured when %s, without a lookup', async (_label, options) => {
    const { originalConversion, outcome } = deliver({
      found: withOriginal({ sentAt: ago(25 * HOUR) }),
      options,
    })
    expect(await outcome).toEqual({ kind: 'withheld', reason: 'not_configured' })
    expect(originalConversion).not.toHaveBeenCalled()
  })

  it('raises SettingUnavailableError without a lookup when the feed password setting throws', async () => {
    const { originalConversion, outcome } = deliver({
      found: withOriginal({ sentAt: ago(25 * HOUR) }),
      options: optionsWith({
        feed: {
          password: () => {
            throw new Error('secret store unavailable')
          },
          username: 'feed-user',
        },
      }),
    })
    await expect(outcome).rejects.toBeInstanceOf(SettingUnavailableError)
    expect(originalConversion).not.toHaveBeenCalled()
  })

  it.each([
    ['a conversion', { googleAdsKind: 'conversion' as const }],
    ['no Google Ads action', { googleAdsAction: 'none' as const }],
    ['no transaction id', { transactionId: null }],
  ])('withholds not_applicable for %s', async (_label, overrides) => {
    const { originalConversion, outcome } = deliver({ event: adjustment(overrides) })
    expect(await outcome).toEqual({ kind: 'withheld', reason: 'not_applicable' })
    expect(originalConversion).not.toHaveBeenCalled()
  })
})
