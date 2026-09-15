import type { Attribution, ConsentState } from '../core/sanitize.js'
import type { Touches } from '../core/touches.js'
import type { CookieParts } from './cookie.js'

import { AD_IDENTIFIER_KEYS, sanitizeAttribution, withoutAdIdentifiers } from '../core/sanitize.js'
import {
  cookieMaxAgeSeconds,
  DEFAULT_COOKIE_NAME,
  DEFAULT_MAX_BYTES,
  encodeTouches,
  mergeTouch,
} from '../core/touches.js'
import {
  assertCookieDomain,
  assertCookieName,
  readAttributionCookie,
  serializeCookie,
  validMetaCookies,
} from './cookie.js'

export type CaptureOptions = {
  consent?: (request: Request) => ConsentState | Promise<ConsentState>
  cookieDomain?: string
  cookieName?: string
  /**
   * Landing paths under any of these, such as '/reset-password', are not stored. Matching compares
   * whole decoded path segments case-insensitively, also after a leading locale segment such as
   * /en or /pt-br.
   */
  excludePaths?: string[]
  /** Added to the built-in payment and sign-in domains; each also matches its subdomains. */
  ignoreReferrers?: string[]
  maxBytes?: number
  /** Replaces the default of the request host's registrable domain and its subdomains. */
  siteHosts?: string[]
  trustForwardedHost?: boolean
}

export type ResolvedCaptureOptions = {
  consent?: CaptureOptions['consent']
  cookieDomain?: string
  cookieName: string
  excludePaths: string[]
  ignoreReferrers: string[]
  maxBytes?: number
  siteHosts?: string[]
  trustForwardedHost: boolean
}

export type CapturedCookie = { cookie: CookieParts; touches: Touches }

const DEFAULT_IGNORE_REFERRERS = [
  'stripe.com',
  'paypal.com',
  'pay.google.com',
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
  'plaid.com',
  'klarna.com',
  'affirm.com',
  'afterpay.com',
  'shop.app',
  'squareup.com',
  'authorize.net',
  'adyen.com',
  'cardinalcommerce.com',
  '3dsecure.io',
  'arcot.com',
] as const

const COUNTRY_SECOND_LEVEL_LABELS = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'go',
  'gob',
  'gov',
  'ne',
  'net',
  'or',
  'org',
])

