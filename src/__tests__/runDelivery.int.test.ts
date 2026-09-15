import type { Payload } from 'payload'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DestinationHandler } from '../server/destinations/types.js'
import type {
  ConversionDraft,
  ConversionEventDoc,
  DeliveryDoc,
  Destination,
} from '../types/index.js'

import {
  DEFAULT_QUEUE,
  DELIVERIES_SLUG,
  EVENTS_SLUG,
  LEASE_MS,
  TASK_DELIVER,
  TASK_SWEEP,
} from '../constants.js'
import { claimDelivery } from '../server/deliveries/claimDelivery.js'
import { runDelivery } from '../server/deliveries/runDelivery.js'
import { sweepDeliveries } from '../server/deliveries/sweep.js'
import {
  registerDestinationHandler,
  resetDestinationHandlers,
} from '../server/destinations/registry.js'
import { recordConversion } from '../server/record/recordConversion.js'
import {
  bootPayload,
  databaseName,
  destroyPayloads,
  mongodbUrl,
  recordingDispatcher,
} from './helpers/bootPayload.js'

type Deliver = DestinationHandler['deliver']
type DeliverArgs = Parameters<Deliver>[0]
type JobRow = {
  completedAt?: null | string
  input: { deliveryId?: string }
  queue: string
  waitUntil?: null | string
}

const HOUR = 3_600_000
const START = new Date('2026-09-14T12:00:00.000Z')
const ga4Options = { apiSecret: 'ga4-secret', measurementId: 'G-TEST' }

const { calls, dispatcher } = recordingDispatcher()
const handlerCalls: DeliverArgs[] = []
const sent: Deliver = () => Promise.resolve({ kind: 'sent' })
let behavior: Deliver = sent
let payload: Payload

const fakeHandler = (destination: Destination): DestinationHandler => ({
  deliver: (args) => {
    handlerCalls.push(args)
    return behavior(args)
  },
  destination,
})

const at = (value?: null | string): number => Date.parse(value ?? '')

const lead = (eventKey: string, overrides: Partial<ConversionDraft> = {}): ConversionDraft => ({
  name: 'generate_lead',
  consent: { adUserData: 'granted' },
  eventKey,
  occurredAt: '2026-09-14T10:00:00.000Z',
  ...overrides,
})

const readDelivery = async (id: number | string, target = payload): Promise<DeliveryDoc> =>
  (await target.findByID({
    id,
    collection: DELIVERIES_SLUG as never,
    depth: 0,
    overrideAccess: true,
  })) as unknown as DeliveryDoc

const readEvent = async (id: number | string): Promise<ConversionEventDoc> =>
  (await payload.findByID({
    id,
    collection: EVENTS_SLUG as never,
    depth: 0,
    joins: false,
    overrideAccess: true,
  })) as unknown as ConversionEventDoc

const updateDelivery = (id: number | string, data: Partial<DeliveryDoc>) =>
  payload.update({
    id,
    collection: DELIVERIES_SLUG as never,
    data: data as never,
    depth: 0,
    overrideAccess: true,
  })

const record = async (eventKey: string, target = payload) => {
  const event = await recordConversion({ draft: lead(eventKey), payload: target })
  if (!event) {
    throw new Error(`${eventKey} was not recorded`)
  }
  const { docs } = await target.find({
    collection: DELIVERIES_SLUG as never,
    depth: 0,
    overrideAccess: true,
    where: { event: { equals: event.id } },
  })
  const rows = docs as unknown as DeliveryDoc[]
  calls.length = 0
  return {
    event,
    row: (destination: Destination): DeliveryDoc => {
      const found = rows.find((candidate) => candidate.destination === destination)
      if (!found) {
        throw new Error(`${eventKey} has no ${destination} delivery`)
      }
      return found
    },
  }
}

