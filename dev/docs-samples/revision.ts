import type { Payload } from 'payload'

import { recordConversion } from 'payload-plugin-attribution'

import type { Order } from './recording.js'

import { purchaseDraft } from './recording.js'

// A corrected order replaces the recorded purchase. The draft is a full snapshot: fields left
// out are cleared, and name, transactionId and occurredAt must stay the same.
export const recordCorrectedPurchase = (payload: Payload, order: Order, revision: number) =>
  recordConversion({ draft: { ...purchaseDraft(order), revision }, payload })
