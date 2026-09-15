import type { Payload } from 'payload'
import type { PropertyPlan } from 'payload-plugin-attribution'

import { setupGa4Property } from 'payload-plugin-attribution'

export const plan: PropertyPlan = {
  eventDimensions: ['sales_channel', 'event_source'],
  keyEvents: ['generate_lead', { countingMethod: 'ONCE_PER_EVENT', eventName: 'purchase' }],
}

// Lists what is missing and changes nothing.
export const previewProperty = (payload: Payload, serviceAccountJson: string) =>
  setupGa4Property({ payload, plan, serviceAccountJson })

// Creates the missing custom dimensions and key events.
export const applyProperty = (payload: Payload, serviceAccountJson: string) =>
  setupGa4Property({ apply: true, payload, plan, serviceAccountJson })
