import type { Payload } from 'payload'

import { setTimeout as delay } from 'node:timers/promises'

import type { DeliveryDoc, NormalizedOptions } from '../../types/index.js'
import type {
  DeliveryResult,
  DestinationHandler,
  DestinationOutcome,
} from '../destinations/types.js'
import type { Logger } from '../utilities/logger.js'

import {
  DEFAULT_DESTINATION_TIMEOUT_MS,
  FINISH_WRITE_CONFLICT_RETRIES,
  MIN_WAIT_MS,
  WRITE_CONFLICT_RETRY_DELAY_MS,
} from '../../constants.js'
import { collectionSlugs, getPluginContext } from '../../plugin/getPluginContext.js'
import { getDestinationHandler } from '../destinations/registry.js'
import { isAbortError, isMongoWriteConflict, SettingUnavailableError } from '../utilities/errors.js'
import { createLogger } from '../utilities/logger.js'
import { nextBackoffMs } from './backoff.js'
import { claimDelivery } from './claimDelivery.js'
import { deliveryLookup } from './lookup.js'
import {
  eventIdOf,
  isTerminal,
  readDelivery,
  readEvent,
  RELEASED_LEASE,
  REVISION_SUPERSEDED,
  time,
  updateDelivery,
  withLockedDelivery,
  writeSummary,
} from './store.js'

type Settlement = {
  data: Record<string, unknown>
  nextAttemptAt?: Date
  reason?: string
  releaseClaim?: boolean
  status: 'dead' | 'eligible' | 'retry' | 'sent' | 'superseded' | 'withheld'
}

type HandlerArgs = Omit<Parameters<DestinationHandler['deliver']>[0], 'signal'>

const CALLER_ABORTED = 'caller_aborted'

// Only a wait carries a deadline; every other outcome clears it so the sweep cannot close an
// ordinary retry as an expired wait.
const CLOSED = { ...RELEASED_LEASE, deadlineAt: null } as const

const withResponse = (response: unknown): Record<string, unknown> =>
  response === undefined ? {} : { response }

const final = (
  status: 'dead' | 'superseded' | 'withheld',
  reason: string,
  extra: Record<string, unknown> = {},
): Settlement => ({ data: { ...CLOSED, ...extra, reason, status }, reason, status })

// Waits and caller aborts are not attempts: the attempt goes back and the claim row is released
// so the next run can claim the same attempt number again.
const releasedAttempt = (claimed: DeliveryDoc): Record<string, unknown> => ({
  attempt: claimed.attempt - 1,
  leaseExpiresAt: null,
})

const retryOrDead = (
  claimed: DeliveryDoc,
  reason: string,
  now: Date,
  options: NormalizedOptions,
  retryAfterMs?: number,
  response?: unknown,
): Settlement => {
  if (claimed.attempt >= options.maxAttempts) {
    return final('dead', 'retry_exhausted', withResponse(response))
  }
  const next = new Date(now.getTime() + nextBackoffMs(claimed.attempt, retryAfterMs))
  return {
    data: {
      ...withResponse(response),
      deadlineAt: null,
      lastDispatchedAt: now.toISOString(),
      leaseExpiresAt: null,
      nextAttemptAt: next.toISOString(),
      reason,
      status: 'retry',
    },
    nextAttemptAt: next,
    reason,
    status: 'retry',
  }
}

const settleWait = (
  outcome: Extract<DestinationOutcome, { kind: 'wait' }>,
  claimed: DeliveryDoc,
  now: Date,
  options: NormalizedOptions,
): Settlement => {
  const until = time(outcome.until)
  const deadline = time(outcome.deadlineAt)
  if (!Number.isFinite(until) || !Number.isFinite(deadline)) {
    return retryOrDead(claimed, 'invalid_outcome', now, options)
  }
  const waited = {
    ...(outcome.request === undefined ? {} : { request: outcome.request }),
    ...withResponse(outcome.response),
    ...releasedAttempt(claimed),
    deadlineAt: new Date(deadline).toISOString(),
    reason: outcome.reason,
  }
  if (now.getTime() >= deadline) {
    return {
      data: { ...waited, nextAttemptAt: null, status: 'withheld' },
      reason: outcome.reason,
      releaseClaim: true,
      status: 'withheld',
    }
  }
  const next = new Date(Math.min(Math.max(until, now.getTime() + MIN_WAIT_MS), deadline))
  return {
    data: {
      ...waited,
      lastDispatchedAt: now.toISOString(),
      nextAttemptAt: next.toISOString(),
      status: 'retry',
    },
    nextAttemptAt: next,
    reason: outcome.reason,
    releaseClaim: true,
    status: 'retry',
  }
}

