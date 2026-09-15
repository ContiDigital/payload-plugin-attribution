import type { Payload } from 'payload'

import { recordConversion } from '../src/index.js'

/** Seed is inert outside local development and uses deterministic keys. */
export async function seed(payload: Payload): Promise<void> {
  if (process.env.ATTRIBUTION_SEED !== 'true') {
    return
  }
  const attribution = {
    capturedAt: '2026-09-01T10:00:00.000Z',
    clickCapturedAt: '2026-09-01T10:00:00.000Z',
    gaClientId: '123.456',
    gclid: 'demonstration_click_1234',
    source: 'web' as const,
  }
  await recordConversion({
    draft: {
      name: 'generate_lead',
      attribution,
      eventKey: 'lead:demo',
      googleAds: { action: 'lead', kind: 'conversion' },
      occurredAt: '2026-09-01T12:00:00.000Z',
      subject: { id: 'demo', collectionSlug: 'leads' },
      transactionId: 'lead-demo',
    },
    payload,
  })
  await recordConversion({
    draft: {
      name: 'purchase',
      attribution,
      eventKey: 'purchase:demo',
      googleAds: { action: 'sale', kind: 'conversion' },
      items: [{ item_id: 'item-1', item_name: 'Example item', price: 1000, quantity: 1 }],
      occurredAt: '2026-09-02T12:00:00.000Z',
      subject: { id: 'demo', collectionSlug: 'orders' },
      transactionId: 'order-demo',
      valueCents: 100000,
    },
    payload,
  })
}
