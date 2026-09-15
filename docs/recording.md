# Recording conversions

`recordConversion({ draft, payload, req })` validates a conversion draft, stores or revises its event, and plans one delivery row per destination.

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

## Return value

`recordConversion` returns the stored event:

- The new event, or the revised event for a higher `revision`.
- The stored event unchanged when the same `eventKey` was already recorded at the same or a higher revision. This is a replay and plans nothing.
- The existing purchase when another `eventKey` already recorded a `purchase` for the same `transactionId`.

It returns `null`, and logs a warning with the reason where there is one, when:

- The plugin is disabled.
- The draft is invalid, for example `invalid_event_key` or `invalid_purchase`.
- A revision changes the event's `name`, `transactionId` or `occurredAt`.
- A refund has no earlier purchase.
- The identity resolver returns an invalid `userId`.

Database errors are thrown.

## Transactions

When `req` carries a transaction, `recordConversion` joins it. The event, its delivery rows and, with Payload Jobs, the queued delivery jobs commit or roll back with the host's writes. Payload opens a transaction for each request, so a collection hook's `req` is the usual choice:

<!-- sample: orders-collection.ts -->

```ts
import type { CollectionConfig } from 'payload'

import { attributionField, recordConversion } from 'payload-plugin-attribution'

type OrderDoc = { email?: string; id: number | string; number: string; totalCents: number }

export const Orders: CollectionConfig = {
  slug: 'orders',
  fields: [
    { name: 'number', type: 'text', required: true, unique: true },
    { name: 'status', type: 'select', defaultValue: 'open', options: ['open', 'paid'] },
    { name: 'totalCents', type: 'number', required: true },
    { name: 'email', type: 'email' },
    attributionField(),
  ],
  hooks: {
    afterChange: [
      async ({ doc, previousDoc, req }) => {
        if (doc.status !== 'paid' || previousDoc?.status === 'paid') {
          return doc
        }
        const order = doc as OrderDoc
        // req carries the request transaction: the event and its deliveries commit or roll
        // back together with the order.
        await recordConversion({
          draft: {
            name: 'purchase',
            attribution: doc.attribution,
            buyer: { email: order.email },
            eventKey: `order:${order.number}:purchase`,
            googleAds: { action: 'sale' },
            items: [{ item_id: order.number, item_name: 'Order', quantity: 1 }],
            occurredAt: new Date().toISOString(),
            subject: { id: order.id, collectionSlug: 'orders' },
            transactionId: order.number,
            valueCents: order.totalCents,
          },
          payload: req.payload,
          req,
        })
        return doc
      },
    ],
  },
}
```

Without a transaction on `req`, the plugin opens its own and dispatches after it commits. A failed dispatch is logged, and the sweep re-dispatches the row.

## Revisions

Recording an `eventKey` again with a higher `revision` replaces the event. The draft is a full snapshot: fields it leaves out are cleared, not kept. Open delivery rows of the previous revision become `superseded`, and delivery is planned again for the new one. Whether a destination sends a revision again is its own option; see [GA4](ga4.md) and [Meta](meta.md).

<!-- sample: revision.ts -->

```ts
import type { Payload } from 'payload'

import { recordConversion } from 'payload-plugin-attribution'

import type { Order } from './recording.js'

import { purchaseDraft } from './recording.js'

// A corrected order replaces the recorded purchase. The draft is a full snapshot: fields left
// out are cleared, and name, transactionId and occurredAt must stay the same.
export const recordCorrectedPurchase = (payload: Payload, order: Order, revision: number) =>
  recordConversion({ draft: { ...purchaseDraft(order), revision }, payload })
```

- A revision cannot change `name`, `transactionId` or `occurredAt`; such a draft returns `null`.
- An equal or lower revision is a replay and returns the stored event. A lower revision recorded after a higher one therefore never overwrites it.
- Concurrent recordings of one `eventKey` are serialized by a row lock, so the higher revision wins whichever commits first.
- Two concurrent first recordings of a new `eventKey` race on its unique index. When the plugin owns the transaction, the loser retries once and the retry becomes a replay or a revision. Inside a host transaction, the loser raises the unique-conflict error and the host's transaction fails; retry the whole host operation, and the retry becomes a replay.