// The sweep re-dispatches it once the dispatch grace period has passed.
const callerAborted = (claimed: DeliveryDoc, now: Date): Settlement => ({
  data: {
    ...releasedAttempt(claimed),
    nextAttemptAt: now.toISOString(),
    reason: 'aborted',
    status: 'retry',
  },
  reason: 'aborted',
  releaseClaim: true,
  status: 'retry',
})

const settle = (
  outcome: DestinationOutcome,
  claimed: DeliveryDoc,
  now: Date,
  options: NormalizedOptions,
): Settlement => {
  switch (outcome.kind) {
    case 'dead':
      return final('dead', outcome.reason, withResponse(outcome.response))
    case 'eligible':
      return { data: { ...CLOSED, reason: null, status: 'eligible' }, status: 'eligible' }
    case 'retry':
      return retryOrDead(
        claimed,
        outcome.reason,
        now,
        options,
        outcome.retryAfterMs,
        outcome.response,
      )
    case 'sent':
      return {
        data: {
          ...CLOSED,
          ...(outcome.request === undefined ? {} : { request: outcome.request }),
          ...withResponse(outcome.response),
          reason: null,
          sentAt: now.toISOString(),
          status: 'sent',
        },
        status: 'sent',
      }
    case 'wait':
      return settleWait(outcome, claimed, now, options)
    case 'withheld':
      return final('withheld', outcome.reason)
    default:
      return retryOrDead(claimed, 'invalid_outcome', now, options)
  }
}

const isOutcome = (value: unknown): value is DestinationOutcome =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { kind?: unknown }).kind === 'string'

const timeoutFor = (delivery: DeliveryDoc, options: NormalizedOptions): number => {
  const configured =
    delivery.destination === 'meta' ? options.destinations.meta?.timeoutMs : undefined
  return configured && configured > 0 ? configured : DEFAULT_DESTINATION_TIMEOUT_MS
}

const callHandler = async (
  handler: DestinationHandler,
  args: HandlerArgs,
  signal: AbortSignal | undefined,
  log: Logger,
): Promise<DestinationOutcome | typeof CALLER_ABORTED> => {
  const timeout = AbortSignal.timeout(timeoutFor(args.delivery, args.options))
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let onAbort = (): void => undefined
  // A handler that ignores its signal must not hold the worker past the timeout.
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('destination call aborted'))
    if (combined.aborted) {
      onAbort()
    } else {
      combined.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    const result: unknown = await Promise.race([
      handler.deliver({ ...args, signal: combined }),
      aborted,
    ])
    return isOutcome(result) ? result : { kind: 'retry', reason: 'invalid_outcome' }
  } catch (error) {
    // A secret manager outage is an infrastructure failure, not missing configuration.
    if (error instanceof SettingUnavailableError) {
      log.warn('a destination setting could not be resolved, retrying', {
        deliveryId: args.delivery.id,
        destination: args.delivery.destination,
        error: error.cause,
      })
      return { kind: 'retry', reason: 'settings_unavailable' }
    }
    if (combined.aborted || isAbortError(error)) {
      return signal?.aborted && !timeout.aborted
        ? CALLER_ABORTED
        : { kind: 'retry', reason: 'timeout' }
    }
    log.error('destination handler failed', {
      deliveryId: args.delivery.id,
      destination: args.delivery.destination,
      error,
    })
    return { kind: 'retry', reason: 'unexpected_error' }
  } finally {
    combined.removeEventListener('abort', onAbort)
  }
}

// MongoDB fails a transaction at once with WriteConflict when another delivery of the same event
// holds the event lock; the fence below makes re-running the whole settlement safe.
const finish = async (
  payload: Payload,
  deliveryId: number | string,
  claimed: DeliveryDoc,
  settlement: Settlement,
  log: Logger,
): Promise<DeliveryResult> => {
  for (let retry = 0; ; retry++) {
    try {
      return await settleOnce(payload, deliveryId, claimed, settlement, log)
    } catch (error) {
      if (!isMongoWriteConflict(error) || retry >= FINISH_WRITE_CONFLICT_RETRIES) {
        throw error
      }
      const { max, min } = WRITE_CONFLICT_RETRY_DELAY_MS
      await delay(min + Math.random() * (max - min))
    }
  }
}