beforeAll(async () => {
  payload = await bootPayload({
    label: 'run_delivery',
    options: {
      destinations: {
        ga4: ga4Options,
        meta: { accessToken: 'meta-token', pixelId: '42', timeoutMs: 50 },
      },
      dispatcher,
      secret: 'run-delivery-test-secret',
    },
  })
})

beforeEach(() => {
  resetDestinationHandlers()
  registerDestinationHandler(fakeHandler('ga4'))
  registerDestinationHandler(fakeHandler('meta'))
  behavior = sent
  handlerCalls.length = 0
  calls.length = 0
})

afterAll(async () => {
  resetDestinationHandlers()
  await destroyPayloads()
})

describe(`runDelivery on ${databaseName}`, () => {
  it('records a sent outcome, its sentAt and the event summary', async () => {
    behavior = () =>
      Promise.resolve({ kind: 'sent', request: { body: { id: 1 } }, response: { ok: true } })
    const { event, row } = await record('run-sent')
    const ga4 = row('ga4')

    const result = await runDelivery({ deliveryId: ga4.id, now: START, payload })
    expect(result).toMatchObject({ deliveryId: ga4.id, status: 'sent' })
    const stored = await readDelivery(ga4.id)
    expect(stored).toMatchObject({
      attempt: 1,
      request: { body: { id: 1 } },
      response: { ok: true },
      status: 'sent',
    })
    expect(at(stored.sentAt)).toBe(START.getTime())
    expect(stored.leaseExpiresAt ?? null).toBeNull()
    expect((await readEvent(event.id)).deliverySummary).toMatchObject({
      ga4: { status: 'sent' },
      meta: { status: 'pending' },
    })
    expect(handlerCalls).toHaveLength(1)
    expect(handlerCalls[0]).toMatchObject({
      delivery: { id: ga4.id, attempt: 1, status: 'sending' },
      event: { id: event.id },
      now: START,
    })
    expect(calls).toHaveLength(0)

    expect(await runDelivery({ deliveryId: ga4.id, now: START, payload })).toMatchObject({
      status: 'sent',
    })
    expect(handlerCalls).toHaveLength(1)
  })

  it('keeps the attempt count across waits and withholds once the deadline passes', async () => {
    const deadline = new Date(START.getTime() + 24 * HOUR)
    behavior = ({ now }) =>
      Promise.resolve({
        deadlineAt: deadline.toISOString(),
        kind: 'wait',
        reason: 'feed_window',
        until: new Date(now.getTime() + HOUR).toISOString(),
      })
    const { event, row } = await record('run-wait')
    const ga4 = row('ga4')

    let now = START
    for (let run = 1; run <= 5; run++) {
      const result = await runDelivery({ deliveryId: ga4.id, now, payload })
      expect(result).toMatchObject({ reason: 'feed_window', status: 'retry' })
      expect(at(result.nextAttemptAt)).toBe(now.getTime() + HOUR)
      const stored = await readDelivery(ga4.id)
      expect(stored).toMatchObject({ attempt: 0, reason: 'feed_window', status: 'retry' })
      expect(at(stored.deadlineAt)).toBe(deadline.getTime())
      expect(at(stored.nextAttemptAt)).toBe(now.getTime() + HOUR)
      expect(calls.at(-1)?.deliveryId).toBe(ga4.id)
      expect(calls.at(-1)?.notBefore?.getTime()).toBe(now.getTime() + HOUR)

      expect(await runDelivery({ deliveryId: ga4.id, now, payload })).toMatchObject({
        status: 'not_due',
      })
      now = new Date(now.getTime() + HOUR)
    }
    expect(handlerCalls).toHaveLength(5)

    const closed = await runDelivery({ deliveryId: ga4.id, now: deadline, payload })
    expect(closed).toMatchObject({ reason: 'deadline_passed', status: 'withheld' })
    expect(await readDelivery(ga4.id)).toMatchObject({ attempt: 0, status: 'withheld' })
    expect(handlerCalls).toHaveLength(5)
    expect((await readEvent(event.id)).deliverySummary?.ga4).toEqual({
      reason: 'deadline_passed',
      status: 'withheld',
    })
  })

  it('backs off retries and becomes dead after six attempts', async () => {
    behavior = () =>
      Promise.resolve({ kind: 'retry', reason: 'http_503', response: { status: 503 } })
    const { event, row } = await record('run-retry')
    const ga4 = row('ga4')

    let now = START
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await runDelivery({ deliveryId: ga4.id, now, payload })
      expect(result).toMatchObject({ reason: 'http_503', status: 'retry' })
      const stored = await readDelivery(ga4.id)
      expect(stored).toMatchObject({ attempt, response: { status: 503 }, status: 'retry' })
      const base = Math.min(30_000 * 2 ** (attempt - 1), 1_800_000)
      const wait = at(stored.nextAttemptAt) - now.getTime()
      expect(wait).toBeGreaterThanOrEqual(base * 0.8)
      expect(wait).toBeLessThanOrEqual(base * 1.2)
      expect(calls.at(-1)?.notBefore?.getTime()).toBe(at(stored.nextAttemptAt))
      now = new Date(at(stored.nextAttemptAt))
    }

    const last = await runDelivery({ deliveryId: ga4.id, now, payload })
    expect(last).toMatchObject({ reason: 'retry_exhausted', status: 'dead' })
    expect(await readDelivery(ga4.id)).toMatchObject({
      attempt: 6,
      reason: 'retry_exhausted',
      status: 'dead',
    })
    expect((await readEvent(event.id)).deliverySummary?.ga4).toEqual({
      reason: 'retry_exhausted',
      status: 'dead',
    })
    expect(handlerCalls).toHaveLength(6)
  })

  it('aborts a handler that hangs past the destination timeout', async () => {
    let observed: AbortSignal | undefined
    behavior = ({ signal }) => {
      observed = signal
      return new Promise(() => undefined)
    }
    const meta = (await record('run-timeout')).row('meta')
    const started = Date.now()
    const result = await runDelivery({ deliveryId: meta.id, now: START, payload })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result).toMatchObject({ reason: 'timeout', status: 'retry' })
    expect(observed?.aborted).toBe(true)
    expect(await readDelivery(meta.id)).toMatchObject({
      attempt: 1,
      reason: 'timeout',
      status: 'retry',
    })
  })

  it('maps a thrown handler error to an unexpected_error retry', async () => {
    const errorLog = vi.spyOn(payload.logger, 'error').mockImplementation(() => undefined)
    behavior = () => Promise.reject(new Error('socket closed'))
    const ga4 = (await record('run-throws')).row('ga4')
    expect(await runDelivery({ deliveryId: ga4.id, now: START, payload })).toMatchObject({
      reason: 'unexpected_error',
      status: 'retry',
    })
    expect(await readDelivery(ga4.id)).toMatchObject({ attempt: 1, status: 'retry' })
    expect(errorLog).toHaveBeenCalled()
    errorLog.mockRestore()
  })

  it('does not overwrite a newer attempt when the lease was reclaimed mid-flight', async () => {
    const warnLog = vi.spyOn(payload.logger, 'warn').mockImplementation(() => undefined)
    behavior = async ({ delivery }) => {
      await updateDelivery(delivery.id, { attempt: delivery.attempt + 1 })
      return { kind: 'sent' }
    }
    const { event, row } = await record('run-reclaimed')
    const ga4 = row('ga4')
    const result = await runDelivery({ deliveryId: ga4.id, now: START, payload })
    expect(result).toMatchObject({ status: 'claimed_elsewhere' })
    const stored = await readDelivery(ga4.id)
    expect(stored).toMatchObject({ attempt: 2, status: 'sending' })
    expect(stored.sentAt ?? null).toBeNull()
    expect((await readEvent(event.id)).deliverySummary?.ga4).toEqual({ status: 'pending' })
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('delivery lease was reclaimed') }),
    )
    warnLog.mockRestore()
  })

  it('does not overwrite a delivery that stopped sending mid-flight', async () => {
    const warnLog = vi.spyOn(payload.logger, 'warn').mockImplementation(() => undefined)
    behavior = async ({ delivery }) => {
      await updateDelivery(delivery.id, { reason: 'operator', status: 'dead' })
      return { kind: 'sent' }
    }
    const ga4 = (await record('run-stopped')).row('ga4')
    expect(await runDelivery({ deliveryId: ga4.id, now: START, payload })).toMatchObject({
      status: 'claimed_elsewhere',
    })
    expect(await readDelivery(ga4.id)).toMatchObject({ reason: 'operator', status: 'dead' })
    expect(warnLog).toHaveBeenCalled()
    warnLog.mockRestore()
  })

  it('supersedes a stale revision without calling the handler', async () => {
    const { event, row } = await record('run-stale-before')
    const ga4 = row('ga4')
    await payload.update({
      id: event.id,
      collection: EVENTS_SLUG as never,
      data: { revision: 2 } as never,
      overrideAccess: true,
    })
    const result = await runDelivery({ deliveryId: ga4.id, now: START, payload })
    expect(result).toMatchObject({ reason: 'revision_superseded', status: 'superseded' })
    expect(handlerCalls).toHaveLength(0)
    expect(await readDelivery(ga4.id)).toMatchObject({
      reason: 'revision_superseded',
      status: 'superseded',
    })
  })

  it('supersedes instead of writing sent when the revision changed mid-flight', async () => {
    behavior = async ({ event }) => {
      await payload.update({
        id: event.id,
        collection: EVENTS_SLUG as never,
        data: { revision: 2 } as never,
        overrideAccess: true,
      })
      return { kind: 'sent' }
    }
    const ga4 = (await record('run-stale-during')).row('ga4')
    expect(await runDelivery({ deliveryId: ga4.id, now: START, payload })).toMatchObject({
      status: 'superseded',
    })
    const stored = await readDelivery(ga4.id)
    expect(stored).toMatchObject({ reason: 'revision_superseded', status: 'superseded' })
    expect(stored.sentAt ?? null).toBeNull()
  })

  it('holds no database transaction while the handler runs', { timeout: 2000 }, async () => {
    behavior = async () => {
      const nested = await recordConversion({ draft: lead('recorded-by-handler'), payload })
      expect(nested?.eventKey).toBe('recorded-by-handler')
      return { kind: 'sent' }
    }
    const ga4 = (await record('run-no-transaction')).row('ga4')
    expect(await runDelivery({ deliveryId: ga4.id, now: START, payload })).toMatchObject({
      status: 'sent',
    })
    const { totalDocs } = await payload.count({
      collection: EVENTS_SLUG as never,
      overrideAccess: true,
      where: { eventKey: { equals: 'recorded-by-handler' } },
    })
    expect(totalDocs).toBe(1)
  })

  it('withholds a destination with no registered handler', async () => {
    resetDestinationHandlers()
    const ga4 = (await record('run-no-handler')).row('ga4')
    expect(await runDelivery({ deliveryId: ga4.id, now: START, payload })).toMatchObject({
      reason: 'no_handler',
      status: 'withheld',
    })
  })

  it('reports not_found and leaves a live lease to its holder', async () => {
    // A well-formed id of the adapter's own id type that matches no row.
    const missingDeliveryId = mongodbUrl ? '0123456789abcdef01234567' : 987_654
    expect(await runDelivery({ deliveryId: missingDeliveryId, now: START, payload })).toMatchObject(
      {
        status: 'not_found',
      },
    )
    const ga4 = (await record('run-live-lease')).row('ga4')
    expect(await claimDelivery(payload, ga4, START)).not.toBeNull()
    expect(await runDelivery({ deliveryId: ga4.id, now: START, payload })).toMatchObject({
      status: 'claimed_elsewhere',
    })
    expect(handlerCalls).toHaveLength(0)
    expect(await readDelivery(ga4.id)).toMatchObject({ attempt: 1, status: 'sending' })
  })
  it('reports not_found for an id the adapter cannot parse', async () => {
    expect(await runDelivery({ deliveryId: 'not-a-valid-id', now: START, payload })).toMatchObject({
      deliveryId: 'not-a-valid-id',
      status: 'not_found',
    })
    expect(handlerCalls).toHaveLength(0)
  })
  it('clears a wait deadline when a later outcome is an ordinary retry', async () => {
    let waiting = true
    behavior = ({ now }) => {
      if (!waiting) {
        return Promise.resolve({ kind: 'retry', reason: 'http_503' })
      }
      waiting = false
      return Promise.resolve({
        deadlineAt: new Date(now.getTime() + 2 * HOUR).toISOString(),
        kind: 'wait',
        reason: 'feed_window',
        until: new Date(now.getTime() + HOUR).toISOString(),
      })
    }
    const ga4 = (await record('run-deadline-cleared')).row('ga4')
    await runDelivery({ deliveryId: ga4.id, now: START, payload })
    expect((await readDelivery(ga4.id)).deadlineAt).toBeTruthy()
    await runDelivery({ deliveryId: ga4.id, now: new Date(START.getTime() + HOUR), payload })
    const stored = await readDelivery(ga4.id)
    expect(stored).toMatchObject({ attempt: 1, reason: 'http_503', status: 'retry' })
    expect(stored.deadlineAt ?? null).toBeNull()
  })

  it('withholds a delivery whose deadline passed without calling the handler', async () => {
    const ga4 = (await record('run-deadline-passed')).row('ga4')
    const past = new Date(START.getTime() - HOUR).toISOString()
    await updateDelivery(ga4.id, { deadlineAt: past, nextAttemptAt: past, status: 'retry' })
    expect(await runDelivery({ deliveryId: ga4.id, now: START, payload })).toMatchObject({
      reason: 'deadline_passed',
      status: 'withheld',
    })
    expect(handlerCalls).toHaveLength(0)
  })

  it('returns a caller-aborted delivery to retry without consuming an attempt', async () => {
    const controller = new AbortController()
    behavior = () => {
      controller.abort()
      return new Promise(() => undefined)
    }
    const ga4 = (await record('run-caller-abort')).row('ga4')
    const result = await runDelivery({
      deliveryId: ga4.id,
      now: START,
      payload,
      signal: controller.signal,
    })
    expect(result).toMatchObject({ reason: 'aborted', status: 'retry' })
    const stored = await readDelivery(ga4.id)
    expect(stored).toMatchObject({ attempt: 0, reason: 'aborted', status: 'retry' })
    expect(await claimDelivery(payload, stored, START)).toMatchObject({ attempt: 1 })
  })
})

