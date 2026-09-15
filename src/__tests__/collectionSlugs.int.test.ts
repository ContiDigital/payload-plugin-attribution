import type { Payload } from 'payload'

import { createLocalReq } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AttributionPluginOptions, ConversionEventDoc, DeliveryDoc } from '../types/index.js'

import { runDelivery } from '../server/deliveries/runDelivery.js'
import { sweepDeliveries } from '../server/deliveries/sweep.js'
import { recordConversion } from '../server/record/recordConversion.js'
import {
  bootPayload,
  databaseName,
  destroyPayloads,
  recordingDispatcher,
} from './helpers/bootPayload.js'

const slugs = {
  claims: 'attribution-claims',
  deliveries: 'attribution-deliveries',
  events: 'attribution-events',
} as const

const { dispatcher } = recordingDispatcher()
let payload: Payload

const options: AttributionPluginOptions = {
  authorize: () => true,
  collections: {
    claims: { slug: slugs.claims },
    deliveries: { slug: slugs.deliveries },
    events: { slug: slugs.events },
  },
  destinations: {
    googleAds: {
      conversionActions: { lead: 'Business lead', sale: 'Business sale' },
      feed: { password: 'feed-password', username: 'feed-user' },
      transport: 'feed',
    },
  },
  dispatcher,
  secret: 'collection-slugs-secret',
}

const endpoint = async (path: string, authorization?: string): Promise<Response> => {
  const found = payload.config.endpoints.find(
    (candidate) => candidate.method === 'get' && candidate.path === path,
  )
  if (!found) {
    throw new Error(`${path} is not registered`)
  }
  const req = await createLocalReq({}, payload)
  req.headers = new Headers(authorization ? { authorization } : {})
  return found.handler(req)
}

beforeAll(async () => {
  payload = await bootPayload({
    // A host that already owns a live conversion-events collection.
    collections: [{ slug: 'conversion-events', fields: [{ name: 'legacy', type: 'text' }] }],
    label: 'collection_slugs',
    options,
  })
})

afterAll(destroyPayloads)

describe(`host-chosen collection slugs on ${databaseName}`, () => {
  it('records, delivers, sweeps and serves the feed without touching the host collection', async () => {
    await payload.create({
      collection: 'conversion-events' as never,
      data: { legacy: 'host row' } as never,
      overrideAccess: true,
    })
    const now = Date.now()
    const event = (await recordConversion({
      draft: {
        name: 'purchase',
        attribution: {
          clickCapturedAt: new Date(now - 3_600_000).toISOString(),
          gclid: 'gclid_custom_slug_123',
        },
        consent: { adUserData: 'granted' },
        eventKey: 'custom-slug-purchase',
        googleAds: { action: 'sale' },
        items: [{ item_id: 'artwork-1', price: 120, quantity: 1 }],
        occurredAt: new Date(now - 3_600_000).toISOString(),
        transactionId: 'custom-slug-order',
        valueCents: 12000,
      },
      payload,
    })) as ConversionEventDoc
    expect(event?.eventKey).toBe('custom-slug-purchase')

    const joined = (await payload.findByID({
      id: event.id,
      collection: slugs.events as never,
      depth: 0,
      overrideAccess: true,
    })) as unknown as ConversionEventDoc
    expect(joined.deliveries?.docs).toHaveLength(1)
    const { docs } = await payload.find({
      collection: slugs.deliveries as never,
      depth: 0,
      overrideAccess: true,
      where: { event: { equals: event.id } },
    })
    const row = docs[0] as unknown as DeliveryDoc
    expect(row).toMatchObject({ destination: 'googleAds', status: 'pending' })

    expect(await runDelivery({ deliveryId: row.id, payload })).toMatchObject({ status: 'eligible' })
    const feed = await endpoint(
      '/attribution/google-ads/conversions.csv',
      `Basic ${Buffer.from('feed-user:feed-password').toString('base64')}`,
    )
    expect(feed.status).toBe(200)
    expect(await feed.text()).toContain('custom-slug-order')

    const health = await endpoint('/attribution/health')
    expect(health.status).toBe(200)
    expect(((await health.json()) as { counts: Record<string, number> }).counts.served).toBe(1)

    expect(await sweepDeliveries({ payload })).toEqual({ purged: 0, recovered: 0, redispatched: 0 })
    expect(
      (await payload.count({ collection: slugs.claims as never, overrideAccess: true })).totalDocs,
    ).toBeGreaterThan(0)

    const host = await payload.find({
      collection: 'conversion-events' as never,
      depth: 0,
      overrideAccess: true,
    })
    expect(host.docs.map((doc) => (doc as { legacy?: string }).legacy)).toEqual(['host row'])

    const events = payload.config.collections.find((collection) => collection.slug === slugs.events)
    const panel = events?.fields.find(
      (field) => 'name' in field && field.name === 'deliveriesPanel',
    )
    expect(JSON.stringify(panel)).toContain(slugs.deliveries)
  })
})
