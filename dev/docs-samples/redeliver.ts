import type { Payload } from 'payload'

import { redeliverConversion } from 'payload-plugin-attribution'

// Sends one event to Meta again, for example after replacing an expired access token.
// force is required only when the latest Meta delivery was already sent.
export async function resendToMeta(payload: Payload, eventId: number | string, force = false) {
  const rows = await redeliverConversion({ destinations: ['meta'], eventId, force, payload })
  return rows.map(({ id, destination, status }) => ({ id, destination, status }))
}
