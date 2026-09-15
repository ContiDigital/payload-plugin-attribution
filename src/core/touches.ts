import type { Attribution } from './sanitize.js'

import { CLICK_ID_KEYS, isoDate, plainObject, sanitizeAttribution } from './sanitize.js'
import { DAY_MS, parseIso } from './time.js'

export type ClickIdKey = (typeof CLICK_ID_KEYS)[number]
/** When each click id on the last touch was clicked; each one expires on its own. */
export type ClickTimes = Partial<Record<ClickIdKey, string>>
export type Touches = { clickTimes?: ClickTimes; first: Attribution; last: Attribution }

export const DEFAULT_COOKIE_NAME = 'attr_touch'

export const CLICK_WINDOW_DAYS = 90

const COOKIE_MAX_AGE_CAP_DAYS = 400
export const DEFAULT_MAX_BYTES = 3800
const DEFAULT_SKEW_MS = 86_400_000

const FREE_TEXT_CAP = 150
const PATH_CAP = 300

/**
 * Drop order for cookie size pressure: least valuable for matching first. Click data is dropped
 * only after every free-text field, in CLICK_DROP_ORDER. This is the single
 * source of truth for which free-text fields exist, so encodeTouches can
 * always shrink down to the minimal touch and FREE_TEXT_KEYS below (used for
 * the fixed-length cap, not the drop order) cannot drift out of sync with it.
 */
export const FREE_TEXT_DROP_ORDER = [
  'utmContent',
  'utmTerm',
  'utmCampaign',
  'landingPath',
  'referrerHost',
  'utmId',
  'utmMarketingTactic',
  'utmCreativeFormat',
  'utmSourcePlatform',
  'utmMedium',
  'utmSource',
] as const satisfies readonly (keyof Attribution)[]

const CLICK_DROP_ORDER = [
  ['fbc', 'fbp'],
  ['msclkid'],
  ['ttclid'],
  ['twclid'],
  ['liFatId'],
  ['dclid'],
  ['srsltid'],
  ['fbclid'],
  ['wbraid'],
  ['gbraid'],
  ['gclid'],
] as const satisfies readonly (readonly (keyof Attribution)[])[]

const FREE_TEXT_KEYS: readonly (keyof Attribution)[] = FREE_TEXT_DROP_ORDER.filter(
  (key) => key !== 'landingPath',
)

function hasClickId(touch: Attribution): boolean {
  return CLICK_ID_KEYS.some((key) => touch[key] !== undefined)
}

function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  const at = parseIso(a)
  const bt = parseIso(b)
  if (at === undefined) {
    return b
  }
  if (bt === undefined) {
    return a
  }
  return at >= bt ? a : b
}

/**
 * sanitizeAttribution accepts a valid clickCapturedAt independently of any
 * click id key, so a touch with no click id can still carry a stray one in.
 * Strip it here; it is always derived from the per-key click times.
 */
function withoutClickCapturedAt(touch: Attribution): Attribution {
  const { clickCapturedAt: _clickCapturedAt, ...rest } = touch
  return rest
}

// Google Ads checks its click window against clickCapturedAt, so the Google click id it would
// send (gclid, else gbraid, else wbraid) anchors it; otherwise the latest click does.
const GOOGLE_ANCHOR_KEYS = ['gclid', 'gbraid', 'wbraid'] as const

function withClickTimes(
  touch: Attribution,
  times: ClickTimes,
): { clickTimes?: ClickTimes; last: Attribution } {
  const clickTimes: ClickTimes = {}
  for (const key of CLICK_ID_KEYS) {
    const at = times[key]
    if (touch[key] !== undefined && at !== undefined) {
      clickTimes[key] = at
    }
  }
  const rest = withoutClickCapturedAt(touch)
  const googleKey = GOOGLE_ANCHOR_KEYS.find((key) => clickTimes[key] !== undefined)
  const anchor = googleKey
    ? clickTimes[googleKey]
    : CLICK_ID_KEYS.reduce<string | undefined>(
        (latest, key) => laterOf(latest, clickTimes[key]),
        undefined,
      )
  return {
    ...(Object.keys(clickTimes).length > 0 ? { clickTimes } : {}),
    last: anchor ? { ...rest, clickCapturedAt: anchor } : rest,
  }
}

const fbcFor = (touch: Attribution): string | undefined =>
  touch.fbclid !== undefined && touch.fbc?.endsWith(`.${touch.fbclid}`) ? touch.fbc : undefined