const QUERY_PARAMS = [
  ['gclid', 'gclid'],
  ['gbraid', 'gbraid'],
  ['wbraid', 'wbraid'],
  ['dclid', 'dclid'],
  ['fbclid', 'fbclid'],
  ['msclkid', 'msclkid'],
  ['ttclid', 'ttclid'],
  ['twclid', 'twclid'],
  ['li_fat_id', 'liFatId'],
  ['srsltid', 'srsltid'],
  ['gad_source', 'gadSource'],
  ['gad_campaignid', 'gadCampaignId'],
  ['utm_source', 'utmSource'],
  ['utm_medium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
  ['utm_term', 'utmTerm'],
  ['utm_content', 'utmContent'],
  ['utm_id', 'utmId'],
  ['utm_source_platform', 'utmSourcePlatform'],
  ['utm_creative_format', 'utmCreativeFormat'],
  ['utm_marketing_tactic', 'utmMarketingTactic'],
] as const satisfies readonly (readonly [string, keyof Attribution])[]

const normalizeHost = (host: string): string => host.trim().toLowerCase().replace(/\.$/, '')

function hostOf(value: string): string | undefined {
  try {
    const host = new URL(value.includes('://') ? value : `http://${value}`).hostname
    return host ? normalizeHost(host) : undefined
  } catch {
    return undefined
  }
}

const SHARED_HOSTING_SUFFIXES = [
  'amplifyapp.com',
  'azurewebsites.net',
  'cloudfront.net',
  'firebaseapp.com',
  'fly.dev',
  'github.io',
  'herokuapp.com',
  'netlify.app',
  'onrender.com',
  'pages.dev',
  'vercel.app',
  'web.app',
] as const

/**
 * Not a Public Suffix List lookup: the last two labels, or three under a two-letter country code
 * with a common second-level label such as co.uk or com.ar. Hosts under a known shared hosting
 * domain stay on their own, so other tenants remain external; other multi-part suffixes, and
 * deeper subdomains under shared hosting that should count as one site, set siteHosts.
 */
export function registrableDomain(host: string): string {
  if (
    /^[\d.]+$/.test(host) ||
    host.includes(':') ||
    host.startsWith('[') ||
    SHARED_HOSTING_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`))
  ) {
    return host
  }
  const labels = host.split('.')
  const topLevel = labels[labels.length - 1] ?? ''
  const secondLevel = labels[labels.length - 2] ?? ''
  const size =
    labels.length >= 3 && topLevel.length === 2 && COUNTRY_SECOND_LEVEL_LABELS.has(secondLevel)
      ? 3
      : 2
  return labels.slice(-size).join('.')
}

const suffixMatch = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`)

function siteHostMatch(host: string, pattern: string): boolean {
  const normalized = normalizeHost(pattern)
  return normalized.startsWith('.') ? suffixMatch(host, normalized.slice(1)) : host === normalized
}

export function resolveCaptureOptions(options: CaptureOptions = {}): ResolvedCaptureOptions {
  if (
    options.maxBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 4096)
  ) {
    throw new TypeError('Invalid attribution cookie maxBytes')
  }
  const excludePaths = options.excludePaths ?? []
  if (!excludePaths.every((prefix) => typeof prefix === 'string' && prefix.startsWith('/'))) {
    throw new TypeError('Invalid attribution excludePaths')
  }
  const cookieName = assertCookieName(options.cookieName ?? DEFAULT_COOKIE_NAME)
  // Browsers drop a cookie whose name and value exceed 4096 bytes, and a __Host- cookie with a Domain.
  if (cookieName.length + 1 + (options.maxBytes ?? DEFAULT_MAX_BYTES) > 4096) {
    throw new TypeError('Invalid attribution cookie maxBytes for this cookie name')
  }
  if (/^__host-/i.test(cookieName) && options.cookieDomain !== undefined) {
    throw new TypeError('Invalid attribution cookie domain for a __Host- cookie')
  }
  return {
    consent: options.consent,
    cookieDomain: assertCookieDomain(options.cookieDomain),
    cookieName,
    excludePaths,
    ignoreReferrers: [...DEFAULT_IGNORE_REFERRERS, ...(options.ignoreReferrers ?? [])].map(
      (pattern) => normalizeHost(pattern).replace(/^\./, ''),
    ),
    maxBytes: options.maxBytes,
    siteHosts: options.siteHosts,
    trustForwardedHost: options.trustForwardedHost ?? false,
  }
}

const LOCALE_SEGMENT = /^[a-z]{2}(?:[-_](?:[a-z]{2}|\d{3}))?$/i

const pathSegments = (path: string): string[] =>
  path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      let current = segment
      for (let pass = 0; pass < 3; pass += 1) {
        try {
          const next = decodeURIComponent(current)
          if (next === current) {
            break
          }
          current = next
        } catch {
          break
        }
      }
      return current.toLowerCase()
    })

export function excludedPath(pathname: string, excludePaths: readonly string[]): boolean {
  const segments = pathSegments(pathname)
  const candidates =
    segments.length > 0 && LOCALE_SEGMENT.test(segments[0])
      ? [segments, segments.slice(1)]
      : [segments]
  return excludePaths.some((prefix) => {
    const wanted = pathSegments(prefix)
    return candidates.some((candidate) =>
      wanted.every((segment, index) => candidate[index] === segment),
    )
  })
}

const hasAdIdentifiers = (touches: Touches): boolean =>
  [touches.first, touches.last].some((touch) =>
    [...AD_IDENTIFIER_KEYS, 'clickCapturedAt' as const].some((key) => touch[key] !== undefined),
  )

// Next strips Next-Router-Prefetch and RSC before middleware runs, so under Next only the matcher's
// missing clause can exclude them; these checks cover other runtimes.
function isPrefetch(headers: Headers): boolean {
  return (
    headers.has('next-router-prefetch') ||
    headers.get('purpose')?.toLowerCase() === 'prefetch' ||
    (headers.get('sec-purpose')?.toLowerCase().includes('prefetch') ?? false) ||
    headers.get('rsc') === '1'
  )
}

const firstForwarded = (headers: Headers, name: string): string | undefined =>
  headers.get(name)?.split(',')[0]?.trim() || undefined

function classifyReferrer(
  request: Request,
  host: string,
  options: ResolvedCaptureOptions,
): { external?: string; kind: 'external' | 'internal' | 'none' } {
  const header = request.headers.get('referer')
  const referrer = header ? hostOf(header) : undefined
  if (!referrer) {
    return { kind: 'none' }
  }
  const internal = options.siteHosts
    ? options.siteHosts.some((pattern) => siteHostMatch(referrer, pattern))
    : suffixMatch(referrer, registrableDomain(host))
  if (internal || options.ignoreReferrers.some((domain) => suffixMatch(referrer, domain))) {
    return { kind: 'internal' }
  }
  return { external: referrer, kind: 'external' }
}

