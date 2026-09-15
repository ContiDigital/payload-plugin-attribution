# ADR 0004: Storefront capture in a composed Next proxy with a first and last touch cookie and GPC defaults

- Status: Accepted
- Date: 2026-09-15
- Owners: Maintainers

## Context

Click ids and UTM parameters arrive on the landing request and are gone by the time a visitor submits a form or pays. Browser scripts capture them late, only when JavaScript runs, and lose them to ad blockers and short script-set cookie lifetimes. Hosts already have their own Next.js proxy for redirects, headers and sessions, and Next allows one proxy per app.

Attribution touches personal data and advertising identifiers, so capture must respect Global Privacy Control without a consent platform, and let a host that has one make the decision instead.

## Decision

1. Capture on the server in a function, `attributionProxy`, that the host composes into its own proxy and passes its response to.
2. Store a first touch and a last touch in one first-party cookie written from the server, bounded in size, expiring 90 days after the latest click or capture.
3. Treat internal navigation, payment and sign-in returns, prefetches and later direct visits as non-touches.
4. Remove ad click ids and Meta browser ids when a request carries `Sec-GPC: 1`, unless the host supplies a `consent` hook, which then decides alone.
5. Mark responses that write the cookie `Cache-Control: private, no-store`.
6. Add browser-only data (GA client id, session id and number, `fbp` and consent) at submit time with a dependency-free helper. The server takes only those fields from posted values; click ids, `fbc`, UTMs, referrer and landing data come only from the cookie.

## Rationale

- The landing request is the one place every click id is visible, before any script or redirect.
- Composition keeps the host's proxy logic and lets the plugin append its cookie without owning the proxy.
- First and last touch cover both acquisition and conversion reporting while keeping the cookie small.
- A privacy-preserving default protects hosts that have not integrated a consent platform yet.
- Private caching prevents one visitor's tracking parameters from being served to another from a shared cache.

## Consequences

- The attribution proxy must run last; a later `response.cookies.set` drops its cookie.
- The matcher must exclude prefetch requests, because Next strips their headers before the proxy runs.
- The cookie is readable only from the next request, not while rendering the landing request.
- The cookie is not `HttpOnly`, so the browser helper can read it; it contains no identity.
- Sites on shared hosting domains or multi-part public suffixes set `siteHosts`, because the registrable domain rule does not use the Public Suffix List.

## Alternatives rejected

- **Browser-only capture:** misses visitors without JavaScript or with blockers, and cannot set long-lived first-party cookies reliably.
- **Owning the whole proxy:** conflicts with every host that already has one.
- **Last touch only:** loses the acquisition source a first touch preserves.
- **Server sessions:** add storage and session management the host may not have, for data a cookie carries.
- **No GPC default:** leaves hosts without a consent platform capturing advertising identifiers against an explicit browser signal.
