import type { BuyerIdentity } from './normalize.js'

import { isEmailShaped, normalizePhoneE164, presentString, sha256, splitName } from './normalize.js'

export type MetaIdentifiers = {
  country?: string
  ct?: string
  em?: string
  external_id?: string
  fn?: string
  ln?: string
  ph?: string
  st?: string
  zp?: string
}

// Meta's own docs specify trim + lowercase only for em. Unlike Google's Data
// Manager / GA4 rules, Meta does not strip gmail dots or '+' tags, so this
// reuses only the shared validity check, not normalizeEmail's gmail rule.
const normalizeEmailForMeta = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const email = value.replace(/\s+/g, '').toLowerCase()
  return isEmailShaped(email) ? email : undefined
}

export function metaIdentifiers(
  identity: BuyerIdentity,
  options?: { defaultCountry?: string },
): MetaIdentifiers {
  const result: MetaIdentifiers = {}

  const email = normalizeEmailForMeta(identity.email)
  if (email) {
    result.em = sha256(email)
  }

  const phone = normalizePhoneE164(identity.phone, options?.defaultCountry)
  if (phone) {
    // ph is digits only, including country code, with no leading '+'.
    result.ph = sha256(phone.slice(1))
  }

  const { firstName, lastName } = splitName(identity)
  if (firstName) {
    result.fn = sha256(firstName)
  }
  if (lastName) {
    result.ln = sha256(lastName)
  }

  const city = presentString(identity.city)
  if (city) {
    const ct = city.toLowerCase().replace(/[^\p{L}\p{M}]/gu, '')
    if (ct) {
      result.ct = sha256(ct)
    }
  }

  const region = presentString(identity.region)
  if (region && /^[A-Z]{2}$/i.test(region)) {
    result.st = sha256(region.toLowerCase())
  }

  const postalCode = presentString(identity.postalCode)
  if (postalCode) {
    const cleaned = postalCode.toLowerCase().replace(/[\s-]/g, '')
    const postalCountry = presentString(identity.country)?.toLowerCase()
    const zp = postalCountry === 'us' ? cleaned.slice(0, 5) : cleaned
    if (zp) {
      result.zp = sha256(zp)
    }
  }

  // Meta expects an ISO 3166-1 alpha-2 code; a hash of "usa" or a country name never matches.
  const country = presentString(identity.country)?.toLowerCase()
  if (country && /^[a-z]{2}$/.test(country)) {
    result.country = sha256(country)
  }

  const externalId = presentString(identity.externalId)
  if (externalId) {
    result.external_id = sha256(externalId.toLowerCase())
  }

  return result
}
