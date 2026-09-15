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