describe(`runDelivery finish contention on ${databaseName}`, () => {
  it('settles every delivery of one event when their workers finish together', async () => {
    const results: string[] = []
    for (let index = 0; index < 10; index++) {
      const { row } = await record(`finish-together-${index}`)
      let release = (): void => undefined
      const bothCalled = new Promise<void>((resolve) => {
        release = resolve
      })
      let waiting = 0
      behavior = async () => {
        waiting += 1
        if (waiting === 2) {
          release()
        }
        await bothCalled
        return { kind: 'sent' }
      }
      const settled = await Promise.all(
        [row('ga4'), row('meta')].map((delivery) =>
          runDelivery({ deliveryId: delivery.id, now: START, payload }).then(
            (result) => result.status,
            (error: unknown) => `threw: ${String(error)}`,
          ),
        ),
      )
      results.push(...settled)
      for (const delivery of [row('ga4'), row('meta')]) {
        expect((await readDelivery(delivery.id)).status).toBe('sent')
      }
    }
    expect(results).toEqual(Array.from({ length: 20 }, () => 'sent'))
  })

  it('discards and logs a result that arrives after the sweep recovered its lease', async () => {
    const warnLog = vi.spyOn(payload.logger, 'warn').mockImplementation(() => undefined)
    const { row } = await record('late-finisher')
    const ga4 = row('ga4')
    const claimedAt = new Date()
    behavior = async () => {
      await sweepDeliveries({ now: new Date(claimedAt.getTime() + LEASE_MS + 1000), payload })
      return { kind: 'sent' }
    }
    const result = await runDelivery({ deliveryId: ga4.id, now: claimedAt, payload })
    expect(result.status).toBe('claimed_elsewhere')
    expect(await readDelivery(ga4.id)).toMatchObject({
      attempt: 1,
      reason: 'lease_expired',
      status: 'retry',
    })
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempt: 1, deliveryId: ga4.id }),
        msg: expect.stringContaining('result discarded'),
      }),
    )
    warnLog.mockRestore()
  })
})

