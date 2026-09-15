# Migrating from a host-owned ledger

This guide moves a project that already records conversions itself, in its own collection or in a hand-built Google Ads upload feed, onto the plugin without losing history or double-counting conversions.

## 1. Clear the names the plugin owns

The plugin registers these names and throws at startup, or yields to the host, when they are taken:

| Name                                                                                   | On collision                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Collections `conversion-events`, `conversion-deliveries`, `conversion-delivery-claims` | Startup throws; the `collections` option sets other slugs                |
| Job tasks `attributionDeliver`, `attributionSweep`                                     | The host task wins, with a warning                                       |
| Endpoints under `/api/attribution`                                                     | The host endpoint wins, with a warning; `apiBasePath` moves the plugin's |
| Queue `attribution`                                                                    | Shared with host jobs; `queue` sets another name                         |

A host with a live collection named `conversion-events`, or one whose table is `conversion_events` (such as a `conversionEvents` slug, which Postgres and SQLite store in the same table), does not need to rename it. Give the plugin other slugs instead, for example `collections: { events: { slug: 'attribution-events' }, deliveries: { slug: 'attribution-deliveries' }, claims: { slug: 'attribution-claims' } }`, and keep the old collection until its outbox is drained. The plugin throws at startup, naming both collections, when a slug or a table name still collides; setting `dbName` on the host collection also resolves a table collision. See [collection slugs](installation.md#collection-slugs).

A host field named `attribution` with a different shape can stay; pass another name to `attributionField(name)` for new fields.

## 2. Install disabled

Install with `disabled: true` and generate the migration. The schema is created, and nothing is recorded or delivered.

## 3. Import history

Record past conversions under the `eventKey` the new code will use, with every destination turned off:

<!-- sample: import-history.ts -->

```ts
import type { Payload } from 'payload'

import { recordConversion } from 'payload-plugin-attribution'

export type LegacyOrder = { currency: string; number: string; paidAt: string; totalCents: number }

// Records an order the previous system already reported, under the eventKey the new code uses,
// so a later live recording replays it and refunds find their purchase. Nothing is sent.
export const importLegacyPurchase = (payload: Payload, order: LegacyOrder) =>
  recordConversion({
    draft: {
      name: 'purchase',
      currency: order.currency,
      destinations: { ga4: false, googleAds: false, googleAdsAdjustment: false, meta: false },
      eventKey: `order:${order.number}:purchase`,
      googleAds: { action: 'sale', kind: 'conversion' },
      items: [{ item_id: order.number, item_name: 'Imported order', quantity: 1 }],
      occurredAt: order.paidAt,
      transactionId: order.number,
      valueCents: order.totalCents,
    },
    payload,
  })
```

- A live recording of the same `eventKey` later returns the imported event instead of creating a second one.
- Refunds recorded by the new code find their imported purchase.
- Imported events have no delivery rows. Google Ads adjustments for them are withheld with `original_not_delivered`, because the plugin cannot know whether Google received the original. Keep the previous adjustment process for those orders until they are past Google's adjustment window.
- Imported events count toward identifier retention like any other; omit `buyer` for rows older than the retention period.

## 4. Switch recording and enable destinations

Replace the host's recording code with `recordConversion`, remove `disabled`, configure destinations, and deploy. Stop the previous system from sending to the same destinations in the same deploy.

Conversions recorded while a destination was off have no rows for it. Create them with a backfill; see [workers](workers.md#backfill).

## 5. Cut over the feed URL

Google Ads deduplicates uploaded conversions by order id, so a short overlap between the old and new feeds does not double count as long as both use the same order ids (`transactionId`).

1. Confirm `/api/attribution/google-ads/conversions.csv` returns rows for conversions recorded since the switch. Check the file in the Google Ads upload preview.
2. Add a scheduled upload for the new URL with the feed credentials, and for `adjustments.csv` if adjustments are enabled.
3. After the new schedule has run successfully, remove the old one.

Imported history never appears in the new feed, because only delivery rows are served.
