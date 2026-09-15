import type { Payload } from 'payload'

import type { ConversionEventDoc, DeliveryDoc } from '../../types/index.js'

import { collectionSlugs } from '../../plugin/getPluginContext.js'
import { deliveredAtOf } from '../destinations/googleAdsFeed/adjustmentWindows.js'

const deliveredMs = (delivery: DeliveryDoc): number => {
  const at = Date.parse(deliveredAtOf(delivery) ?? '')
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY
}

export type AdjustmentContext = {
  original: (
    event: ConversionEventDoc,
  ) => { delivery: DeliveryDoc | null; event: ConversionEventDoc } | null
  retracted: (event: ConversionEventDoc) => boolean
}

const orderKey = (event: ConversionEventDoc): string | undefined =>
  event.transactionId && (event.googleAdsAction === 'lead' || event.googleAdsAction === 'sale')
    ? JSON.stringify([event.transactionId, event.googleAdsAction])
    : undefined

const reachedGoogle = (delivery: DeliveryDoc): boolean =>
  delivery.destination === 'googleAdsAdjustment' &&
  (delivery.status === 'sent' || Boolean(delivery.firstServedAt))

const NONE: AdjustmentContext = { original: () => null, retracted: () => false }

// Two queries for any number of adjustment events: the orders' conversions and retractions,
// then those events' Google Ads deliveries.
export async function loadAdjustmentContext(
  payload: Payload,
  events: readonly ConversionEventDoc[],
): Promise<AdjustmentContext> {
  const transactionIds = [
    ...new Set(
      events.filter((event) => orderKey(event)).map((event) => String(event.transactionId)),
    ),
  ]
  if (transactionIds.length === 0) {
    return NONE
  }
  const related = (
    await payload.find({
      collection: collectionSlugs(payload).events as never,
      depth: 0,
      joins: false,
      overrideAccess: true,
      pagination: false,
      sort: 'createdAt',
      where: {
        and: [
          { transactionId: { in: transactionIds } },
          { googleAdsKind: { in: ['conversion', 'retraction'] } },
        ],
      },
    })
  ).docs as unknown as ConversionEventDoc[]

  const originals = new Map<string, ConversionEventDoc>()
  const retractions = new Map<string, ConversionEventDoc[]>()
  for (const event of related) {
    const key = orderKey(event)
    if (!key) {
      continue
    }
    if (event.googleAdsKind === 'conversion') {
      if (!originals.has(key)) {
        originals.set(key, event)
      }
    } else {
      retractions.set(key, [...(retractions.get(key) ?? []), event])
    }
  }
  if (related.length === 0) {
    return NONE
  }

  const deliveries = (
    await payload.find({
      collection: collectionSlugs(payload).deliveries as never,
      depth: 0,
      overrideAccess: true,
      pagination: false,
      sort: '-sequence',
      where: {
        and: [
          { event: { in: related.map((event) => event.id) } },
          { destination: { in: ['googleAds', 'googleAdsAdjustment'] } },
        ],
      },
    })
  ).docs as unknown as DeliveryDoc[]
  const byEvent = new Map<string, DeliveryDoc[]>()
  for (const delivery of deliveries) {
    const eventId = String(typeof delivery.event === 'object' ? delivery.event.id : delivery.event)
    byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), delivery])
  }

  return {
    original: (event) => {
      const key = orderKey(event)
      const original = key ? originals.get(key) : undefined
      if (!original) {
        return null
      }
      // Google holds the conversion once any revision or sequence of it was sent or served; a later
      // withheld, dead or superseded row never takes that back.
      const candidates = (byEvent.get(String(original.id)) ?? []).filter(
        (candidate) => candidate.destination === 'googleAds',
      )
      const delivered = candidates
        .filter((candidate) => candidate.status === 'sent' || Boolean(candidate.firstServedAt))
        .sort((a, b) => deliveredMs(a) - deliveredMs(b))
      const current = candidates.find((candidate) => candidate.revision === original.revision)
      return { delivery: delivered[0] ?? current ?? null, event: original }
    },
    retracted: (event) => {
      const key = orderKey(event)
      return (key ? (retractions.get(key) ?? []) : []).some(
        (retraction) =>
          String(retraction.id) !== String(event.id) &&
          (byEvent.get(String(retraction.id)) ?? []).some(reachedGoogle),
      )
    },
  }
}
