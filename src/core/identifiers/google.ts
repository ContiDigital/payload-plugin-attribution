import type { BuyerIdentity } from './normalize.js'

import {
  normalizeEmail,
  normalizePhoneE164,
  presentString,
  sha256,
  splitName,
} from './normalize.js'

export type GoogleIdentifiers = {
  city?: string
  country?: string
  emailSha256?: string
  firstNameSha256?: string
  lastNameSha256?: string
  phoneSha256?: string
  postalCode?: string
  region?: string
  streetSha256?: string
}

export function googleIdentifiers(
  identity: BuyerIdentity,
  options?: { defaultCountry?: string },
): GoogleIdentifiers {
  const result: GoogleIdentifiers = {}

  const email = normalizeEmail(identity.email)
  if (email) {
    result.emailSha256 = sha256(email)
  }

  const phone = normalizePhoneE164(identity.phone, options?.defaultCountry)
  if (phone) {
    result.phoneSha256 = sha256(phone)
  }

  const { firstName, lastName } = splitName(identity)
  if (firstName) {
    result.firstNameSha256 = sha256(firstName)
  }
  if (lastName) {
    result.lastNameSha256 = sha256(lastName)
  }

  const street = presentString(identity.street)
  if (street) {
    result.streetSha256 = sha256(street.toLowerCase().replace(/\s+/g, ' '))
  }

  const city = presentString(identity.city)
  if (city) {
    result.city = city
  }
  const region = presentString(identity.region)
  if (region) {
    result.region = region
  }
  // Google's docs list postal_code as plain, unhashed user data: passed through as given.
  const postalCode = presentString(identity.postalCode)
  if (postalCode) {
    result.postalCode = postalCode
  }
  const country = presentString(identity.country)
  if (country) {
    result.country = country.toUpperCase()
  }

  return result
}
