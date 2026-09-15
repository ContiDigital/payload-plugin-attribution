import type { Touches } from '../core/touches.js'

import { sanitizeAttribution } from '../core/sanitize.js'
import { decodeTouches, DEFAULT_COOKIE_NAME } from '../core/touches.js'

export type CookieParts = {
  domain?: string
  maxAge: number
  name: string
  secure: boolean
  value: string
}

const COOKIE_NAME_PATTERN = /^[\w-]{1,80}$/
const COOKIE_DOMAIN_PATTERN = /^\.?[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*$/i

export function assertCookieName(name: string): string {
  if (!COOKIE_NAME_PATTERN.test(name)) {
    throw new TypeError('Invalid attribution cookie name')
  }
  return name
}

export function assertCookieDomain(domain: string | undefined): string | undefined {
  if (domain !== undefined && (domain.length > 253 || !COOKIE_DOMAIN_PATTERN.test(domain))) {
    throw new TypeError('Invalid attribution cookie domain')
  }
  return domain
}

const MAX_COOKIE_HEADER_LENGTH = 16_384

export function cookieValues(header: null | string | undefined, name: string): string[] {
  if (!header || header.length > MAX_COOKIE_HEADER_LENGTH) {
    return []
  }
  const values: string[] = []
  for (const part of header.split(';')) {
    const split = part.indexOf('=')
    if (split <= 0 || part.slice(0, split).trim() !== name) {
      continue
    }
    const value = part.slice(split + 1).trim()
    values.push(
      value.length >= 2 && value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value,
    )
  }
  return values
}

/** Shared by request-side capture and the browser helpers, which both read raw cookie headers. */
export function validMetaCookies(header: null | string, key: 'fbc' | 'fbp'): string[] {
  return cookieValues(header, `_${key}`).flatMap((value) => {
    const valid = sanitizeAttribution({ [key]: value })?.[key]
    return valid ? [valid] : []
  })
}

/** Browsers send every same-named cookie (for example one per Domain); the first valid decode wins. */
export function readAttributionCookie(
  cookieHeader: null | string | undefined,
  options: { cookieName?: string; now?: Date } = {},
): null | Touches {
  const now = options.now ?? new Date()
  for (const value of cookieValues(cookieHeader, options.cookieName ?? DEFAULT_COOKIE_NAME)) {
    const touches = decodeTouches(value, now)
    if (touches) {
      return touches
    }
  }
  return null
}

export function serializeCookie(cookie: CookieParts): string {
  return [
    `${cookie.name}=${cookie.value}`,
    'Path=/',
    `Max-Age=${cookie.maxAge}`,
    'SameSite=Lax',
    ...(cookie.secure ? ['Secure'] : []),
    ...(cookie.domain ? [`Domain=${cookie.domain}`] : []),
  ].join('; ')
}
