import type { Endpoint, Payload, Where } from 'payload'

import type { DeliveryDoc, DeliveryStatus, NormalizedOptions } from '../../types/index.js'

import { DELIVERY_STATUSES } from '../../constants.js'
import { DAY_MS } from '../../core/time.js'
import { collectionSlugs } from '../../plugin/getPluginContext.js'
import { errorResponse, jsonResponse } from './errorResponse.js'
import { requireScope } from './requireScope.js'

export type HealthReport = {
  counts: Record<DeliveryStatus, number>
  deadLast24h: number
  expiredLeases: number
  oldestPendingAt: null | string
}

const countDeliveries = async (payload: Payload, where: Where): Promise<number> =>
  (
    await payload.count({
      collection: collectionSlugs(payload).deliveries as never,
      overrideAccess: true,
      where,
    })
  ).totalDocs

const healthReport = async (payload: Payload, now: number): Promise<HealthReport> => {
  const [statusCounts, expiredLeases, deadLast24h, oldest] = await Promise.all([
    Promise.all(
      DELIVERY_STATUSES.map(
        async (status) =>
          [status, await countDeliveries(payload, { status: { equals: status } })] as const,
      ),
    ),
    countDeliveries(payload, {
      and: [
        { status: { equals: 'sending' } },
        { leaseExpiresAt: { less_than: new Date(now).toISOString() } },
      ],
    }),
    countDeliveries(payload, {
      and: [
        { status: { equals: 'dead' } },
        { updatedAt: { greater_than_equal: new Date(now - DAY_MS).toISOString() } },
      ],
    }),
    payload.find({
      collection: collectionSlugs(payload).deliveries as never,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      sort: 'createdAt',
      where: { status: { equals: 'pending' } },
    }),
  ])
  const [first] = oldest.docs as unknown as DeliveryDoc[]
  return {
    counts: Object.fromEntries(statusCounts) as Record<DeliveryStatus, number>,
    deadLast24h,
    expiredLeases,
    oldestPendingAt: first?.createdAt ?? null,
  }
}

export const healthEndpoint = (options: NormalizedOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await requireScope(options, req, 'read')
      return jsonResponse(await healthReport(req.payload, Date.now()))
    } catch (error) {
      return errorResponse(req.payload, error)
    }
  },
  method: 'get',
  path: `${options.apiBasePath}/health`,
})
