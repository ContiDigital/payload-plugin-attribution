# Installation and configuration

This guide wires `payload-plugin-attribution` into a Payload 3 project: the database it needs, every plugin option, authorization, identity resolution, and checking destinations before real traffic flows.

## Install

```bash
pnpm add payload-plugin-attribution
```

The package is ESM only and requires Node.js `>=22.12.0` and Payload `^3.84.1`. `payload-plugin-attribution/next` requires Next.js `>=15.2.9 <17`, the floor Payload's own Next.js packages require; the admin components require React 19 and `@payloadcms/ui`.

## Database

The plugin writes events, delivery rows and claims in transactions and locks rows with a unique lock key, so database transactions are required. It throws when they are off: `database transactions must be enabled` when it opens its own transaction, and `row locks require a transaction` when it needs a lock.

- **Postgres** is recommended for production.
- **SQLite** is for development only. Payload's SQLite adapter has transactions off unless `transactionOptions` is set. SQLite allows one writer, so the plugin serializes its own transactions within each process. It is not safe with concurrent host writes: Payload's SQLite adapter reports a failed COMMIT as success, so each plugin-owned transaction writes a marker row and confirms it after commit, and throws instead of returning ids for rows that were never stored. Under concurrent host writes those plugin calls fail (`recordConversion` rejects, a delivery stays `sending` until the sweep retries it). Production should use Postgres or MongoDB.
- **MongoDB** works with the caveats below and needs a replica set. Payload's MongoDB adapter turns transactions off when the connection has no `replicaSet`, and the plugin then throws. A single node can run as a one-member replica set.

<!-- sample: databases.ts -->

```ts
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'

// Recommended for production.
export const postgres = postgresAdapter({ pool: { connectionString: process.env.DATABASE_URL } })

// Development only. SQLite transactions are off unless transactionOptions is set.
export const sqlite = sqliteAdapter({ client: { url: 'file:./local.db' }, transactionOptions: {} })

// Transactions need a replica set; a single node can run as a one-member replica set.
export const mongodb = mongooseAdapter({
  url: 'mongodb://127.0.0.1:27017/app?replicaSet=rs0',
})
```

On Postgres and SQLite, a competing writer waits on the row lock until the first transaction ends. On MongoDB, the row lock turns a competing writer into an error instead of a wait:

- A delivery claim that hits a MongoDB `WriteConflict` (code 112) counts as lost to the other worker. Only code 112 counts; other transient transaction errors, such as network errors, stepdowns and `NoSuchTransaction`, propagate.
- `recordConversion` in its own transaction retries once, after a 100 to 250 ms wait, on code 112 or on a duplicate first record of the same `eventKey`. A second conflict propagates. Inside a host transaction, conflicts propagate with no retry.
- Sweeps and redelivery raise the error instead of waiting.
- Duplicate `eventKey` detection on MongoDB matches Payload's English unique-value message. With a translated message, a duplicate first record raises a validation error instead of being retried.

CI runs the integration suites on SQLite, Postgres 17 and a MongoDB 8 replica set.

## Configure the plugin

A production configuration usually keeps secrets in functions and splits destinations into their own modules:

<!-- sample: installation-config.ts -->

```ts
import type { AttributionPluginOptions } from 'payload-plugin-attribution'

import { authorize } from './authorize.js'
import { ga4 } from './ga4-options.js'
import { dataManager } from './google-ads.js'
import { meta } from './meta.js'

export const attributionOptions: AttributionPluginOptions = {
  adminGroup: 'Marketing',
  apiBasePath: '/attribution',
  authorize,
  destinations: { ga4, googleAds: dataManager, meta },
  // Keeps the collections in the schema with no endpoints, tasks or deliveries.
  disabled: process.env.ATTRIBUTION_DISABLED === 'true',
  identity: {
    defaultPhoneCountry: 'US',
    resolve: async ({ customerId, payload, req }) => {
      const customer = await payload.findByID({
        id: customerId,
        collection: 'customers',
        depth: 0,
        disableErrors: true,
        req,
      })
      if (!customer) {
        return null
      }
      return {
        email: typeof customer.email === 'string' ? customer.email : null,
        marketingConsent: customer.marketingOptIn === true,
        userId: String(customer.id),
      }
    },
  },
  maxAttempts: 6,
  policy: { formLeadValueCents: 2500, leadValuePercent: 5 },
  privacy: { identifierRetentionDays: 90 },
  queue: 'attribution',
  // Function settings resolve at first use, so builds and migrations run without secrets.
  secret: () => process.env.ATTRIBUTION_SECRET ?? '',
  sweep: { cron: '*/10 * * * *' },
}
```

