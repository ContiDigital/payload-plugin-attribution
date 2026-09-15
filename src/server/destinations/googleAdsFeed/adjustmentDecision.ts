import type { ConversionEventDoc, DeliveryDoc, DeliveryStatus } from '../../../types/index.js'
import type { DestinationOutcome } from '../types.js'

import { ORIGINAL_WAIT_DEADLINE_MS, ORIGINAL_WAIT_MS } from '../../../constants.js'
import { adjustmentWindow, deliveredAtOf } from './adjustmentWindows.js'

// Google never received these originals, so an adjustment can never apply to them.
export const NEVER_DELIVERED: readonly DeliveryStatus[] = ['withheld', 'dead', 'superseded']

export function adjustmentNotApplicable(
  event: ConversionEventDoc,
): 'missing_value' | 'not_applicable' | undefined {
  const kind = event.googleAdsKind
  const action = event.googleAdsAction
  if (
    (kind !== 'restatement' && kind !== 'retraction') ||
    (action !== 'lead' && action !== 'sale') ||
    !event.transactionId
  ) {
    return 'not_applicable'
  }
  if (
    kind === 'restatement' &&
    typeof event.adjustedValueCents !== 'number' &&
    typeof event.valueCents !== 'number'
  ) {
    return 'missing_value'
  }
  return undefined
}

// A feed original that Google pulled once stays delivered even if its row later changed status.
export const originalDelivered = (original: DeliveryDoc | null): original is DeliveryDoc =>
  original !== null &&
  (Boolean(original.firstServedAt) || !NEVER_DELIVERED.includes(original.status))

export function decideAdjustment(args: {
  event: ConversionEventDoc
  now: Date
  original: DeliveryDoc | null
  retracted: boolean
}): DestinationOutcome {
  const { event, now, original, retracted } = args
  const notApplicable = adjustmentNotApplicable(event)
  if (notApplicable) {
    return { kind: 'withheld', reason: notApplicable }
  }
  if (!originalDelivered(original)) {
    return { kind: 'withheld', reason: 'original_not_delivered' }
  }
  // Google ignores every adjustment to an order after its retraction.
  if (retracted) {
    return { kind: 'withheld', reason: 'retracted' }
  }
  const deliveredAt = deliveredAtOf(original)
  if (!deliveredAt) {
    return {
      deadlineAt: new Date(
        Date.parse(original.createdAt) + ORIGINAL_WAIT_DEADLINE_MS,
      ).toISOString(),
      kind: 'wait',
      reason: 'awaiting_original',
      until: new Date(now.getTime() + ORIGINAL_WAIT_MS).toISOString(),
    }
  }
  const window = adjustmentWindow(deliveredAt, now)
  if (window.state === 'wait') {
    return {
      deadlineAt: window.deadlineAt,
      kind: 'wait',
      reason: 'adjustment_window_pending',
      until: window.until,
    }
  }
  return window.state === 'open'
    ? { kind: 'eligible' }
    : { kind: 'withheld', reason: 'adjustment_window_closed' }
}