// Fence: the result is written only while this worker still holds the lease on the current
// revision, re-read under row locks in a short transaction of its own.
const settleOnce = (
  payload: Payload,
  deliveryId: number | string,
  claimed: DeliveryDoc,
  settlement: Settlement,
  log: Logger,
): Promise<DeliveryResult> =>
  withLockedDelivery<DeliveryResult>(
    payload,
    claimed.id,
    { deliveryId, status: 'not_found' },
    async ({ delivery, event, req }) => {
      if (event && delivery.revision !== event.revision) {
        if (isTerminal(delivery.status)) {
          return {
            deliveryId,
            status: delivery.status,
            ...(delivery.reason ? { reason: delivery.reason } : {}),
          }
        }
        await updateDelivery(payload, req, delivery.id, {
          ...CLOSED,
          reason: REVISION_SUPERSEDED,
          status: 'superseded',
        })
        return { deliveryId, reason: REVISION_SUPERSEDED, status: 'superseded' }
      }
      if (delivery.status !== 'sending' || delivery.attempt !== claimed.attempt) {
        log.warn('delivery lease was reclaimed, result discarded', {
          attempt: claimed.attempt,
          deliveryId: delivery.id,
        })
        return { deliveryId, status: 'claimed_elsewhere' }
      }
      await updateDelivery(payload, req, delivery.id, settlement.data)
      if (settlement.releaseClaim) {
        await payload.delete({
          collection: collectionSlugs(payload).claims as never,
          overrideAccess: true,
          req,
          where: { key: { equals: `${delivery.id}:${claimed.attempt}` } },
        })
      }
      if (event && settlement.status !== 'superseded') {
        await writeSummary(
          payload,
          req,
          event,
          delivery.destination,
          settlement.status,
          settlement.reason,
        )
      }
      return {
        deliveryId,
        status: settlement.status,
        ...(settlement.reason ? { reason: settlement.reason } : {}),
        ...(settlement.nextAttemptAt
          ? { nextAttemptAt: settlement.nextAttemptAt.toISOString() }
          : {}),
      }
    },
  )

export async function runDelivery(args: {
  deliveryId: number | string
  now?: Date
  payload: Payload
  signal?: AbortSignal
}): Promise<DeliveryResult> {
  const { deliveryId, now = new Date(), payload, signal } = args
  const { options } = getPluginContext(payload)
  const log = createLogger(payload)

  const delivery = await readDelivery(payload, deliveryId)
  if (!delivery) {
    return { deliveryId, status: 'not_found' }
  }
  const unchanged: DeliveryResult = {
    deliveryId,
    status: delivery.status,
    ...(delivery.reason ? { reason: delivery.reason } : {}),
  }
  if (
    isTerminal(delivery.status) ||
    delivery.status === 'eligible' ||
    delivery.status === 'served'
  ) {
    return unchanged
  }
  if (options.disabled) {
    return { ...unchanged, reason: 'plugin_disabled' }
  }
  if (delivery.status === 'sending' && time(delivery.leaseExpiresAt) > now.getTime()) {
    return { deliveryId, status: 'claimed_elsewhere' }
  }
  if (delivery.status !== 'sending' && time(delivery.nextAttemptAt) > now.getTime()) {
    return { deliveryId, nextAttemptAt: delivery.nextAttemptAt ?? undefined, status: 'not_due' }
  }

  const claimed = await claimDelivery(payload, delivery, now)
  if (!claimed) {
    return { deliveryId, status: 'claimed_elsewhere' }
  }

  // No transaction is open from here until finish: destination calls are network I/O.
  const event = await readEvent(payload, eventIdOf(claimed))
  let settlement: Settlement
  if (!event) {
    settlement = final('dead', 'event_not_found')
  } else if (event.revision !== claimed.revision) {
    settlement = final('superseded', REVISION_SUPERSEDED)
  } else if (time(claimed.deadlineAt) <= now.getTime()) {
    settlement = {
      data: {
        ...RELEASED_LEASE,
        ...releasedAttempt(claimed),
        reason: 'deadline_passed',
        status: 'withheld',
      },
      reason: 'deadline_passed',
      releaseClaim: true,
      status: 'withheld',
    }
  } else {
    const handler = getDestinationHandler(claimed.destination)
    const outcome = handler
      ? await callHandler(
          handler,
          { delivery: claimed, event, lookup: deliveryLookup(payload), now, options, payload },
          signal,
          log,
        )
      : ({ kind: 'withheld', reason: 'no_handler' } as const)
    settlement =
      outcome === CALLER_ABORTED
        ? callerAborted(claimed, now)
        : settle(outcome, claimed, now, options)
  }

  const result = await finish(payload, deliveryId, claimed, settlement, log)
  if (result.status === 'retry' && settlement.nextAttemptAt) {
    try {
      await options.dispatcher.dispatch({
        deliveryId: claimed.id,
        notBefore: settlement.nextAttemptAt,
        payload,
      })
    } catch (error) {
      log.error('dispatch failed, the sweep re-dispatches due deliveries', {
        deliveryId: claimed.id,
        error,
      })
    }
  }
  return result
}