Pass it to the plugin with `plugins: [attributionPlugin(attributionOptions)]`. One plugin instance is allowed per Payload config; applying a second throws.

| Option                            | Default                              | Purpose                                                                                                                |
| --------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `secret`                          | Required unless `disabled`           | Seeds the pseudonymous GA4 client id for events without a captured one. Keep it stable: changing it changes those ids. |
| `destinations.ga4`                | None                                 | [GA4](ga4.md) options                                                                                                  |
| `destinations.googleAds`          | None                                 | [Google Ads](google-ads.md) options                                                                                    |
| `destinations.meta`               | None                                 | [Meta](meta.md) options                                                                                                |
| `authorize`                       | Admin users get `read` and `operate` | Gates the ledger, endpoints and personal data                                                                          |
| `dispatcher`                      | `payloadJobsDispatcher()`            | Hands delivery rows to a worker. See [workers](workers.md)                                                             |
| `queue`                           | `'attribution'`                      | Payload Jobs queue for delivery tasks                                                                                  |
| `sweep.cron`, `sweep.queue`       | Not scheduled; `queue`               | Schedules the sweep task with a 5 or 6 field cron                                                                      |
| `maxAttempts`                     | `6`                                  | Attempts before a delivery is `dead`                                                                                   |
| `identity.resolve`                | None                                 | Looks up a buyer and user id from a draft's `customerId`                                                               |
| `identity.defaultPhoneCountry`    | None                                 | Two-letter country for phone numbers without a `+` prefix                                                              |
| `policy.leadValuePercent`         | `5`                                  | Percent of `listPriceCents` used as a lead's value. See [recording](recording.md#values)                               |
| `policy.formLeadValueCents`       | `0`                                  | Value of a lead with neither `valueCents` nor `listPriceCents`                                                         |
| `privacy.identifierRetentionDays` | `90`                                 | Days before the sweep purges identifiers. See [privacy](privacy.md)                                                    |
| `apiBasePath`                     | `'/attribution'`                     | Prefix for the plugin's endpoints under Payload's `/api`                                                               |
| `adminGroup`                      | `'Marketing'`                        | Admin navigation group for the ledger collections                                                                      |
| `collections`                     | Default slugs                        | Slugs for the ledger collections. See [collection slugs](#collection-slugs)                                            |
| `endpoints`                       | Provider origins                     | Replaces provider base URLs, for mock providers                                                                        |
| `disabled`                        | `false`                              | Keeps the schema and turns everything else off                                                                         |

### Collection slugs

The ledger collections are `conversion-events`, `conversion-deliveries` and `conversion-delivery-claims` by default. A host that already uses one of those names, or their tables, sets other slugs:

- `collections.events.slug`, `collections.deliveries.slug` and `collections.claims.slug` each replace one default. A slug starts with a letter and holds only letters, digits, `-` and `_`.
- Every lookup, join, endpoint, admin component, feed, sweep and job uses the configured slugs. Delivery and feed behavior does not change.
- Choose slugs before the first migration. Changing them later creates new collections and tables; the plugin does not move existing rows.

At startup the plugin throws when a host collection already has one of its slugs, or maps to the same database table. Postgres and SQLite name a table after the slug in snake case, so a host `conversionEvents` collection and the plugin's `conversion-events` would share the table `conversion_events`. An explicit `dbName` on the host collection counts as its table name.

### Settings

Credentials and ids have the `Setting` type: a string, or a function returning a string or a promise of one.

- A literal string is checked when the config is built. An enabled destination with an empty required literal throws.
- A function is resolved each time a delivery needs it, so `payload generate:types` and migrations run without secrets. A function that resolves to an empty string withholds the delivery with reason `not_configured`. A function that throws or rejects, for example during a secret manager outage, is an infrastructure failure: the delivery is retried with backoff and reason `settings_unavailable` (bounded by `maxAttempts`), `verifyDestination` reports `settings_unavailable`, and the feed endpoints answer `503` with `Retry-After`.

Set `enabled: false` on a destination to keep its options in the config without validating or delivering them.

### Authorization

`authorize({ req, scope })` returns a boolean or a promise of one. A callback that throws denies the request.

| Scope     | Grants                                                                                     |
| --------- | ------------------------------------------------------------------------------------------ |
| `read`    | Reading `conversion-events` and `conversion-deliveries`, and `GET /api/attribution/health` |
| `operate` | `POST /api/attribution/events/:id/redeliver` and the resend action in the deliveries panel |
| `pii`     | The `identifiers` and `context` fields of events and the `request` field of deliveries     |

Without `authorize`, users of the collection named by `admin.user` get `read` and `operate`, and nobody gets `pii`. Create, update and delete are denied to everyone; the plugin writes the ledger with `overrideAccess`.

<!-- sample: authorize.ts -->

```ts
import type { AuthorizeFn } from 'payload-plugin-attribution'

// read: the ledger and health report. operate: redelivery. pii: hashed identifiers, request
// context and provider request bodies.
export const authorize: AuthorizeFn = ({ req, scope }) => {
  const roles = (req.user as { roles?: unknown } | null)?.roles
  const hasRole = (role: string): boolean => Array.isArray(roles) && roles.includes(role)
  if (scope === 'pii') {
    return hasRole('admin')
  }
  return hasRole('admin') || hasRole('marketing')
}
```

### Identity resolution

When a draft carries `customerId` and `identity.resolve` is set, the resolver returns `null` or a `ResolvedIdentity`: buyer fields such as `email` and `phone`, a `userId` sent to GA4 as `user_id`, optional `userProperties` for GA4, and optional `marketingConsent`. Fields in the draft's own `buyer` win over resolved ones. An invalid `userId` makes `recordConversion` return `null`.

The resolver runs before the plugin opens its own transaction. When `recordConversion` joins a host transaction, the resolver runs inside it with that `req`.

### Disabled mode

With `disabled: true`, the collections stay in the schema, hidden and denied to everyone, so migrations do not drop them. No endpoints or tasks are registered, `secret` and `destinations` may be omitted, and:

- `recordConversion` returns `null`.
- `runDelivery` leaves rows unchanged and reports reason `plugin_disabled`.
- `sweepDeliveries` and `redeliverConversion` do nothing.

### Provider endpoints

`endpoints` replaces provider base URLs for local mock providers in development and tests: `dataManager`, `ga4` (Measurement Protocol, replacing `euEndpoint`), `ga4Admin` and `meta`. Each value must be an `https` URL, or an `http` URL on `localhost`, `127.0.0.1` or `[::1]`, without credentials, query or fragment. Anything else throws when the config is built.

## Collections and admin

| Slug                         | Contents                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `conversion-events`          | One row per `eventKey`: the latest revision, consent, hashed identifiers, delivery summary |
| `conversion-deliveries`      | One row per destination attempt sequence, with status, reason, timings and provider bodies |
| `conversion-delivery-claims` | Claim and lock keys; never edited by hand                                                  |

These are the default slugs; see [collection slugs](#collection-slugs) to change them.

The conversion events list shows each destination's latest status, and each event has a deliveries panel with resend. These components load from `payload-plugin-attribution/client`, so run `payload generate:importmap` after installing or upgrading.

`attributionField(name = 'attribution')` adds the same sanitized, read-only attribution group to a host collection. Values written to it pass through `sanitizeAttribution`; an explicit `null` clears a stored value.

## Queue and sweep

With the default dispatcher, deliveries run only when something runs the `attribution` queue. See [workers](workers.md) before deploying. A configuration that sets `sweep.cron` but has no sweep task carrying that schedule, such as one with a custom dispatcher, throws when the config is built.

## Verify before enabling

`verifyDestination` checks one recorded event against one destination and never creates a delivery row:

<!-- sample: verify.ts -->

```ts
import type { Payload } from 'payload'
import type { Destination } from 'payload-plugin-attribution'

import { verifyDestination } from 'payload-plugin-attribution'

const destinations: Destination[] = ['ga4', 'googleAds', 'googleAdsAdjustment', 'meta']

// Checks one recorded event against every destination without delivering it.
export const verifyEvent = (payload: Payload, eventId: number | string) =>
  Promise.all(
    destinations.map(async (destination) => ({
      destination,
      ...(await verifyDestination({ destination, eventId, payload })),
    })),
  )
```

It returns `{ ok, details }`. What it sends differs per destination and is described in [GA4](ga4.md#verification), [Google Ads](google-ads.md#verification) and [Meta](meta.md#verification). The repository's command line script wraps it; see [GA4 command line](ga4.md#command-line).
