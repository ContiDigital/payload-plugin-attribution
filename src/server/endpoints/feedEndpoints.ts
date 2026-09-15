import type { Endpoint, Payload, PayloadRequest, Where } from 'payload'

import type {
  ConversionEventDoc,
  DeliveryDoc,
  Destination,
  NormalizedGoogleAdsOptions,
  NormalizedOptions,
} from '../../types/index.js'
import type { Logger } from '../utilities/logger.js'

import { DEFAULT_FEED_LOOKBACK_DAYS, FEED_PAGE_SIZE, FEED_REALM } from '../../constants.js'
import { DAY_MS } from '../../core/time.js'
import { collectionSlugs } from '../../plugin/getPluginContext.js'
import { loadAdjustmentContext } from '../deliveries/adjustmentContext.js'
import { eventIdOf, updateDelivery, withLockedDelivery, writeSummary } from '../deliveries/store.js'
import { googleAdsFeedEligibility } from '../destinations/googleAds/eligibility.js'
import { decideAdjustment } from '../destinations/googleAdsFeed/adjustmentDecision.js'
import {
  ADJUSTMENT_HEADERS,
  CONVERSION_HEADERS,
  writeCsv,
} from '../destinations/googleAdsFeed/csv.js'
import {
  adjustmentRow,
  conversionNotApplicable,
  conversionRow,
} from '../destinations/googleAdsFeed/rows.js'
import { SettingUnavailableError } from '../utilities/errors.js'
import { createLogger } from '../utilities/logger.js'
import { feedAuthorized, feedCredentials } from './basicAuth.js'

type FeedFile = 'adjustments' | 'conversions'
type Candidate = { delivery: DeliveryDoc; event: ConversionEventDoc }
type Verdict =
  { kind: 'row'; row: string[] } | { kind: 'skip' } | { kind: 'withhold'; reason: string }
type BuildContext = {
  googleAds: NormalizedGoogleAdsOptions
  now: Date
  payload: Payload
}
type Settlement = { now: Date; status: 'served' } | { reason: string; status: 'withheld' }

const SERVABLE_STATUSES = ['eligible', 'served']
const SKIP: Verdict = { kind: 'skip' }

const rowVerdict = (row: null | string[]): Verdict => (row ? { kind: 'row', row } : SKIP)

const conversionVerdict = (
  event: ConversionEventDoc,
  { googleAds, now }: BuildContext,
): Verdict => {
  if (conversionNotApplicable(event)) {
    return { kind: 'withhold', reason: 'not_applicable' }
  }
  const eligibility = googleAdsFeedEligibility(event, now, googleAds.allowBraidsInFeed)
  if (!eligibility.eligible) {
    return { kind: 'withhold', reason: eligibility.reason }
  }
  return rowVerdict(
    conversionRow(event, googleAds.conversionActions, {
      allowBraids: googleAds.allowBraidsInFeed,
      now,
    }),
  )
}

const FEEDS: Record<
  FeedFile,
  {
    build: (candidates: Candidate[], context: BuildContext) => Promise<Array<() => Verdict>>
    destination: Destination
    enabled: (googleAds: NormalizedGoogleAdsOptions) => boolean
    headers: readonly string[]
  }
> = {
  adjustments: {
    build: async (candidates, context) => {
      const { googleAds, now, payload } = context
      const orders = await loadAdjustmentContext(
        payload,
        candidates.map(({ event }) => event),
      )
      return candidates.map(({ delivery, event }) => () => {
        // Rows served before the retraction stay in the file; only unserved rows are dropped.
        const outcome = decideAdjustment({
          event,
          now,
          original: orders.original(event)?.delivery ?? null,
          retracted: delivery.status === 'eligible' && orders.retracted(event),
        })
        if (outcome.kind === 'withheld') {
          return { kind: 'withhold', reason: outcome.reason }
        }
        return outcome.kind === 'eligible'
          ? rowVerdict(adjustmentRow(event, googleAds.conversionActions))
          : SKIP
      })
    },
    destination: 'googleAdsAdjustment',
    enabled: (googleAds) => googleAds.adjustments.enabled,
    headers: ADJUSTMENT_HEADERS,
  },
  conversions: {
    build: (candidates, context) =>
      Promise.resolve(
        candidates.map(
          ({ event }) =>
            () =>
              conversionVerdict(event, context),
        ),
      ),
    destination: 'googleAds',
    enabled: (googleAds) => googleAds.transport === 'feed',
    headers: CONVERSION_HEADERS,
  },
}

