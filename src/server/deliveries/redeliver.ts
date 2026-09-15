import type { Payload, PayloadRequest } from 'payload'

import type { DeliveryDoc, Destination } from '../../types/index.js'

import { DESTINATIONS } from '../../constants.js'
import { collectionSlugs, getPluginContext } from '../../plugin/getPluginContext.js'
import { ConflictError, NotFoundError, ValidationError } from '../utilities/errors.js'
import { createLogger } from '../utilities/logger.js'
import { currentTransactionReq, withTransaction } from '../utilities/transaction.js'
import { planDeliveries } from './planDeliveries.js'
import {
  isTerminal,
  lockRow,
  readEvent,
  RELEASED_LEASE,
  summaryEntry,
  time,
  updateDelivery,
} from './store.js'

const latestByDestination = async (
  payload: Payload,
  req: PayloadRequest,
  eventId: number | string,
  revision: number,
): Promise<Map<Destination, DeliveryDoc>> => {
  const { docs } = await payload.find({
    collection: collectionSlugs(payload).deliveries as never,
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    req,
    sort: '-sequence',
    where: { and: [{ event: { equals: eventId } }, { revision: { equals: revision } }] },
  })
  const latest = new Map<Destination, DeliveryDoc>()
  for (const row of docs as unknown as DeliveryDoc[]) {
    if (!latest.has(row.destination)) {
      latest.set(row.destination, row)
    }
  }
  return latest
}

export async function redeliverConversion(args: {
  destinations?: Destination[]
  eventId: number | string
  force?: boolean
  now?: Date
  payload: Payload
  req?: PayloadRequest
}): Promise<DeliveryDoc[]> {
  const { eventId, force = false, now = new Date(), payload } = args
  const { options } = getPluginContext(payload)
  if (options.disabled) {
    return []
  }
  const joined =
    args.req && (await args.req.transactionID) ? args.req : currentTransactionReq(payload)

  const created = await withTransaction(payload, args.req, async (req) => {
    if (!(await readEvent(payload, eventId, req))) {
      throw new NotFoundError('event_not_found')
    }
    await lockRow(payload, collectionSlugs(payload).events, eventId, req)
    const event = await readEvent(payload, eventId, req)
    if (!event) {
      throw new NotFoundError('event_not_found')
    }
    // A purged event has lost its click ids and hashed identifiers, so a resend reaches providers
    // with less than the original delivery did.
    if (event.identifiersPurgedAt && !force) {
      throw new ConflictError('identifiers_purged')
    }
    const latest = await latestByDestination(payload, req, event.id, event.revision)
    const requested = args.destinations
      ? [...new Set(args.destinations)]
      : DESTINATIONS.filter((name) => latest.has(name))
    const plan = planDeliveries(
      event,
      options,
      Object.fromEntries(requested.map((name) => [name, true])),
    )
    for (const destination of requested) {
      const previous = latest.get(destination)
      // A feed row Google already pulled counts as sent: superseding it would serve it again.
      const delivered =
        previous?.status === 'sent' ||
        previous?.status === 'served' ||
        Boolean(previous?.firstServedAt)
      if (delivered && !force) {
        throw new ConflictError('already_sent')
      }
      if (previous?.status === 'sending' && time(previous.leaseExpiresAt) > now.getTime()) {
        throw new ConflictError('delivery_in_progress')
      }
      if (!plan.some((row) => row.destination === destination)) {
        throw new ValidationError(`destination_not_applicable: ${destination}`)
      }
    }

    const summary = { ...event.deliverySummary }
    const rows: DeliveryDoc[] = []
    for (const destination of requested) {
      const planned = plan.find((row) => row.destination === destination)
      const previous = latest.get(destination)
      if (!planned) {
        continue
      }
      if (previous && !isTerminal(previous.status)) {
        await updateDelivery(payload, req, previous.id, {
          ...RELEASED_LEASE,
          reason: 'redelivered',
          status: 'superseded',
        })
      }
      const sequence = previous ? previous.sequence + 1 : 0
      const row = (await payload.create({
        collection: collectionSlugs(payload).deliveries as never,
        data: {
          attempt: 0,
          destination,
          event: event.id,
          key: `${event.id}:${destination}:r${event.revision}:s${sequence}`,
          lastDispatchedAt: planned.status === 'pending' ? now.toISOString() : undefined,
          reason: planned.reason,
          revision: event.revision,
          sequence,
          status: planned.status,
        } as never,
        depth: 0,
        overrideAccess: true,
        req,
      })) as unknown as DeliveryDoc
      summary[destination] = summaryEntry(row.status, row.reason)
      rows.push(row)
    }
    await payload.update({
      id: event.id,
      collection: collectionSlugs(payload).events as never,
      data: { deliverySummary: summary } as never,
      depth: 0,
      overrideAccess: true,
      req,
    })
    return rows
  })

  for (const row of created.filter((candidate) => candidate.status === 'pending')) {
    if (joined) {
      await options.dispatcher.dispatch({ deliveryId: row.id, payload, req: joined })
      continue
    }
    try {
      await options.dispatcher.dispatch({ deliveryId: row.id, payload })
    } catch (error) {
      createLogger(payload).error(
        'dispatch failed after commit, the sweep re-dispatches pending deliveries',
        { deliveryId: row.id, error },
      )
    }
  }
  return created
}
