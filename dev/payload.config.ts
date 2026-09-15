import type { Endpoint, Payload } from 'payload'

import type { AttributionPluginOptions } from '../src/types/index.js'

import { devConfig } from './config.js'
import { E2E_FEED_CREDENTIALS } from './e2eConstants.js'
import { drainOutbox, hostLedgerDispatcher } from './hostDispatcher.js'
import { MOCK_META_TOKEN } from './mockProviders.js'
import { seed } from './seed.js'

const QUEUE = 'attribution'
const mockProviders = process.env.ATTRIBUTION_MOCK_PROVIDERS_URL

if (process.env.ATTRIBUTION_E2E === 'true' && !mockProviders) {
  throw new Error(
    'ATTRIBUTION_E2E requires ATTRIBUTION_MOCK_PROVIDERS_URL so tests never reach live providers',
  )
}
const useOutbox = process.env.ATTRIBUTION_DISPATCHER === 'outbox'

const mockToken = async (): Promise<string> => {
  const response = await fetch(`${mockProviders}/token`, { method: 'POST' })
  const body = (await response.json()) as { access_token?: unknown }
  return typeof body.access_token === 'string' ? body.access_token : ''
}

const mockDestinations: Pick<AttributionPluginOptions, 'destinations' | 'endpoints'> = mockProviders
  ? {
      destinations: {
        ga4: {
          apiSecret: 'mock-api-secret',
          measurementId: 'G-MOCK000000',
          propertyId: '123456789',
        },
        googleAds: {
          accessToken: mockToken,
          adjustments: { enabled: true },
          conversionActions: { lead: '1000001', sale: '1000002' },
          feed: E2E_FEED_CREDENTIALS,
          operatingAccountId: '1234567890',
          transport: 'dataManager',
        },
        meta: {
          accessToken: MOCK_META_TOKEN,
          pixelId: '100000000000001',
          testEventCode: 'TEST00000',
        },
      },
      endpoints: {
        dataManager: mockProviders,
        ga4: mockProviders,
        ga4Admin: `${mockProviders}/v1beta`,
        meta: mockProviders,
      },
    }
  : {}

const runQueue = async (payload: Payload): Promise<{ ran: number; remaining: number }> => {
  let ran = 0
  for (let pass = 0; pass < 10; pass += 1) {
    const result = await payload.jobs.run({ limit: 100, queue: QUEUE, sequential: true })
    ran += Object.keys(result.jobStatus ?? {}).length
    if (result.noJobsRemaining || Object.keys(result.jobStatus ?? {}).length === 0) {
      return { ran, remaining: result.remainingJobsFromQueried }
    }
  }
  return { ran, remaining: -1 }
}

// Playwright drives a separate Next process, so it cannot call payload.jobs.run itself.
const runJobsEndpoint: Endpoint = {
  handler: async (req) => {
    const body = ((await req.json?.()) ?? {}) as { task?: unknown }
    if (useOutbox) {
      return Response.json(await drainOutbox(req.payload))
    }
    if (body.task === 'sweep') {
      await req.payload.jobs.queue({
        input: {},
        queue: QUEUE,
        task: 'attributionSweep',
      } as unknown as Parameters<Payload['jobs']['queue']>[0])
    }
    return Response.json(await runQueue(req.payload))
  },
  method: 'post',
  path: '/dev/run-jobs',
}

export default devConfig(
  {
    // Admins of this harness may read identifiers and request context in the ledger.
    authorize: ({ req }) => req.user?.collection === 'users',
    disabled: process.env.ATTRIBUTION_DISABLED === 'true',
    ...(useOutbox ? { dispatcher: hostLedgerDispatcher() } : {}),
    ...mockDestinations,
    queue: QUEUE,
    secret: () => process.env.ATTRIBUTION_SECRET ?? 'local-development-secret',
  },
  process.env.DATABASE_URL ?? 'file:./dev/attribution.db',
  {
    endpoints: process.env.ATTRIBUTION_E2E === 'true' ? [runJobsEndpoint] : [],
    jobs: {
      autoRun:
        process.env.ATTRIBUTION_RUN_JOBS === 'true'
          ? [{ cron: '* * * * *', limit: 25, queue: QUEUE }]
          : [],
    },
    onInit: seed,
  },
)
