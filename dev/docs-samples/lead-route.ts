import type { Attribution } from 'payload-plugin-attribution/browser'

import { randomUUID } from 'node:crypto'
import { getPayload } from 'payload'
import { recordConversion, requestContextFromHeaders } from 'payload-plugin-attribution'
import { sanitizeAttribution } from 'payload-plugin-attribution/browser'
import { readAttributionCookie } from 'payload-plugin-attribution/next'

import config from './payload.config.js'

type LeadBody = { attribution?: unknown; email?: unknown; name?: unknown }

// Only values the browser alone can know. Click ids, fbc, UTMs, referrer and landing data come
// from the proxy cookie, which the proxy strips under Global Privacy Control and the reader
// re-sanitizes; posted copies could restore ids the proxy removed.
const BROWSER_ONLY_KEYS = [
  'gaClientId',
  'gaSessionId',
  'gaSessionNumber',
  'fbp',
  'consentAdUserData',
  'consentAdPersonalization',
  'consentAnalyticsStorage',
] as const satisfies readonly (keyof Attribution)[]

const browserOnly = (posted: unknown): Attribution => {
  const sanitized = sanitizeAttribution(posted) ?? {}
  return Object.fromEntries(
    BROWSER_ONLY_KEYS.flatMap((key) =>
      sanitized[key] === undefined ? [] : [[key, sanitized[key]]],
    ),
  ) as Attribution
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

// The full referrer can carry click ids and other query values; Meta only needs the page.
const pageUrl = (referer: null | string): string | undefined => {
  try {
    const url = new URL(referer ?? '')
    return `${url.origin}${url.pathname}`
  } catch {
    return undefined
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as LeadBody
  const touches = readAttributionCookie(request.headers.get('cookie'))
  // The proxy cookie wins where both carry a value.
  const attribution = sanitizeAttribution({
    ...browserOnly(body.attribution),
    ...touches?.last,
  })
  const url = pageUrl(request.headers.get('referer'))
  const reference = randomUUID()
  // The form post carries Sec-GPC too. Unless the visitor's own consent choice was posted, it
  // denies ad consent, so Google Ads and Meta never receive this visitor's identifiers.
  const consent =
    request.headers.get('sec-gpc')?.trim() === '1' && attribution?.consentAdUserData === undefined
      ? ({ adPersonalization: 'denied', adUserData: 'denied' } as const)
      : undefined

  await recordConversion({
    draft: {
      name: 'generate_lead',
      attribution,
      buyer: { name: text(body.name), email: text(body.email) },
      ...(consent ? { consent } : {}),
      // trustProxy reads the client address appended by your own reverse proxy.
      context: {
        ...requestContextFromHeaders(request.headers, { trustProxy: true }),
        ...(url ? { url } : {}),
      },
      eventKey: `lead:${reference}`,
      eventSource: 'WEB',
      googleAds: { action: 'lead' },
      occurredAt: new Date().toISOString(),
      transactionId: reference,
    },
    payload: await getPayload({ config }),
  })
  return Response.json({ reference })
}
