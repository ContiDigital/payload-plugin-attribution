import type { Payload } from 'payload'

import type { DeliveryLookup } from '../destinations/types.js'

import { loadAdjustmentContext } from './adjustmentContext.js'

export const deliveryLookup = (payload: Payload): DeliveryLookup => ({
  originalConversion: async (event) =>
    (await loadAdjustmentContext(payload, [event])).original(event),
  retracted: async (event) => (await loadAdjustmentContext(payload, [event])).retracted(event),
})