describe(`payloadJobsDispatcher on ${databaseName}`, () => {
  let jobs: Payload

  const deliverJobs = async (deliveryId: number | string): Promise<JobRow[]> =>
    (
      await jobs.find({
        collection: 'payload-jobs' as never,
        depth: 0,
        overrideAccess: true,
        sort: 'createdAt',
        where: {
          and: [
            { taskSlug: { equals: TASK_DELIVER } },
            { 'input.deliveryId': { equals: String(deliveryId) } },
          ],
        },
      })
    ).docs as unknown as JobRow[]

  beforeAll(async () => {
    jobs = await bootPayload({
      label: 'run_jobs',
      options: { destinations: { ga4: ga4Options }, secret: 'jobs-test-secret' },
    })
  })

  it('registers the delivery and sweep tasks', () => {
    const slugs = (jobs.config.jobs.tasks ?? []).map((task) => task.slug)
    expect(slugs).toEqual(expect.arrayContaining([TASK_DELIVER, TASK_SWEEP]))
  })

  it('queues a delivery job that Payload Jobs runs to sent', async () => {
    const ga4 = (await record('jobs-sent', jobs)).row('ga4')
    const queued = await deliverJobs(ga4.id)
    expect(queued.map((job) => job.queue)).toEqual([DEFAULT_QUEUE])
    const { jobStatus } = await jobs.jobs.run({ limit: 10, queue: DEFAULT_QUEUE })
    expect(Object.values(jobStatus ?? {})).toContainEqual({ status: 'success' })
    expect(await readDelivery(ga4.id, jobs)).toMatchObject({ attempt: 1, status: 'sent' })
    // Payload deletes successfully completed jobs by default.
    expect(await deliverJobs(ga4.id)).toEqual([])
  })

  it('queues a retry that waits until the next attempt', async () => {
    behavior = () => Promise.resolve({ kind: 'retry', reason: 'http_503' })
    const ga4 = (await record('jobs-retry', jobs)).row('ga4')
    await jobs.jobs.run({ limit: 10, queue: DEFAULT_QUEUE })
    const stored = await readDelivery(ga4.id, jobs)
    expect(stored).toMatchObject({ attempt: 1, status: 'retry' })
    const waiting = (await deliverJobs(ga4.id)).filter((job) => !job.completedAt)
    expect(waiting).toHaveLength(1)
    expect(at(waiting[0].waitUntil)).toBe(at(stored.nextAttemptAt))

    await jobs.jobs.run({ limit: 10, queue: DEFAULT_QUEUE })
    expect(await readDelivery(ga4.id, jobs)).toMatchObject({ attempt: 1, status: 'retry' })
  })

  it('runs the sweep task', async () => {
    const job = (await jobs.jobs.queue({
      input: {},
      queue: DEFAULT_QUEUE,
      task: TASK_SWEEP as never,
    })) as unknown as { id: number | string }
    const { jobStatus } = await jobs.jobs.run({ limit: 10, queue: DEFAULT_QUEUE })
    expect((jobStatus as Record<string, unknown> | undefined)?.[String(job.id)]).toEqual({
      status: 'success',
    })
  })
})