/** Removes click ids clicked longer ago than maxAgeMs, with the fbc built from an expired fbclid. */
function withoutExpiredClicks(
  touch: Attribution,
  times: ClickTimes,
  now: Date,
  maxAgeMs: number,
): Attribution {
  const result = { ...touch }
  for (const key of CLICK_ID_KEYS) {
    const at = parseIso(times[key])
    if (result[key] === undefined || at === undefined || now.getTime() - at <= maxAgeMs) {
      continue
    }
    if (key === 'fbclid' && fbcFor(result)) {
      delete result.fbc
    }
    delete result[key]
  }
  return result
}

const priorClickTime = (existing: Touches, key: ClickIdKey): string | undefined =>
  existing.clickTimes?.[key] ?? existing.last.clickCapturedAt

/**
 * Click ids carry per key: a click of one kind never clears another kind's carried id, and a
 * repeated id keeps its original click time. fbc is carried alongside fbclid because it encodes
 * that same click (creation time and fbclid); carrying one without the other would desync them.
 */
export function mergeTouch(existing: null | Touches, incoming: Attribution, now: Date): Touches {
  const nowIso = now.toISOString()
  const capturedAt = incoming.capturedAt ?? nowIso
  const clickedAt = incoming.clickCapturedAt ?? capturedAt
  const window = CLICK_WINDOW_DAYS * DAY_MS

  if (!existing) {
    const firstSeenAt = incoming.firstSeenAt ?? nowIso
    const times: ClickTimes = Object.fromEntries(
      CLICK_ID_KEYS.filter((key) => incoming[key] !== undefined).map((key) => [key, clickedAt]),
    )
    const touch = withClickTimes({ ...incoming, capturedAt, firstSeenAt }, times)
    return { ...touch, first: { ...touch.last }, last: { ...touch.last } }
  }

  const firstSeenAt = existing.first.firstSeenAt
  let last: Attribution = withoutClickCapturedAt({ ...incoming, capturedAt, firstSeenAt })
  const times: ClickTimes = {}
  for (const key of CLICK_ID_KEYS) {
    const value = incoming[key]
    const prior = existing.last[key]
    const priorAt = priorClickTime(existing, key)
    if (value !== undefined) {
      // A reused decorated URL repeats the stored click id; re-anchoring would extend a stale click.
      times[key] = value === prior ? (priorAt ?? clickedAt) : clickedAt
    } else if (prior !== undefined) {
      const priorMs = parseIso(priorAt)
      if (priorMs !== undefined && now.getTime() - priorMs <= window) {
        last = { ...last, [key]: prior }
        times[key] = priorAt
      }
    }
  }
  const priorFbc = fbcFor(existing.last)
  if (last.fbclid !== undefined && last.fbclid === existing.last.fbclid && priorFbc) {
    last = { ...last, fbc: priorFbc }
  }
  last = withoutExpiredClicks(last, times, now, window)
  const merged = withClickTimes(last, times)
  return { ...merged, first: existing.first }
}

export function cookieMaxAgeSeconds(touches: Touches, now: Date): number {
  const anchorIso = laterOf(touches.last.clickCapturedAt, touches.last.capturedAt)
  const anchorMs = parseIso(anchorIso) ?? now.getTime()
  const elapsedMs = now.getTime() - anchorMs
  const remainingSeconds = Math.floor((CLICK_WINDOW_DAYS * DAY_MS - elapsedMs) / 1000)
  return Math.min(Math.max(0, remainingSeconds), COOKIE_MAX_AGE_CAP_DAYS * 86400)
}

// The proxy never writes consent or GA identity, and page scripts can write this cookie, so a
// value found there is not the visitor's decision; only the browser helper's posted values are.
const BROWSER_ONLY_KEYS = new Set([
  'consentAdPersonalization',
  'consentAdUserData',
  'consentAnalyticsStorage',
  'gaClientId',
  'gaSessionId',
  'gaSessionNumber',
  'gaSessionStartedAt',
])

const withoutBrowserOnlyKeys = <T extends object>(touch: T): T =>
  Object.fromEntries(Object.entries(touch).filter(([key]) => !BROWSER_ONLY_KEYS.has(key))) as T

