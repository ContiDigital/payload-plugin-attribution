# payload-plugin-attribution

First-party attribution capture and durable conversion delivery for [Payload CMS](https://payloadcms.com) 3.

The plugin records each conversion once, inside your database transaction, in a delivery ledger. Workers then send it to GA4 through the Measurement Protocol, to Google Ads through the Data Manager API or scheduled CSV feeds, and to the Meta Conversions API, with consent policies, eligibility windows, retries and an audit trail per destination. On the storefront, a composed Next.js proxy keeps a first and last touch cookie, and a dependency-free browser helper adds GA identity and consent when a form is submitted. The plugin never manages campaigns, bids, budgets, audiences or conversion actions.

## What it adds

- A conversion ledger: `conversion-events`, `conversion-deliveries` and `conversion-delivery-claims` collections, read-only in the admin.
- `recordConversion` for leads, deposits, purchases, refunds and any GA4 event, with validation, revisions, Google Ads restatements and retractions, and SHA-256 hashing of buyer identifiers at record time.
- Destination handlers for GA4, Google Ads Data Manager, Google Ads adjustment feeds and Meta.
- Payload Jobs tasks that deliver each row and sweep the ledger: recover expired leases, re-dispatch stalled rows and purge identifiers after a retention period. A host queue can replace Payload Jobs.
- Authenticated endpoints for the Google Ads conversion and adjustment CSVs, redelivery and a health report.
- A delivery status column and a deliveries panel with resend on every conversion event.
- `attributionProxy` for Next.js, browser helpers for GA identity, consent defaults and event ids, and `attributionField` to store attribution on your own collections.
- `setupGa4Property` and `verifyDestination` to prepare a GA4 property and check a recorded event against each destination without delivering it.

The host supplies credentials, authorization, the recording calls, consent signals and the process that runs the queue.

## Requirements

- Payload `^3.84.1` with database transactions: Postgres (recommended), MongoDB on a replica set, or SQLite for development. See [database](docs/installation.md#database).
- Node.js `>=22.12.0`.
- Next.js `>=15.2.9 <17` for `payload-plugin-attribution/next`, the same floor as Payload's own Next.js packages.
- React 19 and `@payloadcms/ui` for the admin components.
- ESM only. The single runtime dependency is `google-auth-library`.

## Destination readiness

| Destination              | Implementation                                                                                                                  | Release guidance                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| GA4 Measurement Protocol | Events with client id, session join and consent; optional user-provided data; validation server check; Admin API property setup | Live canary pending until recorded in [RELEASING.md](RELEASING.md). Confirm events in DebugView on a test property before sending production traffic. |
| Google Ads Data Manager  | Conversion ingest with one click id and hashed user data, consent signals, `validateOnly` check                                 | Live canary pending until recorded in [RELEASING.md](RELEASING.md). Send a `validateOnly` request for your own account first.                         |
| Google Ads feeds         | Basic-auth conversion and adjustment CSVs for scheduled uploads; restatement and retraction windows                             | Live canary pending until recorded in [RELEASING.md](RELEASING.md). Check both files in the Google Ads upload preview before scheduling them.         |
| Meta Conversions API     | Server events with `event_id` for pixel deduplication, Limited Data Use, test event codes                                       | Live canary pending until recorded in [RELEASING.md](RELEASING.md). Confirm events in Test Events with a `test_event_code` first.                     |

CI tests use local mock providers. Opt-in live validation checks and their evidence are recorded in [RELEASING.md](RELEASING.md); validation does not establish ingestion or matching. Provider approval, quotas and policy compliance are the host's responsibility.

## Install

```bash
pnpm add payload-plugin-attribution
```

## Minimal configuration

<!-- sample: payload.config.ts -->

```ts
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig } from 'payload'
import { attributionPlugin } from 'payload-plugin-attribution'

export default buildConfig({
  db: postgresAdapter({ pool: { connectionString: process.env.DATABASE_URL } }),
  // Runs the plugin's queue every minute and enqueues the scheduled sweep.
  jobs: { autoRun: [{ cron: '* * * * *', queue: 'attribution' }] },
  plugins: [
    attributionPlugin({
      destinations: {
        ga4: {
          apiSecret: process.env.GA4_API_SECRET ?? '',
          measurementId: process.env.GA4_MEASUREMENT_ID ?? '',
        },
      },
      secret: process.env.ATTRIBUTION_SECRET ?? '',
      sweep: { cron: '*/10 * * * *' },
    }),
  ],
  secret: process.env.PAYLOAD_SECRET ?? '',
})
```

Literal settings are checked when the config is built, so an empty `secret` or `measurementId` throws at startup. [Installation](docs/installation.md) covers function settings, authorization, identity resolution and every option.

The plugin adds collections and admin components. Regenerate the import map, then create and apply a migration on Postgres or SQLite:

```bash
pnpm payload generate:importmap
pnpm payload migrate:create attribution
pnpm payload migrate
```

## Capture on the storefront

Compose the attribution proxy last. The matcher's `missing` clause is required. On Next 16, in `proxy.ts`, export `proxy`:

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

On Next 15, in `middleware.ts`, the same code must export `middleware`. Next 15 does not load an export named `proxy`, and every matched request would fail with HTTP 500:

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

At submit time, the browser helper adds the GA client id, session and consent state to the form:

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

The server reads the proxy cookie again and lets it win over posted attribution. [Web capture](docs/web-capture.md) shows that route handler and every capture rule.

## Recording conversions

<!-- sample: recording.ts -->

```ts
import type { Payload, PayloadRequest } from 'payload'
import type { Attribution, ConversionDraft } from 'payload-plugin-attribution'

import { recordConversion } from 'payload-plugin-attribution'

export type Order = {
  attribution?: Attribution
  currency: string
  email: string
  lines: Array<{ name: string; quantity: number; sku: string; unitPriceCents: number }>
  number: string
  paidAt: string
  totalCents: number
}

// A deposit is the order's first Google Ads sale, valued at the amount paid.
export const recordDeposit = (
  payload: Payload,
  order: Order,
  deposit: { cents: number; paidAt: string },
  req?: PayloadRequest,
) =>
  recordConversion({
    draft: {
      name: 'deposit_paid',
      attribution: order.attribution,
      buyer: { email: order.email },
      currency: order.currency,
      eventKey: `order:${order.number}:deposit`,
      googleAds: { action: 'sale' },
      occurredAt: deposit.paidAt,
      transactionId: order.number,
      valueCents: deposit.cents,
    },
    payload,
    req,
  })

// After a deposit, the purchase becomes a Google Ads restatement to the full order value.
export const purchaseDraft = (order: Order): ConversionDraft => ({
  name: 'purchase',
  attribution: order.attribution,
  buyer: { email: order.email },
  currency: order.currency,
  eventKey: `order:${order.number}:purchase`,
  googleAds: { action: 'sale' },
  items: order.lines.map((line) => ({
    item_id: line.sku,
    item_name: line.name,
    price: line.unitPriceCents / 100,
    quantity: line.quantity,
  })),
  occurredAt: order.paidAt,
  transactionId: order.number,
  valueCents: order.totalCents,
})

export const recordPurchase = (payload: Payload, order: Order, req?: PayloadRequest) =>
  recordConversion({ draft: purchaseDraft(order), payload, req })

// valueCents is the amount refunded to GA4; remainingCents is the sale value Google Ads keeps.
export const recordRefund = (
  payload: Payload,
  order: Order,
  refund: { id: string; refundedAt: string; refundedCents: number; remainingCents: number },
  req?: PayloadRequest,
) =>
  recordConversion({
    draft: {
      name: 'refund',
      currency: order.currency,
      eventKey: `order:${order.number}:refund:${refund.id}`,
      googleAds:
        refund.remainingCents > 0
          ? { action: 'sale', adjustedValueCents: refund.remainingCents, kind: 'restatement' }
          : { action: 'sale', kind: 'retraction' },
      occurredAt: refund.refundedAt,
      transactionId: order.number,
      valueCents: refund.refundedCents,
    },
    payload,
    req,
  })
```

Pass the request `req` to join its transaction: the event, its delivery rows and the queued jobs then commit or roll back with your own writes. `recordConversion` returns the stored event, or `null` when the draft is invalid or the plugin is disabled. [Recording](docs/recording.md) covers validation, revisions, values and Google Ads treatment.

## Workers

By default, `payloadJobsDispatcher` registers the `attributionDeliver` and `attributionSweep` tasks and queues one delivery job per row on the `attribution` queue. The host runs that queue, with `jobs.autoRun` as above or a separate worker process. `sweep.cron` schedules the sweep on the same queue.

A host queue replaces this with the `dispatcher` option: its worker calls `runDelivery` for each message, and a scheduler calls `sweepDeliveries`. [Workers](docs/workers.md) covers both, plus redelivery and backfill.

## Endpoints

Paths are relative to Payload's `/api` route and the default `apiBasePath` of `/attribution`.

| Method | Path                                      | Access                                                                                |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| GET    | `/attribution/google-ads/conversions.csv` | HTTP Basic feed credentials; 404 unless `transport` is `feed`                         |
| GET    | `/attribution/google-ads/adjustments.csv` | HTTP Basic feed credentials; 404 unless `adjustments.enabled`                         |
| POST   | `/attribution/events/:id/redeliver`       | `authorize` scope `operate`; body `{ "destinations": ["meta"], "force": false }`      |
| GET    | `/attribution/health`                     | `authorize` scope `read`; delivery counts by status, expired leases, recent dead rows |

A host endpoint with the same method and path wins, and the plugin logs a warning.

## Access and privacy

- `authorize({ req, scope })` gates three scopes: `read` for the ledger and health report, `operate` for redelivery, and `pii` for hashed identifiers, request context and provider request bodies. By default, users of the admin user collection get `read` and `operate`, and nobody gets `pii`.
- Nobody can create, update or delete ledger rows through Payload access control; only the plugin writes them.
- Buyer identifiers are normalized and SHA-256 hashed when an event is recorded. The raw buyer object is not stored.
- The sweep clears identifiers, request context and provider request bodies after `privacy.identifierRetentionDays` (90 by default).
- Without a host consent hook, `Sec-GPC: 1` keeps ad click ids out of the attribution cookie.

See [privacy](docs/privacy.md) and the [security policy](SECURITY.md).

## Programmatic API

`payload-plugin-attribution` (server):

| Export                      | Purpose                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `attributionPlugin`         | The Payload plugin: collections, tasks, endpoints and admin components                           |
| `attributionField`          | A read-only, sanitized attribution group field for host collections                              |
| `recordConversion`          | Validates a conversion draft, stores or revises the event and plans its deliveries               |
| `runDelivery`               | Claims one delivery row, calls its destination and settles the outcome                           |
| `sweepDeliveries`           | Recovers expired leases, closes expired waits, re-dispatches stalled rows and purges identifiers |
| `redeliverConversion`       | Creates a new delivery attempt for chosen destinations of one event                              |
| `payloadJobsDispatcher`     | The default dispatcher, backed by Payload Jobs                                                   |
| `setupGa4Property`          | Lists, and with `apply` creates, the custom dimensions and key events a GA4 property is missing  |
| `verifyDestination`         | Checks a recorded event against one destination with validation-only requests or local rendering |
| `requestContextFromHeaders` | Reads the user agent, and the client IP behind a trusted proxy, from request headers             |

The root entry also exports these types: `AttributionPluginOptions`, `Ga4DestinationOptions`, `GoogleAdsDestinationOptions`, `GoogleAdsFeedOptions`, `MetaDestinationOptions`, `MetaEventMapping`, `MetaActionSource`, `ProviderEndpoints`, `Setting`, `AuthorizeFn`, `AuthorizeScope`, `ResolvedIdentity`, `BuyerIdentity`, `ConversionDraft`, `Ga4Item`, `EventSource`, `GoogleAdsAction`, `GoogleAdsKind`, `ConsentPolicy`, `ConsentState`, `Attribution`, `PropertyPlan`, `Ga4KeyEventCountingMethod`, `Destination`, `DeliveryStatus`, `DeliverySummary`, `ConversionEventDoc`, `DeliveryDoc`, `DeliveryResult`, `DeliveryLookup`, `DestinationHandler`, `DestinationOutcome`, `AttributionDispatcher`, `OriginalConversion`, `GoogleIdentifiers`, `MetaIdentifiers`, `NormalizedOptions`, `NormalizedGa4Options`, `NormalizedGoogleAdsOptions` and `NormalizedMetaOptions`.

`payload-plugin-attribution/next` (edge-safe; needs `next`):

| Export                  | Purpose                                                                           |
| ----------------------- | --------------------------------------------------------------------------------- |
| `attributionProxy`      | Next.js proxy that updates the first and last touch cookie on a composed response |
| `captureFromRequest`    | The same capture for any fetch-style `Request`, returning a `Set-Cookie` value    |
| `readAttributionCookie` | Decodes the first and last touch from a `Cookie` header                           |
| `CaptureOptions` (type) | Options for both capture functions                                                |

`payload-plugin-attribution/browser` (no dependencies):

| Export                  | Purpose                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `captureAttribution`    | Reads the touch cookie, GA identity, Meta browser ids and consent into `{ first, last }` |
| `attributionForSubmit`  | The last touch from `captureAttribution` for a form submit; never throws                 |
| `consentDefaults`       | Queues Google consent mode defaults before `gtag.js` loads                               |
| `trackClient`           | Sends a browser-only GA4 event through `gtag` with an `event_id`                         |
| `createEventId`         | A UUID for pairing a browser event with its server event                                 |
| `sanitizeAttribution`   | Validates and bounds an untrusted attribution object                                     |
| `Attribution` (type)    | One touch                                                                                |
| `Touches` (type)        | `{ first, last }`                                                                        |
| `ConsentState` (type)   | `'granted' \| 'denied' \| 'unknown'`                                                     |
| `BrowserOptions` (type) | Options for `captureAttribution` and `attributionForSubmit`                              |

`payload-plugin-attribution/client` (admin components, referenced by the collections):

| Export               | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `DeliveryStatusCell` | List cell showing each destination's latest status        |
| `DeliveriesPanel`    | Conversion event panel listing delivery rows, with resend |

## Documentation

- [Installation and configuration](docs/installation.md)
- [Recording conversions](docs/recording.md)
- [Web capture](docs/web-capture.md)
- [GA4](docs/ga4.md)
- [Google Ads](docs/google-ads.md)
- [Meta](docs/meta.md)
- [Workers, redelivery and backfill](docs/workers.md)
- [Privacy](docs/privacy.md)
- [Migrating from a host-owned ledger](docs/migration.md)
- [Architecture decisions](docs/decisions/)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Releasing](RELEASING.md)
- [Changelog](CHANGELOG.md)

## License

MIT
