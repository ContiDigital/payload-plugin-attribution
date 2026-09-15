import { createHash } from 'node:crypto'

export const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

export function presentString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

export type BuyerIdentity = {
  city?: null | string
  country?: null | string
  email?: null | string
  externalId?: null | string
  firstName?: null | string
  lastName?: null | string
  name?: null | string
  phone?: null | string
  postalCode?: null | string
  region?: null | string
  street?: null | string
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

export function isEmailShaped(value: string): boolean {
  return EMAIL_PATTERN.test(value)
}

export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const email = value.replace(/\s+/g, '').toLowerCase()
  if (!isEmailShaped(email)) {
    return undefined
  }
  const [local, domain] = email.split('@')
  if (!GMAIL_DOMAINS.has(domain)) {
    return email
  }
  const stripped = local.split('+')[0].replaceAll('.', '')
  return stripped ? `${stripped}@${domain}` : undefined
}

const PHONE_JUNK = /[\s().-]/g
const E164_PATTERN = /^\+[1-9]\d{7,14}$/
const NANP_DEFAULT_COUNTRIES = new Set(['CA', 'US'])

// No libphonenumber dependency: only NANP (US/CA) default-country dialing is
// supported for numbers without a leading '+'. Other default countries are a
// documented limitation and return undefined.
export function normalizePhoneE164(value: unknown, defaultCountry?: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const cleaned = value.replace(PHONE_JUNK, '')
  if (cleaned.startsWith('+')) {
    return E164_PATTERN.test(cleaned) ? cleaned : undefined
  }
  if (!defaultCountry || !NANP_DEFAULT_COUNTRIES.has(defaultCountry)) {
    return undefined
  }
  const digits = cleaned.replace(/\D/g, '')
  if (digits.length === 10) {
    return `+1${digits}`
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1${digits.slice(1)}`
  }
  return undefined
}

const NAME_PREFIXES = /^(?:mr|mrs|ms|miss|dr|prof)\.?\s+/i
const NAME_SUFFIXES = /\s+(?:jr|sr|ii|iii|iv)\.?$/i
const NON_LETTER = /[^\p{L}\p{M}]/gu
const NON_LETTER_OR_SPACE = /[^\p{L}\p{M}\s]/gu

const cleanNamePart = (value: string): string | undefined => {
  const cleaned = value.toLowerCase().replace(NON_LETTER_OR_SPACE, '').replace(/\s+/g, ' ').trim()
  return cleaned || undefined
}

export function splitName(identity: BuyerIdentity): { firstName?: string; lastName?: string } {
  if (identity.firstName || identity.lastName) {
    return {
      firstName: cleanNamePart(identity.firstName ?? ''),
      lastName: cleanNamePart(identity.lastName ?? ''),
    }
  }
  if (typeof identity.name !== 'string') {
    return {}
  }
  const withoutAffixes = identity.name
    .toLowerCase()
    .trim()
    .replace(NAME_PREFIXES, '')
    .replace(NAME_SUFFIXES, '')
  const tokens = withoutAffixes
    .split(/\s+/)
    .map((token) => token.replace(NON_LETTER, ''))
    .filter(Boolean)
  if (tokens.length === 0) {
    return {}
  }
  if (tokens.length === 1) {
    return { firstName: tokens[0] }
  }
  // Middle tokens (middle names/initials) are dropped: only the first and
  // last token become firstName/lastName, matching Google and Meta's own
  // enhanced-conversions examples.
  return { firstName: tokens[0], lastName: tokens[tokens.length - 1] }
}
