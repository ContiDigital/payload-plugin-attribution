import type { Payload, PayloadRequest } from 'payload'

import type {
  ConversionEventDoc,
  DeliveryDoc,
  DeliveryStatus,
  Destination,
} from '../../types/index.js'

import { PLUGIN_SLUG, TERMINAL_STATUSES } from '../../constants.js'
import { collectionSlugs } from '../../plugin/getPluginContext.js'
import { isMalformedIdError, PluginError } from '../utilities/errors.js'
import { withTransaction } from '../utilities/transaction.js'

export const REVISION_SUPERSEDED = 'revision_superseded'

export const RELEASED_LEASE = { leaseExpiresAt: null, nextAttemptAt: null } as const

export const isTerminal = (status: DeliveryStatus): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(status)

export const eventIdOf = (delivery: Pick<DeliveryDoc, 'event'>): number | string =>
  typeof delivery.event === 'object' ? delivery.event.id : delivery.event

export const time = (value?: null | string): number => Date.parse(value ?? '')

export const readDelivery = async (
  payload: Payload,
  id: number | string,
  req?: PayloadRequest,
): Promise<DeliveryDoc | null> => {
  try {
    return (await payload.findByID({
      id,
      collection: collectionSlugs(payload).deliveries as never,
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
    })) as unknown as DeliveryDoc | null
  } catch (error) {
    // An id the adapter cannot even parse matches no row, as a missing one does on every adapter.
    if (isMalformedIdError(error)) {
      return null
    }
    throw error
  }
}

export const readEvent = async (
  payload: Payload,
  id: number | string,
  req?: PayloadRequest,
): Promise<ConversionEventDoc | null> =>
  (await payload.findByID({
    id,
    collection: collectionSlugs(payload).events as never,
    depth: 0,
    disableErrors: true,
    joins: false,
    overrideAccess: true,
    req,
  })) as unknown as ConversionEventDoc | null

export const updateDelivery = async (
  payload: Payload,
  req: PayloadRequest,
  id: number | string,
  data: Record<string, unknown>,
): Promise<DeliveryDoc> =>
  (await payload.update({
    id,
    collection: collectionSlugs(payload).deliveries as never,
    data: data as never,
    depth: 0,
    overrideAccess: true,
    req,
  })) as unknown as DeliveryDoc

// Payload has no portable SELECT FOR UPDATE, and drizzle writes a partial update as an upsert
// that skips timestamp-only rows, so updating a row takes no lock. A lock key inserted and
// deleted in the same transaction makes every other locker of that row wait on the unique
// index until this transaction ends, and then succeed. On MongoDB the other locker instead fails
// at once with WriteConflict: claims read that as lost, owned recordings retry once, and every
// other locker (host transactions, sweeps, redelivery) still sees the error.
export const lockRow = async (
  payload: Payload,
  collection: string,
  id: number | string,
  req: PayloadRequest,
): Promise<void> => {
  if (!(await req.transactionID)) {
    throw new PluginError(`${PLUGIN_SLUG}: row locks require a transaction`, 500)
  }
  const key = `lock:${collection}:${id}`
  await payload.db.create({ collection: collectionSlugs(payload).claims, data: { key }, req })
  await payload.db.deleteMany({
    collection: collectionSlugs(payload).claims,
    req,
    where: { key: { equals: key } },
  })
}

export const summaryEntry = (
  status: DeliveryStatus,
  reason?: null | string,
): { reason?: string; status: DeliveryStatus } => (reason ? { reason, status } : { status })

export const writeSummary = async (
  payload: Payload,
  req: PayloadRequest,
  event: ConversionEventDoc,
  destination: Destination,
  status: DeliveryStatus,
  reason?: null | string,
): Promise<void> => {
  await payload.update({
    id: event.id,
    collection: collectionSlugs(payload).events as never,
    data: {
      deliverySummary: { ...event.deliverySummary, [destination]: summaryEntry(status, reason) },
    } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })
}

// Locks go event first, then delivery: the order recordConversion writes them in, so no
// lock cycle forms with a concurrent revision.
export const withLockedDelivery = <T>(
  payload: Payload,
  deliveryId: number | string,
  missing: T,
  work: (locked: {
    delivery: DeliveryDoc
    event: ConversionEventDoc | null
    req: PayloadRequest
  }) => Promise<T>,
): Promise<T> =>
  withTransaction(
    payload,
    undefined,
    async (req) => {
      const snapshot = await readDelivery(payload, deliveryId, req)
      if (!snapshot) {
        return missing
      }
      const eventId = eventIdOf(snapshot)
      const eventExists = (await readEvent(payload, eventId, req)) !== null
      if (eventExists) {
        await lockRow(payload, collectionSlugs(payload).events, eventId, req)
      }
      await lockRow(payload, collectionSlugs(payload).deliveries, deliveryId, req)
      const delivery = await readDelivery(payload, deliveryId, req)
      if (!delivery) {
        return missing
      }
      const event = eventExists ? await readEvent(payload, eventId, req) : null
      return work({ delivery, event, req })
    },
    { fresh: true },
  )
