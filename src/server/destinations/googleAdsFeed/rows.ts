import type { ConsentState, ConversionEventDoc } from '../../../types/index.js'

import { DEFAULT_CURRENCY } from '../../../constants.js'
import { googleAdsFeedEligibility } from '../googleAds/eligibility.js'
import { adjustmentNotApplicable } from './adjustmentDecision.js'
import { formatMinorUnits, googleTime } from './csv.js'

type ConversionNames = { lead: string; sale: string }

const consentLabel = (state: ConsentState): string =>
  state === 'granted' ? 'Granted' : state === 'denied' ? 'Denied' : ''

const conversionName = (event: ConversionEventDoc, names: ConversionNames): string | undefined =>
  event.googleAdsAction === 'lead' || event.googleAdsAction === 'sale'
    ? names[event.googleAdsAction]
    : undefined

const currencyOf = (event: ConversionEventDoc): string => event.currency || DEFAULT_CURRENCY

export const conversionNotApplicable = (event: ConversionEventDoc): boolean =>
  event.googleAdsKind !== 'conversion' ||
  (event.googleAdsAction !== 'lead' && event.googleAdsAction !== 'sale') ||
  !event.transactionId

export function conversionRow(
  event: ConversionEventDoc,
  names: ConversionNames,
  options: { allowBraids?: boolean; now?: Date } = {},
): null | string[] {
  const name = conversionName(event, names)
  if (conversionNotApplicable(event) || !name || !event.transactionId) {
    return null
  }
  const feed = googleAdsFeedEligibility(
    event,
    options.now ?? new Date(),
    options.allowBraids === true,
  )
  if (!feed.eligible) {
    return null
  }
  const currency = currencyOf(event)
  return [
    feed.clickId,
    name,
    googleTime(event.occurredAt),
    // A blank value lets Google apply the conversion action's default value.
    typeof event.valueCents === 'number' ? formatMinorUnits(event.valueCents, currency) : '',
    currency,
    event.transactionId,
    consentLabel(event.consent.adUserData),
    consentLabel(event.consent.adPersonalization),
  ]
}

// Google rejects an adjusted value on a retraction, so both value columns stay blank.
export function adjustmentRow(event: ConversionEventDoc, names: ConversionNames): null | string[] {
  const name = conversionName(event, names)
  if (adjustmentNotApplicable(event) || !name || !event.transactionId) {
    return null
  }
  const retraction = event.googleAdsKind === 'retraction'
  const currency = currencyOf(event)
  const value = event.adjustedValueCents ?? event.valueCents ?? 0
  return [
    event.transactionId,
    name,
    googleTime(event.occurredAt),
    retraction ? 'RETRACT' : 'RESTATE',
    retraction ? '' : formatMinorUnits(value, currency),
    retraction ? '' : currency,
  ]
}
