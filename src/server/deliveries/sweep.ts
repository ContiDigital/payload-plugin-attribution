import type { Payload, Where } from 'payload'

import type { ConversionEventDoc, DeliveryDoc, NormalizedOptions } from '../../types/index.js'
import type { Logger } from '../utilities/logger.js'

import {
  DEFAULT_SWEEP_LIMIT,
  DISPATCH_GRACE_MS,
  PURGE_PAGE_SIZE,
  SCAN_BOUND_FACTOR,
  TERMINAL_STATUSES,
} from '../../constants.js'
import { AD_IDENTIFIER_KEYS } from '../../core/sanitize.js'
import { collectionSlugs, getPluginContext } from '../../plugin/getPluginContext.js'
import { createLogger } from '../utilities/logger.js'
import { withTransaction } from '../utilities/transaction.js'
import {
  lockRow,
  readEvent,
  RELEASED_LEASE,
  REVISION_SUPERSEDED,
  time,
  updateDelivery,
  withLockedDelivery,
  writeSummary,
} from './store.js'

const DAY_MS = 86_400_000

// Online identifiers in stored attribution; UTMs, the landing path and the referrer are kept.
const PURGED_ATTRIBUTION = Object.fromEntries(
  [
    ...AD_IDENTIFIER_KEYS,
    'clickCapturedAt',
    'gaClientId',
    'gaSessionId',
    'gaSessionNumber',
    'gaSessionStartedAt',
  ].map((key) => [key, null]),
)

// Feed rows that are eligible or served need no worker, so they do not hold back a purge.
const SETTLED_STATUSES = [...TERMINAL_STATUSES, 'eligible', 'served']

type Context = { log: Logger; now: Date; options: NormalizedOptions; payload: Payload }

const findDeliveries = async (
  payload: Payload,
  where: Where,
  limit: number,
): Promise<DeliveryDoc[]> =>
  (
    await payload.find({
      collection: collectionSlugs(payload).deliveries as never,
      depth: 0,
      limit,
      overrideAccess: true,
      pagination: false,
      sort: 'createdAt',
      where,
    })
  ).docs as unknown as DeliveryDoc[]

const dispatch = async (
  { log, options, payload }: Context,
  deliveryId: number | string,
): Promise<boolean> => {
  try {
    await options.dispatcher.dispatch({ deliveryId, payload })
    return true
  } catch (error) {
    log.error('sweep could not re-dispatch a delivery', { deliveryId, error })
    return false
  }
}

const recoverExpiredLeases = async (
  context: Context,
  limit: number,
): Promise<{ recovered: number; redispatched: number }> => {
  const { now, options, payload } = context
  const expired = await findDeliveries(
    payload,
    {
      and: [
        { status: { equals: 'sending' } },
        { leaseExpiresAt: { less_than: now.toISOString() } },
      ],
    },
    limit,
  )
  let recovered = 0
  let redispatched = 0
  for (const row of expired) {
    const outcome = await withLockedDelivery(
      payload,
      row.id,
      'skipped' as const,
      async ({ delivery, event, req }) => {
        if (delivery.status !== 'sending' || !(time(delivery.leaseExpiresAt) < now.getTime())) {
          return 'skipped' as const
        }
        // A worker that crashes on every attempt still ends at dead.
        if (delivery.attempt >= options.maxAttempts) {
          await updateDelivery(payload, req, delivery.id, {
            ...RELEASED_LEASE,
            deadlineAt: null,
            reason: 'retry_exhausted',
            status: 'dead',
          })
          if (event && event.revision === delivery.revision) {
            await writeSummary(payload, req, event, delivery.destination, 'dead', 'retry_exhausted')
          }
          return 'dead' as const
        }
        await updateDelivery(payload, req, delivery.id, {
          lastDispatchedAt: now.toISOString(),
          leaseExpiresAt: null,
          nextAttemptAt: now.toISOString(),
          reason: 'lease_expired',
          status: 'retry',
        })
        return 'retry' as const
      },
    )
    recovered += outcome === 'skipped' ? 0 : 1
    if (outcome === 'retry' && (await dispatch(context, row.id))) {
      redispatched++
    }
  }
  return { recovered, redispatched }
}

const closeExpiredWaits = async ({ now, payload }: Context, limit: number): Promise<void> => {
  const expired = await findDeliveries(
    payload,
    {
      and: [
        { status: { equals: 'retry' } },
        { deadlineAt: { less_than_equal: now.toISOString() } },
      ],
    },
    limit,
  )
  for (const row of expired) {
    await withLockedDelivery(payload, row.id, undefined, async ({ delivery, event, req }) => {
      if (delivery.status !== 'retry' || !(time(delivery.deadlineAt) <= now.getTime())) {
        return
      }
      if (event && event.revision !== delivery.revision) {
        await updateDelivery(payload, req, delivery.id, {
          ...RELEASED_LEASE,
          reason: REVISION_SUPERSEDED,
          status: 'superseded',
        })
        return
      }
      await updateDelivery(payload, req, delivery.id, {
        ...RELEASED_LEASE,
        reason: 'deadline_passed',
        status: 'withheld',
      })
      if (event) {
        await writeSummary(payload, req, event, delivery.destination, 'withheld', 'deadline_passed')
      }
    })
  }
}

