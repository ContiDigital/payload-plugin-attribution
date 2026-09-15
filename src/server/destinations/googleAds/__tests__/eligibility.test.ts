import { describe, expect, it } from 'vitest'

import type { ConversionEventDoc } from '../../../../types/index.js'

import { googleAdsEligibility } from '../eligibility.js'

const now = new Date('2026-09-14T12:00:00.000Z')

const event = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 1,
  name: 'purchase',
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: now.toISOString(),
  eventKey: 'purchase:order-1',
  occurredAt: now.toISOString(),
  revision: 1,
  transactionId: 'order-1',
  updatedAt: now.toISOString(),
  ...overrides,
})

describe('googleAdsEligibility', () => {
  it('is eligible on a click id within the 90 day window (click only)', () => {
    const result = googleAdsEligibility(
      event({ attribution: { clickCapturedAt: now.toISOString(), gclid: 'gclid-1' } }),
      now,
    )
    expect(result).toStrictEqual({ eligible: true, match: 'click' })
  })

  it('is eligible on hashed email/phone within 63 days of now (user data only)', () => {
    const result = googleAdsEligibility(
      event({ identifiers: { google: { emailSha256: 'e'.repeat(64) } } }),
      now,
    )
    expect(result).toStrictEqual({ eligible: true, match: 'user_data' })
  })

  it('is eligible with both a click id and user data', () => {
    const result = googleAdsEligibility(
      event({
        attribution: { clickCapturedAt: now.toISOString(), gclid: 'gclid-1' },
        identifiers: { google: { phoneSha256: 'p'.repeat(64) } },
      }),
      now,
    )
    expect(result).toStrictEqual({ eligible: true, match: 'both' })
  })

  it('is ineligible when the click id is 91 days old and there is no user data', () => {
    const clickCapturedAt = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000).toISOString()
    const result = googleAdsEligibility(
      event({ attribution: { clickCapturedAt, gclid: 'gclid-1' } }),
      now,
    )
    expect(result).toStrictEqual({ eligible: false, reason: 'click_window_closed' })
  })

  it('is eligible when the click id is exactly 90 days old', () => {
    const clickCapturedAt = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()
    const result = googleAdsEligibility(
      event({ attribution: { clickCapturedAt, gclid: 'gclid-1' } }),
      now,
    )
    expect(result).toStrictEqual({ eligible: true, match: 'click' })
  })

  it('is ineligible with denied ad user data consent when only user data is present', () => {
    const result = googleAdsEligibility(
      event({
        consent: {
          adPersonalization: 'granted',
          adUserData: 'denied',
          analyticsStorage: 'granted',
        },
        identifiers: { google: { emailSha256: 'e'.repeat(64) } },
      }),
      now,
    )
    expect(result).toStrictEqual({ eligible: false, reason: 'consent_denied' })
  })

  it('remains eligible via the click id when ad user data consent is denied', () => {
    const result = googleAdsEligibility(
      event({
        attribution: { clickCapturedAt: now.toISOString(), gclid: 'gclid-1' },
        consent: {
          adPersonalization: 'granted',
          adUserData: 'denied',
          analyticsStorage: 'granted',
        },
        identifiers: { google: { emailSha256: 'e'.repeat(64) } },
      }),
      now,
    )
    expect(result).toStrictEqual({ eligible: true, match: 'click' })
  })

  it('is ineligible with no identifiers at all', () => {
    const result = googleAdsEligibility(event({}), now)
    expect(result).toStrictEqual({ eligible: false, reason: 'no_identifiers' })
  })

  it('is ineligible when the click id has no clickCapturedAt', () => {
    const result = googleAdsEligibility(event({ attribution: { gclid: 'gclid-1' } }), now)
    expect(result).toStrictEqual({ eligible: false, reason: 'click_window_closed' })
  })

  it('is ineligible when the user data event is 64 days old', () => {
    const occurredAt = new Date(now.getTime() - 64 * 24 * 60 * 60 * 1000).toISOString()
    const result = googleAdsEligibility(
      event({ identifiers: { google: { phoneSha256: 'p'.repeat(64) } }, occurredAt }),
      now,
    )
    expect(result).toStrictEqual({ eligible: false, reason: 'user_data_window_closed' })
  })

  it('tolerates up to 5 minutes of clock skew on the click window (clickCapturedAt after occurredAt)', () => {
    const clickCapturedAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString()
    const result = googleAdsEligibility(
      event({ attribution: { clickCapturedAt, gclid: 'gclid-1' } }),
      now,
    )
    expect(result).toStrictEqual({ eligible: true, match: 'click' })
  })

  it('does not tolerate more than 5 minutes of clock skew on the click window', () => {
    const clickCapturedAt = new Date(now.getTime() + 5 * 60 * 1000 + 1).toISOString()
    const result = googleAdsEligibility(
      event({ attribution: { clickCapturedAt, gclid: 'gclid-1' } }),
      now,
    )
    expect(result).toStrictEqual({ eligible: false, reason: 'click_window_closed' })
  })

  it('tolerates up to 5 minutes of clock skew on the user data window (occurredAt after now)', () => {
    const occurredAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString()
    const result = googleAdsEligibility(
      event({ identifiers: { google: { emailSha256: 'e'.repeat(64) } }, occurredAt }),
      now,
    )
    expect(result).toStrictEqual({ eligible: true, match: 'user_data' })
  })

  it('does not tolerate more than 5 minutes of clock skew on the user data window', () => {
    const occurredAt = new Date(now.getTime() + 5 * 60 * 1000 + 1).toISOString()
    const result = googleAdsEligibility(
      event({ identifiers: { google: { emailSha256: 'e'.repeat(64) } }, occurredAt }),
      now,
    )
    expect(result).toStrictEqual({ eligible: false, reason: 'user_data_window_closed' })
  })

  it('treats gbraid and wbraid as click ids', () => {
    expect(
      googleAdsEligibility(
        event({ attribution: { clickCapturedAt: now.toISOString(), gbraid: 'gbraid-1' } }),
        now,
      ),
    ).toStrictEqual({ eligible: true, match: 'click' })
    expect(
      googleAdsEligibility(
        event({ attribution: { clickCapturedAt: now.toISOString(), wbraid: 'wbraid-1' } }),
        now,
      ),
    ).toStrictEqual({ eligible: true, match: 'click' })
  })
})
