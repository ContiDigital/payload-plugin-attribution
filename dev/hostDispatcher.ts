import type { CollectionConfig, Payload } from 'payload'

import type { AttributionDispatcher } from '../src/index.js'

import { runDelivery } from '../src/index.js'

export const OUTBOX_SLUG = 'outbox'

type OutboxRow = { deliveryId: string; id: number | string }

export const outboxCollection: CollectionConfig = {
  slug: OUTBOX_SLUG,
  admin: { group: 'Development', useAsTitle: 'deliveryId' },
  fields: [
    { name: 'deliveryId', type: 'text', index: true, required: true },
    { name: 'notBefore', type: 'date' },
    { name: 'processedAt', type: 'date', index: true },
    { name: 'result', type: 'json' },
  ],
}

/** Stands in for a host queue (SQS, a worker table): each dispatch is a row a worker drains. */
export function hostLedgerDispatcher(): AttributionDispatcher {
  return {
    name: 'host-ledger',
    dispatch: async ({ deliveryId, notBefore, payload, req }) => {
      await payload.create({
        collection: OUTBOX_SLUG,
        data: { deliveryId: String(deliveryId), notBefore: notBefore?.toISOString() },
        overrideAccess: true,
        req,
      })
    },
  }
}

const deliveryIdFor = (payload: Payload, id: string): number | string =>
  payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id

export async function drainOutbox(
  payload: Payload,
  now = new Date(),
): Promise<{ processed: number }> {
  const due = await payload.find({
    collection: OUTBOX_SLUG,
    depth: 0,
    limit: 100,
    overrideAccess: true,
    sort: 'createdAt',
    where: {
      and: [
        { processedAt: { exists: false } },
        {
          or: [
            { notBefore: { exists: false } },
            { notBefore: { less_than_equal: now.toISOString() } },
          ],
        },
      ],
    },
  })
  const rows = due.docs as unknown as OutboxRow[]
  for (const row of rows) {
    const result = await runDelivery({
      deliveryId: deliveryIdFor(payload, row.deliveryId),
      payload,
    })
    await payload.update({
      id: row.id,
      collection: OUTBOX_SLUG,
      data: { processedAt: new Date().toISOString(), result },
      overrideAccess: true,
    })
  }
  return { processed: rows.length }
}
