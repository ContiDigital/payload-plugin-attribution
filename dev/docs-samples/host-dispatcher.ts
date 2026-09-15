import type { Payload } from 'payload'
import type { AttributionDispatcher } from 'payload-plugin-attribution'

import { runDelivery, sweepDeliveries } from 'payload-plugin-attribution'

export type DeliveryMessage = { deliveryId: string }
export type DeliveryQueue = {
  send: (message: DeliveryMessage, options: { delaySeconds: number }) => Promise<void>
}

const delaySeconds = (notBefore?: Date): number =>
  notBefore ? Math.max(0, Math.ceil((notBefore.getTime() - Date.now()) / 1000)) : 0

export const queueDispatcher = (queue: DeliveryQueue): AttributionDispatcher => ({
  name: 'host-queue',
  dispatch: ({ deliveryId, notBefore }) =>
    queue.send({ deliveryId: String(deliveryId) }, { delaySeconds: delaySeconds(notBefore) }),
})

// One message is one attempt. A retry dispatches a new message with its own notBefore.
export async function handleDeliveryMessage(
  payload: Payload,
  queue: DeliveryQueue,
  message: DeliveryMessage,
): Promise<void> {
  const deliveryId =
    payload.db.defaultIDType === 'number' ? Number(message.deliveryId) : message.deliveryId
  const result = await runDelivery({ deliveryId, payload })
  // Queues cap their delay; a message that arrives early goes back until the attempt is due.
  if (result.status === 'not_due' && result.nextAttemptAt) {
    await queue.send(message, { delaySeconds: delaySeconds(new Date(result.nextAttemptAt)) })
  }
}

// Run every few minutes: a custom dispatcher gets no scheduled sweep task.
export const onSchedule = (payload: Payload) => sweepDeliveries({ payload })
