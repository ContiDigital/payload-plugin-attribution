import type { ConversionEventDoc } from '../../../types/index.js'
import type { DestinationHandler, DestinationOutcome } from '../types.js'

import { collectionSlugs } from '../../../plugin/getPluginContext.js'
import { processingReceipt } from './processing.js'
import { dataManagerOutcome } from './send.js'

type Args = Parameters<DestinationHandler['deliver']>[0]
export async function prepareDataManagerAdjustment({
  delivery,
  event,
  lookup,
  now,
  payload,
}: { delivery?: Args['delivery'] } & Pick<Args, 'event' | 'lookup' | 'now' | 'payload'>): Promise<
  ConversionEventDoc | DestinationOutcome
> {
  if (event.googleAdsKind !== 'restatement') {
    return { kind: 'withheld', reason: 'data_manager_retraction_unsupported' }
  }
  if (
    !event.transactionId ||
    !Number.isSafeInteger(event.adjustedValueCents) ||
    event.adjustedValueCents! < 0
  ) {
    return { kind: 'dead', reason: 'invalid_adjustment' }
  }
  const original = await lookup.originalConversion(event)
  if (
    !original?.delivery ||
    ['dead', 'superseded', 'withheld'].includes(original.delivery.status)
  ) {
    return { kind: 'withheld', reason: 'original_not_delivered' }
  }
  const waiting = (reason: string): DestinationOutcome => ({
    deadlineAt: new Date(Date.parse(event.createdAt) + 7 * 86400_000).toISOString(),
    kind: 'wait',
    reason,
    until: new Date(now.getTime() + 5 * 60_000).toISOString(),
  })
  if (original.delivery.status !== 'sent') {
    return waiting('awaiting_original')
  }
  // Coalesce older, unsent totals. A manual replay of an old refund must not restore revenue.
  // An already submitted request must finish processing before a newer adjustment can run.
  if (!processingReceipt(delivery?.response)) {
    const newer = await payload.find({
      collection: collectionSlugs(payload).events as never,
      depth: 0,
      joins: false,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { transactionId: { equals: event.transactionId } },
          { googleAdsAction: { equals: event.googleAdsAction } },
          { googleAdsKind: { equals: 'restatement' } },
          {
            or: [
              { createdAt: { greater_than: event.createdAt } },
              {
                and: [
                  { createdAt: { equals: event.createdAt } },
                  { id: { greater_than: event.id } },
                ],
              },
            ],
          },
        ],
      },
    })
    if (newer.docs.length) {
      return { kind: 'withheld', reason: 'superseded_adjustment' }
    }
  }
  // Serialize adjustments for this order/action. An older retry must never restore revenue
  // after a newer refund has reduced it. Failed predecessors do not block the latest total.
  const preceding = await payload.find({
    collection: collectionSlugs(payload).events as never,
    depth: 0,
    joins: false,
    overrideAccess: true,
    pagination: false,
    where: {
      and: [
        { transactionId: { equals: event.transactionId } },
        { googleAdsAction: { equals: event.googleAdsAction } },
        { googleAdsKind: { equals: 'restatement' } },
        {
          or: [
            { createdAt: { less_than: event.createdAt } },
            { and: [{ createdAt: { equals: event.createdAt } }, { id: { less_than: event.id } }] },
          ],
        },
      ],
    },
  })
  if (preceding.docs.length) {
    const pending = await payload.find({
      collection: collectionSlugs(payload).deliveries as never,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { event: { in: preceding.docs.map((row) => row.id) } },
          { destination: { equals: 'googleAdsAdjustment' } },
          { status: { in: ['pending', 'sending', 'retry'] } },
        ],
      },
    })
    if (pending.docs.length) {
      return waiting('awaiting_prior_adjustment')
    }
  }
  return { ...original.event, consent: event.consent, valueCents: event.adjustedValueCents }
}

export const deliverDataManagerAdjustment = async (args: Args): Promise<DestinationOutcome> => {
  const prepared = await prepareDataManagerAdjustment(args)
  if ('kind' in prepared) {
    return prepared
  }
  return dataManagerOutcome(
    prepared,
    args.options.destinations.googleAds!,
    args.options.endpoints.dataManager,
    args.now,
    args.signal,
    args.delivery,
  )
}
