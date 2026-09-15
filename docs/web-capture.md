# Web capture

Storefront capture has three parts: a Next.js proxy that keeps a first and last touch cookie, a browser helper that adds GA identity and consent when a form is submitted, and a server handler that combines both into a conversion draft.

## The attribution cookie

The cookie is named `attr_touch` by default and holds two touches, `first` and `last`. Each touch can carry:

- Click ids: `gclid`, `gbraid`, `wbraid`, `dclid`, `fbclid`, `msclkid`, `ttclid`, `twclid`, `li_fat_id` and `srsltid`, plus `gad_source` and `gad_campaignid`.
- UTM parameters: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id`, `utm_source_platform`, `utm_creative_format` and `utm_marketing_tactic`.
- Meta browser ids `fbc` and `fbp`, read from the `_fbc` and `_fbp` cookies.
- The landing path, the external referrer host, and capture timestamps.

The first touch is set once, including a first direct visit, and never replaced. The last touch is replaced by each later touch. Click ids carry per key: each one stays on the last touch for 90 days after its own click, a later click of another kind (for example an organic `srsltid` or `fbclid` visit after a paid `gclid`) never clears it, and only a new value for the same key replaces it. The cookie records each click id's click time, and `clickCapturedAt` is the click time of the Google click id (`gclid`, else `gbraid`, else `wbraid`) when one is present, otherwise of the latest click. The cookie expires 90 days after the later of the last click and the last capture.

The cookie is `Path=/`, `SameSite=Lax`, not `HttpOnly` (the browser helper reads it), and at most 3,800 bytes by default. When a touch is too large, free-text fields are dropped first and click ids last.

## Next.js proxy

Compose `attributionProxy` last. On Next 16 it goes in `proxy.ts`, which exports `proxy`:

<!-- sample: proxy.ts -->

```ts
import type { NextRequest } from 'next/server.js'

import { NextResponse } from 'next/server.js'
import { attributionProxy } from 'payload-plugin-attribution/next'

const attribution = attributionProxy({ excludePaths: ['/reset-password', '/pay'] })

export async function proxy(request: NextRequest): Promise<Response> {
  // Host logic runs first: redirects, rewrites, headers and cookies.
  const response = NextResponse.next()
  response.headers.set('x-frame-options', 'DENY')
  // Attribution runs last: a later response.cookies.set would drop its Set-Cookie header.
  return attribution(request, response)
}

export const config = {
  matcher: [
    {
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'rsc' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
        { type: 'header', key: 'sec-purpose', value: '.*prefetch.*' },
      ],
      source: '/((?!api|admin|_next|favicon.ico).*)',
    },
  ],
}
```

On Next 15 it goes in `middleware.ts`, which must export `middleware` (or a default export). An export named `proxy` type-checks and builds on Next 15, then fails every matched request with HTTP 500:

<!-- sample: middleware.ts -->

```ts
import type { NextRequest } from 'next/server.js'

import { NextResponse } from 'next/server.js'
import { attributionProxy } from 'payload-plugin-attribution/next'

const attribution = attributionProxy({ excludePaths: ['/reset-password', '/pay'] })

// Next 15 runs middleware.ts and loads only an export named middleware (or a default export);
// an export named proxy builds and type-checks, then fails every matched request with HTTP 500.
export async function middleware(request: NextRequest): Promise<Response> {
  // Host logic runs first: redirects, rewrites, headers and cookies.
  const response = NextResponse.next()
  response.headers.set('x-frame-options', 'DENY')
  // Attribution runs last: a later response.cookies.set would drop its Set-Cookie header.
  return attribution(request, response)
}

