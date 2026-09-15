export type ConsentState = 'denied' | 'granted' | 'unknown'
export type AttributionSource = 'import' | 'phone' | 'staff' | 'web'
export type Attribution = {
  capturedAt?: string
  clickCapturedAt?: string
  consentAdPersonalization?: ConsentState
  consentAdUserData?: ConsentState
  consentAnalyticsStorage?: ConsentState
  dclid?: string
  fbc?: string
  fbclid?: string
  fbp?: string
  firstSeenAt?: string
  gaClientId?: string
  gadCampaignId?: string
  gadSource?: string
  gaSessionId?: string
  gaSessionNumber?: number
  gaSessionStartedAt?: string
  gbraid?: string
  gclid?: string
  landingPath?: string
  liFatId?: string
  msclkid?: string
  referrerHost?: string
  source?: AttributionSource
  srsltid?: string
  ttclid?: string
  twclid?: string
  utmCampaign?: string
  utmContent?: string
  utmCreativeFormat?: string
  utmId?: string
  utmMarketingTactic?: string
  utmMedium?: string
  utmSource?: string
  utmSourcePlatform?: string
  utmTerm?: string
  wbraid?: string
}

export const CLICK_ID_KEYS = [
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'srsltid',
  'fbclid',
  'msclkid',
  'ttclid',
  'twclid',
  'liFatId',
] as const satisfies readonly (keyof Attribution)[]

export const AD_IDENTIFIER_KEYS = [...CLICK_ID_KEYS, 'fbc', 'fbp'] as const

export function withoutAdIdentifiers(touch: Attribution): Attribution {
  const rest = { ...touch }
  for (const key of [...AD_IDENTIFIER_KEYS, 'clickCapturedAt'] as const) {
    delete rest[key]
  }
  return rest
}
export const CLICK_ID_PATTERN = /^[\w.-]{10,500}$/
const BROWSER_ID_PATTERN = /^fb\.\d\.\d{10,16}\.[\w.-]{1,500}$/
const UTM_TEXT_KEYS = [
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmTerm',
  'utmContent',
  'utmId',
  'utmSourcePlatform',
  'utmCreativeFormat',
  'utmMarketingTactic',
] as const
const ISO_DATE_KEYS = ['firstSeenAt', 'capturedAt', 'clickCapturedAt'] as const
const CONSENT_KEYS = [
  'consentAdUserData',
  'consentAdPersonalization',
  'consentAnalyticsStorage',
] as const
const TEXT_RUN = /[\w+/=-]+/g
const MAX_DECODE_PASSES = 3
// Paths and referrer hosts are machine-chosen and routinely carry tokens; campaign values are
// host-chosen names, so only longer unseparated runs count as tokens there.
const PATH_TOKEN_LENGTH = 16
const TEXT_TOKEN_LENGTH = 24
// A segment after one of these (for example /reset-password/<token>) is a secret, whatever its shape.
const SENSITIVE_SEGMENT_WORDS = new Set([
  'activate',
  'activation',
  'confirm',
  'confirmation',
  'invitation',
  'invite',
  'invites',
  'magic',
  'otp',
  'reset',
  'token',
  'tokens',
  'unsubscribe',
  'verification',
  'verify',
])

export const consentState = (value: unknown): ConsentState =>
  value === 'granted' || value === 'denied' ? value : 'unknown'

export function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) {
    return
  }
  const time = Date.parse(value)
  if (!Number.isFinite(time)) {
    return
  }
  const iso = new Date(time).toISOString()
  if (iso.slice(0, 19) !== value.slice(0, 19)) {
    return
  }
  return iso
}

export function hasControlChar(text: string): boolean {
  return [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}

const mixesLettersAndDigits = (text: string): boolean => /\d/.test(text) && /[a-z]/i.test(text)

/** Double-encoded input such as john%2540example.com only reveals an address after several passes. */
function decodeRepeatedly(text: string): string {
  let current = text
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    let next: string
    try {
      next = decodeURIComponent(current)
    } catch {
      // One malformed escape must not hide the rest, such as a %40 that reveals an address.
      next = current.replace(/%([0-7][0-9a-f])/gi, (_escape, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
    }
    if (next === current) {
      return current
    }
    current = next
  }
  return current
}

/**
 * Token shape, whatever the case: an unseparated run of letters and digits of at least minLength
 * (hex, base36, base64url), or a separated run of at least minLength whose letter-and-digit parts
 * number two or more and hold at least half its characters (a UUID, base64url with - and _). Separator-joined words such as Brand_Search_US_2026_Q3 are
 * names, not tokens.
 */
function hasOpaqueToken(text: string, minLength: number): boolean {
  return (text.match(TEXT_RUN) ?? []).some((run) => {
    const parts = run.split(/[_+/=-]/).filter(Boolean)
    if (parts.some((part) => part.length >= minLength && mixesLettersAndDigits(part))) {
      return true
    }
    const mixed = parts.filter(mixesLettersAndDigits)
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const mixedLength = mixed.reduce((sum, part) => sum + part.length, 0)
    return total >= minLength && mixed.length >= 2 && mixedLength * 2 >= total
  })
}

export function safeText(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') {
    return
  }
  const text = value.trim()
  const decoded = decodeRepeatedly(text)
  if (
    !text ||
    decoded.includes('@') ||
    hasControlChar(decoded) ||
    hasOpaqueToken(decoded, TEXT_TOKEN_LENGTH)
  ) {
    return
  }
  return text.slice(0, max)
}

const sensitiveSegment = (segment: string): boolean =>
  segment
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => SENSITIVE_SEGMENT_WORDS.has(word))