export function decodeTouches(
  value: string | undefined,
  now: Date,
  options: { skewMs?: number } = {},
): null | Touches {
  if (!value) {
    return null
  }
  const skewMs = options.skewMs ?? DEFAULT_SKEW_MS
  let raw: unknown
  try {
    raw = JSON.parse(decodeURIComponent(value))
  } catch {
    return null
  }
  if (!plainObject(raw)) {
    return null
  }
  const sanitizedFirst = sanitizeAttribution(raw.first)
  const sanitizedLast = sanitizeAttribution(raw.last)
  if (!sanitizedFirst || !sanitizedLast) {
    return null
  }
  const first = withoutBrowserOnlyKeys(sanitizedFirst)
  const last = withoutBrowserOnlyKeys(sanitizedLast)
  const anchorIso = laterOf(last.clickCapturedAt, last.capturedAt)
  const anchorMs = parseIso(anchorIso)
  if (anchorMs === undefined) {
    return null
  }
  const age = now.getTime() - anchorMs
  if (age < -skewMs || age > CLICK_WINDOW_DAYS * DAY_MS + skewMs) {
    return null
  }
  const rawTimes = plainObject(raw.clickTimes) ? raw.clickTimes : {}
  const times: ClickTimes = {}
  let touch = last
  for (const key of CLICK_ID_KEYS) {
    if (touch[key] === undefined) {
      continue
    }
    // Cookies written before per-key click times share the touch's clickCapturedAt.
    const at =
      (Object.hasOwn(rawTimes, key) ? isoDate(rawTimes[key]) : undefined) ?? last.clickCapturedAt
    const atMs = parseIso(at)
    if (atMs !== undefined && now.getTime() - atMs < -skewMs) {
      touch = withoutExpiredClicks(touch, { [key]: new Date(0).toISOString() }, now, 0)
      continue
    }
    times[key] = at
  }
  touch = withoutExpiredClicks(touch, times, now, CLICK_WINDOW_DAYS * DAY_MS + skewMs)
  return { ...withClickTimes(touch, times), first }
}

/**
 * A plain .slice(0, max) cuts by UTF-16 code unit and can split a surrogate
 * pair (for example an emoji) exactly at the cap, leaving a lone high
 * surrogate that is invalid UTF-16. Back off one unit when that would happen.
 */
function sliceAtCodePointBoundary(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  let end = max
  const lastCode = text.charCodeAt(end - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1
  }
  return text.slice(0, end)
}

/** A cut inside %XX, or inside a multi-byte UTF-8 sequence, would leave a path that cannot decode. */
function sliceAtEscapeBoundary(path: string, max: number): string {
  if (path.length <= max) {
    return path
  }
  let end = max
  if (path[end - 1] === '%') {
    end -= 1
  } else if (path[end - 2] === '%') {
    end -= 2
  }
  let continuations = 0
  let start = end
  while (start >= 3 && path[start - 3] === '%' && /^[89ab]/i.test(path.slice(start - 2, start))) {
    start -= 3
    continuations += 1
  }
  if (start >= 3 && path[start - 3] === '%') {
    const lead = Number.parseInt(path.slice(start - 2, start), 16)
    const needed = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0
    if (continuations < needed) {
      end = start - 3
    }
  }
  return path.slice(0, end)
}

function capField(touch: Attribution): Attribution {
  let capped = touch
  for (const key of FREE_TEXT_KEYS) {
    const value = capped[key]
    if (typeof value === 'string' && value.length > FREE_TEXT_CAP) {
      capped = { ...capped, [key]: sliceAtCodePointBoundary(value, FREE_TEXT_CAP) }
    }
  }
  if (typeof capped.landingPath === 'string' && capped.landingPath.length > PATH_CAP) {
    capped = { ...capped, landingPath: sliceAtEscapeBoundary(capped.landingPath, PATH_CAP) }
  }
  return capped
}

function dropField(touch: Attribution, key: (typeof FREE_TEXT_DROP_ORDER)[number]): Attribution {
  if (!(key in touch)) {
    return touch
  }
  const rest = { ...touch }
  delete rest[key]
  return rest
}

export function encodeTouches(touches: Touches, maxBytes = DEFAULT_MAX_BYTES): null | string {
  let first = capField(touches.first)
  let last = capField(touches.last)
  let clickTimes = touches.clickTimes
  const encode = (): string => {
    const kept = clickTimes ? withClickTimes(last, clickTimes).clickTimes : undefined
    return encodeURIComponent(
      JSON.stringify(kept ? { clickTimes: kept, first, last } : { first, last }),
    )
  }
  let encoded = encode()

  for (const key of FREE_TEXT_DROP_ORDER) {
    if (encoded.length <= maxBytes) {
      break
    }
    first = dropField(first, key)
    last = dropField(last, key)
    encoded = encode()
  }

  for (const keys of CLICK_DROP_ORDER) {
    for (const side of ['first', 'last'] as const) {
      if (encoded.length <= maxBytes) {
        return encoded
      }
      const touch = { ...(side === 'first' ? first : last) }
      for (const key of keys) {
        delete touch[key]
      }
      if (!hasClickId(touch)) {
        delete touch.clickCapturedAt
      }
      if (side === 'first') {
        first = touch
      } else if (clickTimes) {
        const rewritten = withClickTimes(touch, clickTimes)
        last = rewritten.last
        clickTimes = rewritten.clickTimes
      } else {
        last = touch
      }
      encoded = encode()
    }
  }

  return encoded.length <= maxBytes ? encoded : null
}
