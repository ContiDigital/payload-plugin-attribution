import type { Attribution, ConsentState } from '../core/sanitize.js'
import type { Touches } from '../core/touches.js'
import type { Ga4Item } from '../types/index.js'

import { validateItems } from '../core/items.js'
import { validEventName } from '../core/names.js'
import { sanitizeAttribution, withoutAdIdentifiers } from '../core/sanitize.js'
import { decodeTouches, DEFAULT_COOKIE_NAME } from '../core/touches.js'
import { cookieValues, validMetaCookies } from './cookie.js'

type Gtag = (...args: unknown[]) => void
type ConsentSignals = Partial<
  Record<'adPersonalization' | 'adUserData' | 'analyticsStorage', ConsentState>
>

export type BrowserOptions = {
  consent?: () => ConsentSignals
  cookieName?: string
  measurementId?: string
  timeoutMs?: number
}

const GA_IDENTITY_FIELDS = [
  ['client_id', 'gaClientId'],
  ['session_id', 'gaSessionId'],
  ['session_number', 'gaSessionNumber'],
] as const satisfies readonly (readonly [string, keyof Attribution])[]

function windowGtag(): Gtag | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  const candidate = (window as { gtag?: unknown }).gtag
  return typeof candidate === 'function' ? (candidate as Gtag) : undefined
}

function readCookieTouches(options: BrowserOptions): null | Touches {
  if (typeof document === 'undefined') {
    return null
  }
  const name = options.cookieName ?? DEFAULT_COOKIE_NAME
  const now = new Date()
  for (const value of cookieValues(document.cookie, name)) {
    const touches = decodeTouches(value, now)
    if (touches) {
      return touches
    }
  }
  return null
}

function metaIdentifiers(): Pick<Attribution, 'fbc' | 'fbp'> {
  if (typeof document === 'undefined') {
    return {}
  }
  const result: Pick<Attribution, 'fbc' | 'fbp'> = {}
  const fbp = validMetaCookies(document.cookie, 'fbp')[0]
  const fbc = validMetaCookies(document.cookie, 'fbc')[0]
  if (fbp) {
    result.fbp = fbp
  }
  if (fbc) {
    result.fbc = fbc
  }
  return result
}

function globalPrivacyControl(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as { globalPrivacyControl?: unknown }).globalPrivacyControl === true
  )
}

function consentAttribution(
  consent: ConsentSignals | undefined,
  gpc: boolean,
): Partial<Attribution> {
  if (!consent) {
    // Server delivery reads these fields, so GPC without a host decision must withhold ad uses.
    return gpc ? { consentAdPersonalization: 'denied', consentAdUserData: 'denied' } : {}
  }
  const result: Partial<Attribution> = {}
  if (consent.adPersonalization !== undefined) {
    result.consentAdPersonalization = consent.adPersonalization
  }
  if (consent.adUserData !== undefined) {
    result.consentAdUserData = consent.adUserData
  }
  if (consent.analyticsStorage !== undefined) {
    result.consentAnalyticsStorage = consent.analyticsStorage
  }
  return result
}

/**
 * Every field is requested independently and each has its own try/catch: a gtag stub that
 * throws on one field (or throws synchronously altogether) must not block the others, and must
 * still let captureAttribution resolve with whatever the cookie already held.
 */
async function gaIdentity(options: BrowserOptions): Promise<Partial<Attribution>> {
  const gtag = windowGtag()
  if (!gtag || !options.measurementId) {
    return {}
  }
  const measurementId = options.measurementId
  const timeoutMs = options.timeoutMs ?? 500
  const result: Partial<Attribution> = {}
  const assign = (key: (typeof GA_IDENTITY_FIELDS)[number][1], value: unknown): void => {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return
    }
    if (key === 'gaSessionNumber') {
      result.gaSessionNumber = Number(value)
    } else {
      result[key] = String(value)
    }
  }
  await new Promise<void>((resolve) => {
    let remaining = GA_IDENTITY_FIELDS.length
    let finished = false
    const finish = (): void => {
      if (!finished) {
        finished = true
        clearTimeout(timer)
        resolve()
      }
    }
    const timer = setTimeout(finish, timeoutMs)
    for (const [field, key] of GA_IDENTITY_FIELDS) {
      let received = false
      try {
        gtag('get', measurementId, field, (value: unknown) => {
          if (finished || received) {
            return
          }
          received = true
          assign(key, value)
          remaining -= 1
          if (remaining <= 0) {
            finish()
          }
        })
      } catch {
        if (!received) {
          remaining -= 1
        }
        if (remaining <= 0) {
          finish()
        }
      }
    }
  })
  return result
}