function pathSafe(path: string): boolean {
  const decoded = decodeRepeatedly(path)
  if (decoded.includes('@') || hasControlChar(decoded)) {
    return false
  }
  const segments = decoded.split('/').filter(Boolean)
  return segments.every(
    (segment, index) =>
      !hasOpaqueToken(segment, PATH_TOKEN_LENGTH) &&
      !segments.slice(0, index).some(sensitiveSegment),
  )
}

/**
 * A page URL for providers: origin and path only. Queries and fragments carry emails, tokens and
 * click ids; a path the landing path rule would drop is reduced to the origin.
 */
export function safePageUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return
    }
    return pathSafe(url.pathname) ? `${url.origin}${url.pathname}` : url.origin
  } catch {
    return
  }
}

export function sessionSeconds(value: string): string | undefined {
  if (/^\d{6,20}$/.test(value)) {
    return value
  }
  if (/^GS\d\.\d\.s\d{6,20}(?:\$[a-z]\w{0,30}){0,12}$/.test(value)) {
    return value.match(/\.s(\d+)/)?.[1]
  }
}

/** Treat all browser and endpoint input as untrusted, including cookie JSON. */
export function sanitizeAttribution(raw: unknown): Attribution | null {
  try {
    return sanitizeObject(raw)
  } catch {
    return null
  }
}

function sanitizeObject(raw: unknown): Attribution | null {
  if (!plainObject(raw)) {
    return null
  }
  const result: Record<string, unknown> = {}
  for (const key of CLICK_ID_KEYS) {
    const value = raw[key]
    if (typeof value === 'string' && CLICK_ID_PATTERN.test(value)) {
      result[key] = value
    }
  }
  for (const key of ['fbc', 'fbp'] as const) {
    const value = raw[key]
    if (typeof value === 'string' && BROWSER_ID_PATTERN.test(value)) {
      result[key] = value
    }
  }
  for (const key of UTM_TEXT_KEYS) {
    const value = safeText(raw[key])
    if (value) {
      result[key] = value
    }
  }
  for (const [key, max] of [
    ['gadSource', 16],
    ['gadCampaignId', 32],
  ] as const) {
    if (typeof raw[key] === 'string' && /^\d+$/.test(raw[key]) && raw[key].length <= max) {
      result[key] = raw[key]
    }
  }
  if (
    typeof raw.gaClientId === 'string' &&
    /^(?:GA1\.\d\.)?\d{1,20}\.\d{1,20}$/.test(raw.gaClientId)
  ) {
    result.gaClientId = raw.gaClientId
  }
  if (typeof raw.gaSessionId === 'string') {
    const seconds = sessionSeconds(raw.gaSessionId)
    const millis = Number(seconds) * 1000
    if (seconds && Number.isSafeInteger(millis) && millis > 0 && millis < 253402300800000) {
      result.gaSessionId = raw.gaSessionId
      result.gaSessionStartedAt = new Date(millis).toISOString()
    }
  }
  if (Number.isSafeInteger(raw.gaSessionNumber) && Number(raw.gaSessionNumber) > 0) {
    result.gaSessionNumber = raw.gaSessionNumber
  }
  for (const key of ISO_DATE_KEYS) {
    const value = isoDate(raw[key])
    if (value) {
      result[key] = value
    }
  }
  for (const key of CONSENT_KEYS) {
    if (Object.hasOwn(raw, key)) {
      result[key] = consentState(raw[key])
    }
  }
  if (typeof raw.source === 'string' && ['import', 'phone', 'staff', 'web'].includes(raw.source)) {
    result.source = raw.source
  }
  if (typeof raw.landingPath === 'string') {
    try {
      const path = new URL(raw.landingPath, 'https://attribution.invalid').pathname
      if (pathSafe(path)) {
        result.landingPath = path.slice(0, 500)
      }
    } catch {
      /* Malformed URLs are discarded. */
    }
  }
  if (typeof raw.referrerHost === 'string') {
    try {
      const value = raw.referrerHost
      const host = new URL(value.includes('://') ? value : `https://${value}`).hostname
      if (
        host &&
        host.length <= 200 &&
        !host.includes('@') &&
        !host.split('.').some((label) => hasOpaqueToken(label, PATH_TOKEN_LENGTH))
      ) {
        result.referrerHost = host
      }
    } catch {
      /* Malformed referrers are discarded. */
    }
  }
  return Object.keys(result).length ? (result as Attribution) : null
}