const noStore = (extra: Record<string, string> = {}): Headers =>
  new Headers({ 'Cache-Control': 'no-store', ...extra })

const unauthorized = (): Response =>
  new Response('Unauthorized', {
    headers: noStore({ 'WWW-Authenticate': `Basic realm="${FEED_REALM}", charset="UTF-8"` }),
    status: 401,
  })

const after = (cursor: DeliveryDoc): Where => ({
  or: [
    { createdAt: { greater_than: cursor.createdAt } },
    { and: [{ createdAt: { equals: cursor.createdAt } }, { id: { greater_than: cursor.id } }] },
  ],
})

// Reads run without a transaction so the feed never blocks recordConversion. Events are read
// in one query per page with joins disabled; populating the relationship would also resolve
// every event's deliveries join.
async function* candidatePages(
  payload: Payload,
  destination: Destination,
  floor: Date,
): AsyncGenerator<Candidate[]> {
  let cursor: DeliveryDoc | undefined
  for (;;) {
    const page = await payload.find({
      collection: collectionSlugs(payload).deliveries as never,
      depth: 0,
      limit: FEED_PAGE_SIZE,
      overrideAccess: true,
      pagination: false,
      sort: ['createdAt', 'id'],
      where: {
        and: [
          { destination: { equals: destination } },
          { status: { in: SERVABLE_STATUSES } },
          { 'event.occurredAt': { greater_than_equal: floor.toISOString() } },
          ...(cursor ? [after(cursor)] : []),
        ],
      },
    })
    const deliveries = page.docs as unknown as DeliveryDoc[]
    if (deliveries.length === 0) {
      return
    }
    const ids = [...new Set(deliveries.map(eventIdOf))]
    const events = await payload.find({
      collection: collectionSlugs(payload).events as never,
      depth: 0,
      joins: false,
      overrideAccess: true,
      pagination: false,
      where: { id: { in: ids } },
    })
    const byId = new Map(
      (events.docs as unknown as ConversionEventDoc[]).map((event) => [String(event.id), event]),
    )
    yield deliveries.flatMap((delivery) => {
      const event = byId.get(String(eventIdOf(delivery)))
      return event && event.revision === delivery.revision ? [{ delivery, event }] : []
    })
    if (deliveries.length < FEED_PAGE_SIZE) {
      return
    }
    cursor = deliveries[deliveries.length - 1]
  }
}

// Each row is written once: served rows keep their first serving and withheld rows leave the
// feed query, so a repeated pull of unchanged rows writes nothing.
const settleRow = async (
  payload: Payload,
  deliveryId: number | string,
  settlement: Settlement,
  log: Logger,
): Promise<void> => {
  try {
    await withLockedDelivery(payload, deliveryId, undefined, async ({ delivery, event, req }) => {
      if (event && event.revision !== delivery.revision) {
        return
      }
      if (settlement.status === 'served') {
        const unstamped =
          delivery.status === 'eligible' ||
          (delivery.status === 'served' && !delivery.firstServedAt)
        if (!unstamped) {
          return
        }
        const servedAt = settlement.now.toISOString()
        await updateDelivery(payload, req, delivery.id, {
          firstServedAt: delivery.firstServedAt ?? servedAt,
          lastServedAt: servedAt,
          status: 'served',
        })
      } else {
        if (delivery.status !== 'eligible') {
          return
        }
        await updateDelivery(payload, req, delivery.id, {
          reason: settlement.reason,
          status: 'withheld',
        })
      }
      if (event) {
        const reason = settlement.status === 'withheld' ? settlement.reason : undefined
        await writeSummary(payload, req, event, delivery.destination, settlement.status, reason)
      }
    })
  } catch (error) {
    log.error('could not record a feed row outcome', {
      deliveryId,
      error,
      status: settlement.status,
    })
  }
}

