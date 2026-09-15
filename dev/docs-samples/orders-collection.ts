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
