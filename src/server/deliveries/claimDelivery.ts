import type { Payload } from 'payload'

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import type { DeliveryDoc } from '../../types/index.js'

import { CLAIM_BUSY_DELAY_MS, CLAIM_BUSY_RETRIES, LEASE_MS } from '../../constants.js'
import { collectionSlugs, getPluginContext } from '../../plugin/getPluginContext.js'
import { isBusyError, isMongoWriteConflict, isUniqueConflict } from '../utilities/errors.js'
import { createLogger } from '../utilities/logger.js'
import { withTransaction } from '../utilities/transaction.js'
import { lockRow, readDelivery, time } from './store.js'

export type ClaimOptions = { clock?: () => Date }

class ClaimLost extends Error {}

const retryWhileBusy = async <T>(run: () => Promise<T>): Promise<T> => {
  for (let retry = 0; ; retry++) {
    try {
      return await run()
    } catch (error) {
      if (!isBusyError(error) || retry >= CLAIM_BUSY_RETRIES) {
        throw error
      }
      const { max, min } = CLAIM_BUSY_DELAY_MS
      await delay(min + Math.random() * (max - min))
    }
  }
}

const claimable = (
  current: DeliveryDoc,
  attempt: number,
  now: Date,
  maxAttempts: number,
): boolean => {
  if ((current.attempt ?? 0) !== attempt - 1 || attempt > maxAttempts) {
    return false
  }
  if (current.status === 'sending') {
    return !(time(current.leaseExpiresAt) > now.getTime())
  }
  return (
    (current.status === 'pending' || current.status === 'retry') &&
    !(time(current.nextAttemptAt) > now.getTime())
  )
}

const insertClaimAndLease = async (
  payload: Payload,
  delivery: DeliveryDoc,
  attempt: number,
  token: string,
  now: Date,
  clock: () => Date,
): Promise<DeliveryDoc> =>
  withTransaction(
    payload,
    undefined,
    async (req) => {
      await lockRow(payload, collectionSlugs(payload).deliveries, delivery.id, req)
      const current = await readDelivery(payload, delivery.id, req)
      const { maxAttempts } = getPluginContext(payload).options
      if (!current || !claimable(current, attempt, now, maxAttempts)) {
        throw new ClaimLost()
      }
      try {
        await payload.create({
          collection: collectionSlugs(payload).claims as never,
          data: {
            claimedAt: now.toISOString(),
            delivery: String(delivery.id),
            key: `${delivery.id}:${attempt}`,
            token,
          } as never,
          depth: 0,
          overrideAccess: true,
          req,
        })
      } catch (error) {
        // A postgres unique violation aborts the transaction, so the conflict leaves by throwing.
        throw isUniqueConflict(error) ? new ClaimLost() : error
      }
      // The lease runs from when the claim is taken, not from when the caller started.
      return (await payload.update({
        id: delivery.id,
        collection: collectionSlugs(payload).deliveries as never,
        data: {
          attempt,
          leaseExpiresAt: new Date(clock().getTime() + LEASE_MS).toISOString(),
          status: 'sending',
        } as never,
        depth: 0,
        overrideAccess: true,
        req,
      })) as unknown as DeliveryDoc
    },
    { fresh: true },
  )

// Payload's drizzle adapter resolves commitTransaction even when COMMIT fails, so the claim
// is only won once the committed row carries this caller's token.
const committedByUs = async (payload: Payload, key: string, token: string): Promise<boolean> => {
  const { docs } = await payload.find({
    collection: collectionSlugs(payload).claims as never,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: { key: { equals: key } },
  })
  return (docs[0] as { token?: null | string } | undefined)?.token === token
}

export async function claimDelivery(
  payload: Payload,
  delivery: DeliveryDoc,
  now: Date,
  { clock = () => new Date() }: ClaimOptions = {},
): Promise<DeliveryDoc | null> {
  const attempt = (delivery.attempt ?? 0) + 1
  const key = `${delivery.id}:${attempt}`
  const token = randomUUID()
  let claimed: DeliveryDoc
  try {
    claimed = await retryWhileBusy(() =>
      insertClaimAndLease(payload, delivery, attempt, token, now, clock),
    )
  } catch (error) {
    if (error instanceof ClaimLost) {
      return null
    }
    // A MongoDB WriteConflict on the lock key or claim row means a concurrent claimer got there first.
    if (isMongoWriteConflict(error)) {
      createLogger(payload).debug('delivery claim lost to a concurrent write', {
        deliveryId: delivery.id,
      })
      return null
    }
    if (isBusyError(error)) {
      createLogger(payload).warn('delivery claim abandoned while the database stayed busy', {
        deliveryId: delivery.id,
      })
      return null
    }
    throw error
  }
  // A busy confirming read is retried on its own and never turns a won claim into null.
  return (await retryWhileBusy(() => committedByUs(payload, key, token))) ? claimed : null
}
