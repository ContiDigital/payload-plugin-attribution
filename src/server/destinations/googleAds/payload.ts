import type { ConsentState, ConversionEventDoc, GoogleIdentifiers } from '../../../types/index.js'

import { DEFAULT_CURRENCY } from '../../../constants.js'
import { toMajorUnits } from '../../../core/money.js'

const CONSENT_VALUE: Record<ConsentState, string | undefined> = {
  denied: 'CONSENT_DENIED',
  granted: 'CONSENT_GRANTED',
  unknown: undefined,
}

function buildConsent(consent: ConversionEventDoc['consent']): Record<string, string> | undefined {
  const adUserData = CONSENT_VALUE[consent.adUserData]
  const adPersonalization = CONSENT_VALUE[consent.adPersonalization]
  if (!adUserData && !adPersonalization) {
    return undefined
  }
  return {
    ...(adUserData ? { adUserData } : {}),
    ...(adPersonalization ? { adPersonalization } : {}),
  }
}

// Data Manager rejects an event carrying more than one click id.
function buildAdIdentifiers(
  attribution: ConversionEventDoc['attribution'],
): Record<string, string> | undefined {
  if (attribution?.gclid) {
    return { gclid: attribution.gclid }
  }
  if (attribution?.gbraid) {
    return { gbraid: attribution.gbraid }
  }
  return attribution?.wbraid ? { wbraid: attribution.wbraid } : undefined
}

// Data Manager's address identifier needs all four fields, and its regionCode is the ISO 3166-1
// alpha-2 country, not the state or province.
function buildAddress(google: GoogleIdentifiers): Record<string, string> | undefined {
  const regionCode = google.country?.toUpperCase()
  if (
    !google.firstNameSha256 ||
    !google.lastNameSha256 ||
    !google.postalCode ||
    !regionCode ||
    !/^[A-Z]{2}$/.test(regionCode)
  ) {
    return undefined
  }
  return {
    familyName: google.lastNameSha256,
    givenName: google.firstNameSha256,
    postalCode: google.postalCode,
    regionCode,
  }
}

// Consent-denied ad user data removes user identifiers entirely, matching the eligibility rule.
function buildUserIdentifiers(
  google: GoogleIdentifiers | undefined,
  adUserDataConsent: ConsentState,
): Record<string, unknown>[] | undefined {
  if (!google || adUserDataConsent === 'denied') {
    return undefined
  }
  const identifiers: Record<string, unknown>[] = []
  if (google.emailSha256) {
    identifiers.push({ emailAddress: google.emailSha256 })
  }
  if (google.phoneSha256) {
    identifiers.push({ phoneNumber: google.phoneSha256 })
  }
  const address = buildAddress(google)
  if (address) {
    identifiers.push({ address })
  }
  return identifiers.length ? identifiers : undefined
}

export function buildIngestRequest(
  event: ConversionEventDoc,
  options: {
    conversionActionId: string
    loginAccountId?: string
    /** The eligibility match driving this send: drops the side that did not qualify (for example a stale click id once only user data is within its window, or vice versa). Omit to include whatever identifiers are present. */
    match?: 'both' | 'click' | 'user_data'
    operatingAccountId: string
    validateOnly?: boolean
  },
): Record<string, unknown> {
  const currency = event.currency ?? DEFAULT_CURRENCY
  const hasValue = event.valueCents !== undefined && event.valueCents !== null
  const adIdentifiers =
    options.match !== 'user_data' ? buildAdIdentifiers(event.attribution) : undefined
  const userIdentifiers =
    options.match !== 'click'
      ? buildUserIdentifiers(event.identifiers?.google, event.consent.adUserData)
      : undefined
  const consent = buildConsent(event.consent)

  const eventBody = {
    eventSource: event.eventSource ?? 'WEB',
    eventTimestamp: event.occurredAt,
    transactionId: event.transactionId || event.eventKey,
    ...(hasValue
      ? { conversionValue: toMajorUnits(event.valueCents as number, currency), currency }
      : {}),
    ...(adIdentifiers ? { adIdentifiers } : {}),
    ...(userIdentifiers ? { userData: { userIdentifiers } } : {}),
  }

  return {
    destinations: [
      {
        operatingAccount: { accountId: options.operatingAccountId, accountType: 'GOOGLE_ADS' },
        ...(options.loginAccountId
          ? { loginAccount: { accountId: options.loginAccountId, accountType: 'GOOGLE_ADS' } }
          : {}),
        productDestinationId: options.conversionActionId,
      },
    ],
    encoding: 'HEX',
    ...(consent ? { consent } : {}),
    events: [eventBody],
    validateOnly: options.validateOnly ?? false,
  }
}
