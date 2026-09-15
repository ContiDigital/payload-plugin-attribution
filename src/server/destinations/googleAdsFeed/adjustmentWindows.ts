import type { DeliveryDoc } from '../../../types/index.js'

import { ADJUSTMENT_OPEN_AFTER_MS, ADJUSTMENT_WINDOW_MS } from '../../../constants.js'

export type AdjustmentWindow =
  { deadlineAt: string; state: 'wait'; until: string } | { state: 'closed' } | { state: 'open' }

// Data Manager deliveries reach Google when sent; feed deliveries once Google first pulls them,
// whatever their status is now.
export function deliveredAtOf(delivery: DeliveryDoc): string | undefined {
  if (delivery.status === 'sent') {
    return delivery.sentAt ?? undefined
  }
  return delivery.firstServedAt ?? undefined
}

export function adjustmentWindow(originalDeliveredAt: string, now: Date): AdjustmentWindow {
  const delivered = Date.parse(originalDeliveredAt)
  if (!Number.isFinite(delivered)) {
    return { state: 'closed' }
  }
  const opens = delivered + ADJUSTMENT_OPEN_AFTER_MS
  const closes = delivered + ADJUSTMENT_WINDOW_MS
  if (now.getTime() < opens) {
    return {
      deadlineAt: new Date(closes).toISOString(),
      state: 'wait',
      until: new Date(opens).toISOString(),
    }
  }
  return now.getTime() > closes ? { state: 'closed' } : { state: 'open' }
}
