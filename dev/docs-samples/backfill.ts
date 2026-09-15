import type { Payload } from 'payload'
import type { ConversionEventDoc } from 'payload-plugin-attribution'

import { redeliverConversion } from 'payload-plugin-attribution'

// Creates Google Ads deliveries for conversions recorded before the destination was enabled.
export async function backfillGoogleAds(payload: Payload, since: string): Promise<number> {
  let created = 0
  for (let page = 1; ; page += 1) {
    const result = await payload.find({
      // The default slug; use your `collections.events.slug` if you changed it.
      collection: 'conversion-events',
      depth: 0,
      joins: false,
      limit: 100,
      overrideAccess: true,
      page,
      sort: 'occurredAt',
      where: {
        and: [
          { occurredAt: { greater_than_equal: since } },
          { googleAdsKind: { equals: 'conversion' } },
          { googleAdsAction: { in: ['lead', 'sale'] } },
        ],
      },
    })
    for (const event of result.docs as unknown as ConversionEventDoc[]) {
      if (!event.deliverySummary?.googleAds) {
        const rows = await redeliverConversion({
          destinations: ['googleAds'],
          eventId: event.id,
          payload,
        })
        created += rows.length
      }
    }
    if (!result.hasNextPage) {
      return created
    }
  }
}