const feedEndpoint = (options: NormalizedOptions, file: FeedFile): Endpoint => ({
  handler: async (req: PayloadRequest): Promise<Response> => {
    const googleAds = options.destinations.googleAds
    let credentials: Awaited<ReturnType<typeof feedCredentials>>
    try {
      credentials = await feedCredentials(googleAds)
    } catch (error) {
      if (!(error instanceof SettingUnavailableError)) {
        throw error
      }
      // Not a wrong password: the scheduled upload should try again later.
      createLogger(req.payload).warn('feed credentials could not be resolved', {
        error: error.cause,
      })
      return new Response('Service unavailable', {
        headers: noStore({ 'Retry-After': '300' }),
        status: 503,
      })
    }
    const { password, username } = credentials
    if (!feedAuthorized(req.headers.get('authorization'), username, password)) {
      // Never log the submitted header; repeated warnings point at guessing or a stale password.
      createLogger(req.payload).warn('feed authentication failed', { file })
      return unauthorized()
    }
    const feed = FEEDS[file]
    if (!googleAds?.enabled || !feed.enabled(googleAds)) {
      return new Response('Not found', { headers: noStore(), status: 404 })
    }

    const { payload } = req
    const log = createLogger(payload)
    const now = new Date()
    const lookbackDays = googleAds.feed?.lookbackDays ?? DEFAULT_FEED_LOOKBACK_DAYS
    const floor = new Date(now.getTime() - lookbackDays * DAY_MS)
    const context: BuildContext = { googleAds, now, payload }

    const rows: string[][] = []
    const settlements: Array<{ deliveryId: number | string; settlement: Settlement }> = []
    for await (const candidates of candidatePages(payload, feed.destination, floor)) {
      const verdicts = await feed.build(candidates, context)
      candidates.forEach(({ delivery }, index) => {
        let verdict: Verdict
        try {
          verdict = verdicts[index]()
        } catch (error) {
          log.warn('feed row skipped', { deliveryId: delivery.id, error })
          return
        }
        if (verdict.kind === 'withhold') {
          // A served row already reached Google; it only leaves the file.
          if (delivery.status === 'served') {
            return
          }
          settlements.push({
            deliveryId: delivery.id,
            settlement: { reason: verdict.reason, status: 'withheld' },
          })
        } else if (verdict.kind === 'row') {
          rows.push(verdict.row)
          if (delivery.status !== 'served' || !delivery.firstServedAt) {
            settlements.push({ deliveryId: delivery.id, settlement: { now, status: 'served' } })
          }
        }
      })
    }
    const body = writeCsv(feed.headers, rows)

    // Outcomes are written before the response, so a response Google never receives still marks
    // its rows served. That is safe: Google re-pulls the whole lookback on every run and
    // deduplicates by order id, and adjustment windows only open 24 hours after first serving.
    for (const { deliveryId, settlement } of settlements) {
      await settleRow(payload, deliveryId, settlement, log)
    }
    return new Response(body, {
      headers: noStore({
        'Content-Type': 'text/csv; charset=utf-8',
        'X-Conversion-Rows': String(rows.length),
      }),
      status: 200,
    })
  },
  method: 'get',
  path: `${options.apiBasePath}/google-ads/${file}.csv`,
})

export const feedEndpoints = (options: NormalizedOptions): Endpoint[] => [
  feedEndpoint(options, 'conversions'),
  feedEndpoint(options, 'adjustments'),
]