// A row is re-dispatched only once it has been runnable, and undispatched, for the grace period,
// so repeated sweeps do not queue a job per sweep for a delivery that already has one.
const redispatchDue = async (context: Context, limit: number): Promise<number> => {
  const { now, options, payload } = context
  const cutoff = new Date(now.getTime() - DISPATCH_GRACE_MS)
  const overdue = (value?: null | string): boolean => !(time(value) > cutoff.getTime())
  const due = await findDeliveries(
    payload,
    {
      and: [
        { status: { in: ['pending', 'retry'] } },
        {
          or: [
            { nextAttemptAt: { exists: false } },
            { nextAttemptAt: { less_than_equal: cutoff.toISOString() } },
          ],
        },
        {
          or: [
            { lastDispatchedAt: { less_than_equal: cutoff.toISOString() } },
            {
              and: [
                { lastDispatchedAt: { exists: false } },
                { createdAt: { less_than_equal: cutoff.toISOString() } },
              ],
            },
          ],
        },
      ],
    },
    limit,
  )
  let redispatched = 0
  for (const row of due) {
    const marked = await withLockedDelivery(
      payload,
      row.id,
      false,
      async ({ delivery, event, req }) => {
        const stillDue =
          (delivery.status === 'pending' || delivery.status === 'retry') &&
          overdue(delivery.nextAttemptAt) &&
          overdue(delivery.lastDispatchedAt ?? delivery.createdAt)
        if (!stillDue) {
          return false
        }
        // No claim can succeed once maxAttempts is at or below the attempts used (it was lowered).
        if (delivery.attempt >= options.maxAttempts) {
          await updateDelivery(payload, req, delivery.id, {
            ...RELEASED_LEASE,
            deadlineAt: null,
            reason: 'retry_exhausted',
            status: 'dead',
          })
          if (event && event.revision === delivery.revision) {
            await writeSummary(payload, req, event, delivery.destination, 'dead', 'retry_exhausted')
          }
          return false
        }
        await updateDelivery(payload, req, delivery.id, { lastDispatchedAt: now.toISOString() })
        return true
      },
    )
    if (marked && (await dispatch(context, row.id))) {
      redispatched++
    }
  }
  return redispatched
}

const purgeEvent = (
  payload: Payload,
  eventId: number | string,
  now: Date,
  cutoff: Date,
): Promise<boolean> =>
  withTransaction(
    payload,
    undefined,
    async (req) => {
      await lockRow(payload, collectionSlugs(payload).events, eventId, req)
      const event = await readEvent(payload, eventId, req)
      // Retention runs from the later of occurredAt and the last write, which a revision renews.
      if (
        !event ||
        event.identifiersPurgedAt ||
        !(time(event.occurredAt) < cutoff.getTime()) ||
        !(time(event.updatedAt) < cutoff.getTime())
      ) {
        return false
      }
      const open = await payload.count({
        collection: collectionSlugs(payload).deliveries as never,
        overrideAccess: true,
        req,
        where: {
          and: [{ event: { equals: eventId } }, { status: { not_in: SETTLED_STATUSES } }],
        },
      })
      if (open.totalDocs > 0) {
        return false
      }
      await payload.update({
        id: eventId,
        collection: collectionSlugs(payload).events as never,
        data: {
          attribution: PURGED_ATTRIBUTION,
          context: { ipAddress: null, url: null, userAgent: null },
          identifiers: { google: null, meta: null },
          identifiersPurgedAt: now.toISOString(),
        } as never,
        depth: 0,
        overrideAccess: true,
        req,
      })
      // Provider requests carry the same hashed identifiers.
      const cleared = await payload.update({
        collection: collectionSlugs(payload).deliveries as never,
        data: { request: null } as never,
        depth: 0,
        overrideAccess: true,
        req,
        where: { event: { equals: eventId } },
      })
      if (cleared.errors.length > 0) {
        throw new Error(`could not clear delivery requests: ${cleared.errors[0].message}`)
      }
      return true
    },
    { fresh: true },
  )

// Candidates are walked by id so events that cannot be purged yet never hide later ones; the
// scan stops after limit * SCAN_BOUND_FACTOR candidates.
const purgeIdentifiers = async (
  { now, options, payload }: Context,
  limit: number,
): Promise<number> => {
  const cutoff = new Date(now.getTime() - options.privacy.identifierRetentionDays * DAY_MS)
  const bound = limit * SCAN_BOUND_FACTOR
  let purged = 0
  let scanned = 0
  let cursor: number | string | undefined
  while (purged < limit && scanned < bound) {
    const pageSize = Math.min(PURGE_PAGE_SIZE, bound - scanned)
    const { docs } = await payload.find({
      collection: collectionSlugs(payload).events as never,
      depth: 0,
      joins: false,
      limit: pageSize,
      overrideAccess: true,
      pagination: false,
      sort: 'id',
      where: {
        and: [
          { occurredAt: { less_than: cutoff.toISOString() } },
          { updatedAt: { less_than: cutoff.toISOString() } },
          { identifiersPurgedAt: { exists: false } },
          ...(cursor === undefined ? [] : [{ id: { greater_than: cursor } }]),
        ],
      },
    })
    const events = docs as unknown as ConversionEventDoc[]
    for (const event of events) {
      if (purged >= limit) {
        break
      }
      cursor = event.id
      scanned++
      purged += (await purgeEvent(payload, event.id, now, cutoff)) ? 1 : 0
    }
    if (events.length < pageSize) {
      break
    }
  }
  return purged
}

export async function sweepDeliveries(args: {
  limit?: number
  now?: Date
  payload: Payload
}): Promise<{ purged: number; recovered: number; redispatched: number }> {
  const { limit = DEFAULT_SWEEP_LIMIT, now = new Date(), payload } = args
  const { options } = getPluginContext(payload)
  if (options.disabled) {
    return { purged: 0, recovered: 0, redispatched: 0 }
  }
  const context: Context = { log: createLogger(payload), now, options, payload }
  const leases = await recoverExpiredLeases(context, limit)
  await closeExpiredWaits(context, limit)
  const redispatched = leases.redispatched + (await redispatchDue(context, limit))
  const purged = await purgeIdentifiers(context, limit)
  return { purged, recovered: leases.recovered, redispatched }
}
