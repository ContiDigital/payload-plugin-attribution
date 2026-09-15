import type { ConversionEventDoc } from '../../../types/index.js'

import { ageMs, DAY_MS } from '../../../core/time.js'

const CLICK_WINDOW_MS = 90 * DAY_MS
const USER_DATA_WINDOW_MS = 63 * DAY_MS

type Eligibility =
  | {
      eligible: false
      reason:
        'click_window_closed' | 'consent_denied' | 'no_identifiers' | 'user_data_window_closed'
    }
  | { eligible: true; match: 'both' | 'click' | 'user_data' }

export function googleAdsEligibility(event: ConversionEventDoc, now: Date): Eligibility {
  const attribution = event.attribution
  const hasClickId = Boolean(attribution?.gclid || attribution?.gbraid || attribution?.wbraid)
  const occurredAtMs = Date.parse(event.occurredAt)
  const clickCapturedAtMs = attribution?.clickCapturedAt
    ? Date.parse(attribution.clickCapturedAt)
    : NaN
  const clickAgeMs = ageMs(clickCapturedAtMs, occurredAtMs)
  const clickEligible =
    hasClickId && Number.isFinite(clickAgeMs) && clickAgeMs >= 0 && clickAgeMs <= CLICK_WINDOW_MS

  const google = event.identifiers?.google
  const hasUserDataRaw = Boolean(google?.emailSha256 || google?.phoneSha256)
  const consentDenied = event.consent.adUserData === 'denied'
  const hasUserData = hasUserDataRaw && !consentDenied
  const userDataAgeMs = ageMs(occurredAtMs, now.getTime())
  const userDataEligible = hasUserData && userDataAgeMs >= 0 && userDataAgeMs <= USER_DATA_WINDOW_MS

  if (clickEligible && userDataEligible) {
    return { eligible: true, match: 'both' }
  }
  if (clickEligible) {
    return { eligible: true, match: 'click' }
  }
  if (userDataEligible) {
    return { eligible: true, match: 'user_data' }
  }

  if (!hasClickId && !hasUserDataRaw) {
    return { eligible: false, reason: 'no_identifiers' }
  }
  if (!hasClickId && hasUserDataRaw && consentDenied) {
    return { eligible: false, reason: 'consent_denied' }
  }
  if (hasClickId) {
    return { eligible: false, reason: 'click_window_closed' }
  }
  return { eligible: false, reason: 'user_data_window_closed' }
}

type FeedEligibility =
  | { clickId: string; eligible: true }
  | {
      eligible: false
      reason: 'feed_requires_click_id' | Extract<Eligibility, { eligible: false }>['reason']
    }

// The scheduled CSV feed has no user-data columns, so it needs an actual click id (a braid only
// when explicitly allowed); a user-data-only match is not enough for the feed.
export function googleAdsFeedEligibility(
  event: ConversionEventDoc,
  now: Date,
  allowBraids: boolean,
): FeedEligibility {
  const result = googleAdsEligibility(event, now)
  if (!result.eligible) {
    return { eligible: false, reason: result.reason }
  }
  const attribution = event.attribution
  const clickId =
    attribution?.gclid || (allowBraids ? attribution?.gbraid || attribution?.wbraid : undefined)
  if (!clickId || result.match === 'user_data') {
    return { eligible: false, reason: 'feed_requires_click_id' }
  }
  return { clickId, eligible: true }
}
