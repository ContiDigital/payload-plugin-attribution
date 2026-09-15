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
