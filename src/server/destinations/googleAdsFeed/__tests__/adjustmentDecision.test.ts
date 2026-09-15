import { describe, expect, it } from 'vitest'

import type { ConversionEventDoc, DeliveryDoc, DeliveryStatus } from '../../../../types/index.js'

import { decideAdjustment } from '../adjustmentDecision.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = new Date('2026-09-14T12:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

const retraction: ConversionEventDoc = {
  id: 2,
  name: 'refund',
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: iso(now.getTime() - HOUR),
  eventKey: 'refund:order-1',
  googleAdsAction: 'sale',
  googleAdsKind: 'retraction',
  occurredAt: iso(now.getTime() - HOUR),
  revision: 1,
  transactionId: 'order-1',
  updatedAt: iso(now.getTime() - HOUR),
}

const original = (status: DeliveryStatus, extra: Partial<DeliveryDoc> = {}): DeliveryDoc => ({
  id: 1,
  attempt: 0,
  createdAt: iso(now.getTime() - 3 * DAY),
  destination: 'googleAds',
  event: 1,
  key: '1:googleAds:r1:s0',
  revision: 1,
  sequence: 0,
  status,
  updatedAt: iso(now.getTime() - 3 * DAY),
  ...extra,
})

describe('decideAdjustment', () => {
  it.each(['withheld', 'dead', 'superseded', 'eligible'] as const)(
    'treats a %s original that was once served as delivered',
    (status) => {
      expect(
        decideAdjustment({
          event: retraction,
          now,
          original: original(status, { firstServedAt: iso(now.getTime() - 2 * DAY) }),
          retracted: false,
        }),
      ).toStrictEqual({ kind: 'eligible' })
    },
  )

  it('withholds original_not_delivered for a withheld original that was never served', () => {
    expect(
      decideAdjustment({
        event: retraction,
        now,
        original: original('withheld'),
        retracted: false,
      }),
    ).toStrictEqual({ kind: 'withheld', reason: 'original_not_delivered' })
  })

  it('opens the window from sentAt for a sent original', () => {
    expect(
      decideAdjustment({
        event: retraction,
        now,
        original: original('sent', { sentAt: iso(now.getTime() - 2 * DAY) }),
        retracted: false,
      }),
    ).toStrictEqual({ kind: 'eligible' })
  })
})