export async function captureWithOptions(
  request: Request,
  options: ResolvedCaptureOptions,
  now: Date,
): Promise<CapturedCookie | null> {
  const url = new URL(request.url)
  const { headers } = request
  if (
    !['GET', 'HEAD'].includes(request.method) ||
    !['http:', 'https:'].includes(url.protocol) ||
    isPrefetch(headers)
  ) {
    return null
  }

  const forwardedHost = options.trustForwardedHost
    ? firstForwarded(headers, 'x-forwarded-host')
    : undefined
  const host = (forwardedHost && hostOf(forwardedHost)) || normalizeHost(url.hostname)
  const forwardedProto = options.trustForwardedHost
    ? firstForwarded(headers, 'x-forwarded-proto')?.toLowerCase()
    : undefined
  const secure = forwardedProto ? forwardedProto === 'https' : url.protocol === 'https:'

  const cookieHeader = headers.get('cookie')
  const existing = readAttributionCookie(cookieHeader, { cookieName: options.cookieName, now })
  const cookieFor = (touches: Touches): CapturedCookie | null => {
    const value = encodeTouches(touches, options.maxBytes)
    return value === null
      ? null
      : {
          cookie: {
            name: options.cookieName,
            domain: options.cookieDomain,
            maxAge: cookieMaxAgeSeconds(touches, now),
            secure,
            value,
          },
          touches,
        }
  }

  let consentDenied = false
  let adIdentifiersAllowed = headers.get('sec-gpc')?.trim() !== '1'
  if (options.consent) {
    try {
      consentDenied = (await options.consent(request)) === 'denied'
    } catch {
      // A broken hook (a malformed consent cookie, say) must not fail the page or keep ad ids.
      consentDenied = true
    }
    adIdentifiersAllowed = !consentDenied
  }
  // Every request that returns without a new touch still removes ad ids an earlier request
  // stored before consent was denied or Global Privacy Control was turned on.
  const unchanged = (): CapturedCookie | null =>
    !adIdentifiersAllowed && existing && hasAdIdentifiers(existing)
      ? cookieFor({
          first: withoutAdIdentifiers(existing.first),
          last: withoutAdIdentifiers(existing.last),
        })
      : null
  if (consentDenied) {
    return unchanged()
  }

  const params: Record<string, string> = {}
  for (const [query, key] of QUERY_PARAMS) {
    const value = url.searchParams.get(query)
    if (value !== null) {
      params[key] = value
    }
  }
  if (!adIdentifiersAllowed) {
    for (const key of AD_IDENTIFIER_KEYS) {
      delete params[key]
    }
  }
  const paramTouch = sanitizeAttribution(params)
  const referrer = classifyReferrer(request, host, options)

  // Internal links can carry click ids or UTMs; once a cookie exists they must not replace the last touch.
  if (existing && referrer.kind === 'internal') {
    return unchanged()
  }
  // A first visit with no referrer is a direct arrival worth recording; later direct visits are not touches.
  if (!paramTouch && referrer.kind !== 'external' && (existing || referrer.kind === 'internal')) {
    return unchanged()
  }

  const meta: Pick<Attribution, 'fbc' | 'fbp'> = {}
  if (adIdentifiersAllowed) {
    const fbclid = paramTouch?.fbclid
    const fbcCookies = validMetaCookies(cookieHeader, 'fbc')
    meta.fbp = validMetaCookies(cookieHeader, 'fbp')[0]
    // A stale _fbc from an earlier click would pair the wrong click time with this fbclid.
    meta.fbc = fbclid
      ? (fbcCookies.find((fbc) => fbc.endsWith(`.${fbclid}`)) ?? `fb.1.${now.getTime()}.${fbclid}`)
      : fbcCookies[0]
  }

  const incoming =
    sanitizeAttribution({
      ...params,
      ...meta,
      capturedAt: now.toISOString(),
      landingPath: excludedPath(url.pathname, options.excludePaths) ? undefined : url.pathname,
      referrerHost: referrer.external,
      source: 'web',
    }) ?? {}
  const merged = mergeTouch(existing, incoming, now)
  // mergeTouch carries click ids from the existing cookie, so an opt-out must clear both touches.
  const touches = adIdentifiersAllowed
    ? merged
    : { first: withoutAdIdentifiers(merged.first), last: withoutAdIdentifiers(merged.last) }
  return cookieFor(touches)
}

export async function captureFromRequest(
  request: Request,
  options: CaptureOptions = {},
  now: Date = new Date(),
): Promise<{ setCookie?: string; touches?: Touches }> {
  const captured = await captureWithOptions(request, resolveCaptureOptions(options), now)
  return captured ? { setCookie: serializeCookie(captured.cookie), touches: captured.touches } : {}
}
