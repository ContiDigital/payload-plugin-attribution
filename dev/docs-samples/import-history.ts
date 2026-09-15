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