export const config = {
  matcher: [
    {
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'rsc' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
        { type: 'header', key: 'sec-purpose', value: '.*prefetch.*' },
      ],
      source: '/((?!api|admin|_next|favicon.ico).*)',
    },
  ],
}
```

- **Compose it last.** It appends its `Set-Cookie` header to the response you pass. A host that calls `response.cookies.set` after it returns rewrites the whole Set-Cookie list and drops the attribution cookie. Set host cookies before calling it.
- **The matcher's `missing` clause is mandatory.** Next strips the `Next-Router-Prefetch` and `RSC` headers before middleware runs, so only the matcher can keep prefetches from being counted as visits.
- **Cache-Control.** When the proxy writes the cookie, it sets `Cache-Control: private, no-store` unless the response is already `private`, so a first-visit landing page with tracking parameters is never cached publicly. `next dev` replaces this header on rendered pages; verify caching behavior with `next build` and `next start`.
- **Next request, not this render.** The cookie written on a request is readable from the next request. Server components rendering the landing request itself do not see it.

### What counts as a touch

Only `GET` and `HEAD` requests over `http` or `https` are captured, and prefetch requests are skipped.

- A request with tracking parameters, or from an external referrer, becomes the new last touch.
- A first visit with no referrer is recorded as a direct touch. Later direct visits leave the cookie alone.
- Once a cookie exists, internal navigation never replaces the last touch, even when an internal link carries tracking parameters.

### Options

| Option               | Default                        | Purpose                                                                                            |
| -------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `excludePaths`       | `[]`                           | Paths whose landing path is not stored, matched by whole segments                                  |
| `ignoreReferrers`    | `[]`                           | Domains treated as internal, added to the built-in payment and sign-in providers                   |
| `siteHosts`          | Registrable domain of the host | Hosts treated as internal; replaces the default rule                                               |
| `consent`            | None                           | Host consent decision per request; replaces the Global Privacy Control default                     |
| `cookieName`         | `'attr_touch'`                 | Cookie name, letters, digits, `_` and `-`. A `__Host-` name cannot be combined with `cookieDomain` |
| `cookieDomain`       | Host only                      | `Domain` attribute, for sharing the cookie across subdomains                                       |
| `maxBytes`           | `3800`                         | Maximum encoded cookie size; with the cookie name and `=` it must fit in 4096 bytes                |
| `trustForwardedHost` | `false`                        | Reads the host and protocol from `X-Forwarded-Host` and `X-Forwarded-Proto`                        |

**Sensitive routes.** Add password reset, pay links and similar routes to `excludePaths` so their paths, which can carry tokens, never reach the cookie or the ledger. An entry matches a path whose leading segments equal the entry's segments after percent-decoding, compared case-insensitively: `'/account'` matches `/account` and `/Account/orders` but not `/accountless` or `/shop/account`. It also matches after one leading locale segment such as `/en` or `/pt-br`, so `/en/account/orders` is excluded too. Other prefixes, such as a `basePath`, must be listed in full.

**Token-shaped values.** Independently of `excludePaths`, the landing path is dropped when any segment looks like a token, and when any segment follows a reset, token, verify, confirm, magic, invite, activate or unsubscribe style segment (for example `/reset-password/<token>` or `/en/verify-email/<code>`). A segment looks like a token when it holds an unseparated run of 16 or more letters and digits (hex, base36 or base64url, in any case), or when most of a longer separated run mixes letters and digits, as in a UUID. Referrer hosts with such a label are dropped the same way. UTM values use the same shape test with a 24 character run, so separator-joined names such as `Brand_Search_US_2026_Q3_Exact_Match` are kept whatever their case. The path rule also drops product pages whose slug is a long letter-and-digit code, such as `/p/AB12CD34EF56GH78`; the UTM parameters of such a visit are still kept.

**Payment and sign-in providers** are ignored by domain, so returning from checkout or sign-in does not become a new touch. The built-in list is `stripe.com`, `paypal.com`, `pay.google.com`, `accounts.google.com`, `login.microsoftonline.com`, `appleid.apple.com`, `plaid.com`, `klarna.com`, `affirm.com`, `afterpay.com`, `shop.app`, `squareup.com`, `authorize.net`, `adyen.com`, `cardinalcommerce.com`, `3dsecure.io` and `arcot.com`, each with its subdomains. `ignoreReferrers` adds to that list.

**Site hosts.** Without `siteHosts`, a referrer is internal when it shares the request host's registrable domain, computed without the Public Suffix List: the last two labels, or the last three under a two-letter country code with a common second label such as `co.uk` or `com.au`. Hosts on known shared hosting domains, such as `vercel.app` or `netlify.app`, count only as themselves. Set `siteHosts` when the site lives on another multi-part suffix, on a shared hosting domain, or across deep subdomains that should count as one site. A pattern with a leading dot, such as `.example.com`, matches that domain and all its subdomains; a pattern without one matches that host only.

**Secure.** The cookie is `Secure` when the request URL is `https`. Next derives that URL from `X-Forwarded-Proto`, so a plain-http deployment behind a proxy must not forward that header, or browsers drop the cookie. With `trustForwardedHost`, the plugin also reads `X-Forwarded-Proto` itself.

### Global Privacy Control

Without a `consent` hook, a request with `Sec-GPC: 1` has its ad click ids and `fbc`/`fbp` removed from both touches of the attribution cookie. UTM parameters, the landing path and the referrer are still captured.

A host `consent` hook takes full responsibility for that decision:

- `'denied'` captures nothing new for that request.
- Any other value disables the GPC default, and ad identifiers are captured.
- A hook that throws or rejects counts as `'denied'`. The request still gets the host response, and the attribution cookie loses its ad identifiers instead of failing the page.

Whenever ad consent is denied (`Sec-GPC: 1` without a hook, or a hook returning `'denied'`), the proxy also rewrites an existing cookie without its click ids, `fbc`, `fbp` and click times, on every request path, including internal navigation and direct visits that would otherwise leave the cookie alone. Ad ids captured before the visitor refused therefore do not survive the next matched request. The first touch, UTM parameters, the landing path and the referrer are kept.

<!-- sample: consent-hook.ts -->

```ts
import { attributionProxy } from 'payload-plugin-attribution/next'