export async function captureAttribution(
  options: BrowserOptions = {},
): Promise<{ first?: Attribution; last: Attribution }> {
  if (typeof window === 'undefined') {
    return { last: {} }
  }
  const consent = options.consent?.()
  const gpc = globalPrivacyControl()
  const adIdentifiersAllowed =
    consent?.adUserData === 'granted' || (!gpc && consent?.adUserData !== 'denied')
  const allowAds = (touch: Attribution): Attribution =>
    adIdentifiersAllowed ? touch : withoutAdIdentifiers(touch)
  const cookieTouches = readCookieTouches(options)
  const identity = consent?.analyticsStorage === 'denied' ? {} : await gaIdentity(options)
  const meta = adIdentifiersAllowed ? metaIdentifiers() : {}
  const last = allowAds(
    sanitizeAttribution({
      ...cookieTouches?.last,
      ...identity,
      ...meta,
      ...consentAttribution(consent, gpc),
    }) ?? {},
  )
  return cookieTouches ? { first: allowAds(cookieTouches.first), last } : { last }
}

export async function attributionForSubmit(options: BrowserOptions = {}): Promise<Attribution> {
  try {
    return (await captureAttribution(options)).last
  } catch {
    return {}
  }
}

/**
 * gtag.js's own bootstrap snippet defines `function gtag(){ dataLayer.push(arguments) }` and
 * replays whatever was queued before it loaded. Pushing real `arguments` objects here (instead
 * of plain arrays) keeps every queued entry the exact shape gtag.js's own stub would have
 * produced, which is what this function stands in for before the real script exists.
 */
export function consentDefaults(defaults: {
  adPersonalization: 'denied' | 'granted'
  adsDataRedaction?: boolean
  adStorage: 'denied' | 'granted'
  adUserData: 'denied' | 'granted'
  analyticsStorage: 'denied' | 'granted'
  region?: string[]
  urlPassthrough?: boolean
  waitForUpdateMs?: number
}): void {
  if (typeof window === 'undefined') {
    return
  }
  const target = window as { dataLayer?: unknown }
  target.dataLayer ??= []
  // gtag.js cannot use a non-array dataLayer either; leave the host's value alone.
  if (!Array.isArray(target.dataLayer)) {
    return
  }
  const dataLayer: unknown[] = target.dataLayer
  function gtag(..._args: unknown[]): void {
    // eslint-disable-next-line prefer-rest-params -- see comment above: arguments, not an array.
    dataLayer.push(arguments)
  }
  gtag('consent', 'default', {
    ad_personalization: defaults.adPersonalization,
    ad_storage: defaults.adStorage,
    ad_user_data: defaults.adUserData,
    analytics_storage: defaults.analyticsStorage,
    ...(defaults.region ? { region: defaults.region } : {}),
    wait_for_update: defaults.waitForUpdateMs ?? 500,
  })
  if (defaults.adsDataRedaction !== undefined) {
    gtag('set', 'ads_data_redaction', defaults.adsDataRedaction)
  }
  if (defaults.urlPassthrough !== undefined) {
    gtag('set', 'url_passthrough', defaults.urlPassthrough)
  }
}

export function trackClient(
  name: string,
  params: Record<string, boolean | Ga4Item[] | number | string> = {},
  options: { eventId?: string; measurementId?: string } = {},
): null | string {
  // GA4 forbids personal data in parameters, and an address is the common accident.
  if (
    !validEventName(name) ||
    Object.entries(params).some(([key, value]) =>
      key === 'items'
        ? !validateItems(value)
        : typeof value === 'string'
          ? value.includes('@')
          : typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value)),
    )
  ) {
    return null
  }
  const gtag = windowGtag()
  if (!gtag) {
    return null
  }
  try {
    const eventId = options.eventId ?? createEventId()
    gtag('event', name, {
      ...params,
      ...(options.measurementId ? { send_to: options.measurementId } : {}),
      event_id: eventId,
    })
    return eventId
  } catch {
    return null
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createEventId(): string {
  const bytes = new Uint8Array(16)
  try {
    const cryptoObj = globalThis.crypto
    if (typeof cryptoObj.randomUUID === 'function') {
      try {
        return cryptoObj.randomUUID()
      } catch {
        // randomUUID() requires a secure context and throws on plain http origins.
      }
    }
    cryptoObj.getRandomValues(bytes)
  } catch {
    // Event ids only pair browser and server copies of one event, so non-cryptographic is enough.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = toHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