MongoDB changes how these conflicts surface; see [database](installation.md#database).

## Draft fields

| Field                       | Purpose                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `name`                      | GA4 event name, such as `purchase`, `generate_lead` or `refund`                                      |
| `eventKey`                  | Your stable, unique key for this business event                                                      |
| `occurredAt`                | When it happened, as an ISO 8601 string                                                              |
| `revision`                  | Positive integer, default `1`                                                                        |
| `eventId`                   | Id shared with a browser event, default `eventKey`. See [Meta](meta.md#deduplication-with-the-pixel) |
| `transactionId`             | Order or lead reference; required for purchases, refunds and Google Ads                              |
| `valueCents`                | Value in minor units                                                                                 |
| `taxCents`, `shippingCents` | Sent to GA4                                                                                          |
| `listPriceCents`            | Basis for a lead's value                                                                             |
| `currency`                  | ISO 4217 code, default `USD`                                                                         |
| `items`                     | GA4 items                                                                                            |
| `params`                    | Extra GA4 event parameters                                                                           |
| `channel`                   | Sales channel label, sent to GA4 as `sales_channel`                                                  |
| `eventSource`               | `WEB`, `PHONE`, `IN_STORE` or `OTHER` (default)                                                      |
| `attribution`               | The touch to attribute, usually the proxy cookie's last touch                                        |
| `buyer`                     | Email, phone, names, address and external id; hashed on record                                       |
| `customerId`                | Passed to `identity.resolve`                                                                         |
| `consent`                   | `adUserData`, `adPersonalization`, `analyticsStorage`. See [privacy](privacy.md#consent)             |
| `context`                   | `ipAddress`, `userAgent` and page `url`                                                              |
| `googleAds`                 | `{ action, kind, adjustedValueCents }`. See below                                                    |
| `destinations`              | `{ meta: false }` skips planning a destination for this event                                        |
| `subject`                   | `{ collectionSlug, id }` of the host document, for reference                                         |

## Validation

- **`name`** starts with a letter, has only letters, digits and underscores, is at most 40 characters, does not start with `firebase_`, `ga_` or `google_`, and is not a name GA4 reserves, such as `session_start`.
- **`eventKey`** is 1 to 200 characters, starts with a letter or digit, and continues with letters, digits, `_`, `.`, `:` or `-`. **`transactionId`** follows the same rule with at most 64 characters. Neither may be a 64-character hex string, which looks like a hash.
- **`eventId`** is 1 to 128 letters, digits, `_`, `.`, `:` or `-`.
- **Money** fields are non-negative safe integers in minor units.
- **Currencies** use ISO 4217 minor units: `USD` values are cents, `JPY` values are yen, `KWD` values are fils. `currency` must be an active ISO 4217 code in uppercase; any other value, such as `usd` or `ABC`, makes `recordConversion` return `null` with reason `invalid_currency`.
- **`items`** has at most 200 entries. Each has an `item_id` or `item_name`, at most 42 keys, string values without `@`, and non-negative numbers. Prices are GA4 major units, not minor units.
- **`params`** names follow the `name` rule, cannot be `currency`, `engagement_time_msec`, `items`, `session_id`, `shipping`, `tax`, `timestamp_micros`, `transaction_id`, `user_id` or `value`, and values are booleans, finite numbers or strings without `@`.
- **`context`**: `ipAddress` is an IPv4 or IPv6 address, `url` is `http` or `https` and is stored as its origin and path only, without the query string or fragment (a path that looks like it carries a token or an email address is reduced to the origin), `userAgent` is at most 1,024 characters without control characters.
- **`buyer`** values are strings or `null`.
- A **`purchase`** needs `transactionId`, `valueCents` and at least one item. A **`refund`** needs `transactionId`.

## Values

A draft's `valueCents` is used as given. A `generate_lead` without one is valued at `listPriceCents` times `policy.leadValuePercent` (5 by default) percent, rounded, or else `policy.formLeadValueCents` (0 by default). A Google Ads retraction other than a refund is recorded with a value of 0.

## Google Ads treatment

`googleAds.action` is `lead`, `sale` or `none`, and `kind` is `auto` (default), `conversion`, `restatement`, `retraction` or `none`. Without `googleAds`, the event never reaches Google Ads. Any action other than `none` needs a `transactionId`.

`auto` and `conversion` resolve against earlier events with the same `transactionId` and action:

- With no earlier conversion under another `eventKey`, the event is the order's `conversion`.
- With one, a `purchase` becomes a `restatement` of that conversion to the purchase value, and any other event becomes `none`.

That is how the deposit and purchase above work: the deposit is the conversion, and the purchase restates it to the full order value. An explicit `restatement`, `retraction` or `none` is kept as given. [Google Ads](google-ads.md) describes delivery, feeds and adjustment windows.

## Purchases and refunds

- One `purchase` is kept per `transactionId`. A purchase with another `eventKey` returns the existing one.
- Two recordings of one order under different `eventKey`s are serialized by a claim row with a unique key. Inside host transactions on Postgres, the losing recording's unique violation aborts its host transaction, so retry that transaction; it then returns the existing purchase.
- A claim left by a purchase that no longer exists, for example after the event was deleted by hand, makes `recordConversion` throw a `PluginError` with status 409 that names the `transactionId`. Delete the matching `conversion-delivery-claims` row to record the purchase again.
- A `refund` needs a purchase with the same `transactionId` that occurred no later than the refund. When the refund's attribution has no GA client id, it reuses the purchase's.
- For a refund, `valueCents` is the amount refunded, which GA4 receives. A partial refund is a Google Ads `restatement` whose `adjustedValueCents` is the sale value that remains; it is required. A full refund is a `retraction`, which keeps its refunded value for GA4.

## Buyer identifiers

`buyer` accepts `email`, `phone`, `name` or `firstName` and `lastName`, `street`, `city`, `region`, `postalCode`, `country` and `externalId`. Fields from `identity.resolve` fill in what `buyer` leaves out. The plugin stores Google and Meta identifiers derived from them and discards the rest; see [hashing](privacy.md#hashing).

## Request context

`requestContextFromHeaders(headers, { trustProxy, ipHeader })` returns `{ userAgent, ipAddress }` for `context`. It always reads the user agent. It reads the IP address only with `trustProxy: true`, taking the last entry of `X-Forwarded-For`, or of `ipHeader`, because clients can prepend any value and only your nearest proxy's entry is reliable.