// The hook reads the host's consent cookie. It replaces the Sec-GPC default entirely, so it
// must honor Global Privacy Control itself.
export const attribution = attributionProxy({
  consent: (request) => {
    const choice = /(?:^|;\s*)site_consent=(\w+)/.exec(request.headers.get('cookie') ?? '')?.[1]
    if (choice === 'none' || request.headers.get('sec-gpc') === '1') {
      return 'denied'
    }
    return choice === 'all' ? 'granted' : 'unknown'
  },
  siteHosts: ['.example.com'],
})
```

## Browser helper

`payload-plugin-attribution/browser` has no dependencies and is safe to import in client components.

`captureAttribution(options)` returns `{ first, last }`. The last touch combines the attribution cookie's last touch with:

- The GA client id, session id and session number from `gtag('get', ...)`, when `measurementId` is set and `gtag` is loaded. Each value waits at most `timeoutMs` (500 ms by default). It is skipped when `analyticsStorage` is denied.
- The `_fbp` and `_fbc` cookies.
- Consent state from the `consent` callback: `adUserData`, `adPersonalization` and `analyticsStorage`.

Under Global Privacy Control (`navigator.globalPrivacyControl`) without a `consent` callback, the helper omits ad identifiers and marks `adUserData` and `adPersonalization` as denied. With a callback, its values are recorded, and ad identifiers are kept only when it grants `adUserData`. `attributionForSubmit(options)` returns only the last touch and resolves to `{}` instead of throwing.

<!-- sample: submit.ts -->

```ts
import type { BrowserOptions } from 'payload-plugin-attribution/browser'

import { attributionForSubmit } from 'payload-plugin-attribution/browser'

export async function submitLead(
  form: { email: string; message: string; name: string },
  consent?: BrowserOptions['consent'],
): Promise<Response> {
  // Resolves within about half a second and never throws; an empty object is a valid result.
  const attribution = await attributionForSubmit({ consent, measurementId: 'G-XXXXXXXXXX' })
  return fetch('/api/leads', {
    body: JSON.stringify({ ...form, attribution }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
}
```

`trackClient(name, params, { eventId, measurementId })` sends a browser-only GA4 event through `gtag` with an `event_id` and returns that id, or `null` when `gtag` is missing or the name is invalid. Record conversions on the server instead; see [privacy](privacy.md) for `consentDefaults`.

## Server handler

The server reads the cookie again from the request and takes only browser-only fields from the posted attribution: `gaClientId`, `gaSessionId`, `gaSessionNumber`, `fbp`, `consentAdUserData`, `consentAdPersonalization` and `consentAnalyticsStorage`. Click ids, `fbc`, UTM parameters, the referrer and landing data come only from the proxy cookie, and the cookie wins where both have a value. A client can post anything, so taking more would let it forge a click id or undo the proxy's Global Privacy Control stripping. The form post carries `Sec-GPC` as well, so the handler also records ad consent as denied under Global Privacy Control when the browser posted no consent choice, for example when JavaScript did not run.

<!-- sample: lead-route.ts -->

```ts
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
```

`readAttributionCookie(cookieHeader, { cookieName })` returns `{ first, last }` or `null`. When the browser sends several cookies with the same name, the first valid one wins.

Meta's website events need `context.url` and `context.userAgent`. `requestContextFromHeaders` reads the user agent always and the client IP only with `trustProxy: true`, from the last entry of `X-Forwarded-For` (or `ipHeader`), which is the one your nearest proxy appended.

## Separate storefront and backend

When the storefront is its own Next.js app and Payload runs elsewhere:

- Run `attributionProxy` in the storefront. `payload-plugin-attribution/next` does not need Payload.
- Record in the backend, where `recordConversion` has the Payload instance. The storefront's form handler forwards what only it can see: the attribution cookie value, `User-Agent`, `Referer`, `Sec-GPC` and the client address appended by your own proxy. Send them on an authenticated server-to-server call, and never accept them from a public endpoint.
- In the backend, apply the same rules as the [server handler](#server-handler): read attribution with `readAttributionCookie`, take only browser-only fields from the posted attribution, and deny ad consent under `Sec-GPC: 1` when no consent choice was posted.
- When the browser calls the backend directly on another subdomain instead, set `cookieDomain` to the shared parent, such as `example.com`, so the attribution cookie reaches it.

## Other runtimes

`captureFromRequest(request, options)` runs the same capture for any fetch-style `Request` and returns `{ setCookie, touches }`, or `{}` when nothing changed. The `./next` entry imports `next/server`, so `next` must be installed.

<!-- sample: capture-request.ts -->

```ts
import { captureFromRequest } from 'payload-plugin-attribution/next'

// For a fetch-style handler outside Next: capture, then add the cookie to the response.
export async function withAttribution(request: Request, response: Response): Promise<Response> {
  const { setCookie } = await captureFromRequest(request, { siteHosts: ['.example.com'] })
  if (!setCookie) {
    return response
  }
  const headers = new Headers(response.headers)
  headers.append('set-cookie', setCookie)
  headers.set('cache-control', 'private, no-store')
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}
```
