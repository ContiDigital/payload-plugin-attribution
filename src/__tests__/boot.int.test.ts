import type { Config, Payload, PayloadRequest } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AttributionPluginOptions, AuthorizeScope } from '../types/index.js'

import {
  CLAIMS_SLUG,
  DELIVERIES_SLUG,
  EVENTS_SLUG,
  TASK_DELIVER,
  TASK_SWEEP,
} from '../constants.js'
import { attributionField, attributionPlugin } from '../index.js'
import { getPluginContext } from '../plugin/getPluginContext.js'
import { bootPayload, databaseName, destroyPayloads } from './helpers/bootPayload.js'

const taskSlugs = (payload: Payload): string[] =>
  (payload.config.jobs.tasks ?? []).map((task) => task.slug)

const attributionRoutes = (payload: Payload): string[] =>
  (payload.config.endpoints ?? [])
    .filter((endpoint) => endpoint.path.startsWith('/attribution/'))
    .map(({ method, path }) => `${method} ${path}`)

const PLUGIN_ROUTES = [
  'get /attribution/google-ads/conversions.csv',
  'get /attribution/google-ads/adjustments.csv',
  'post /attribution/events/:id/redeliver',
  'get /attribution/health',
]

const boot = (
  label: string,
  options: AttributionPluginOptions,
  config?: Pick<Config, 'jobs'>,
): Promise<Payload> =>
  bootPayload({
    collections: [
      // Long host slugs and repeated groups stress Postgres enum naming.
      {
        slug: 'gallery-consignment-private-treaty-sale-orders',
        fields: [attributionField('firstTouch'), attributionField('lastTouch')],
      },
      { slug: 'leads', fields: [attributionField('firstTouch'), attributionField('lastTouch')] },
    ],
    config,
    label: `boot_${label}`,
    options,
  })

afterAll(destroyPayloads)

describe(`Payload boot on ${databaseName}`, () => {
  it('registers the ledger collections and joins deliveries to events', async () => {
    const payload = await boot('enabled', { secret: 'boot-test-secret' })
    for (const slug of [EVENTS_SLUG, DELIVERIES_SLUG, CLAIMS_SLUG]) {
      expect(payload.collections[slug as never]).toBeDefined()
    }

    const event = await payload.create({
      collection: EVENTS_SLUG as never,
      data: {
        name: 'generate_lead',
        attribution: { gclid: 'G'.repeat(20), utmSource: 'a@b.co' },
        eventKey: 'boot-event',
        occurredAt: new Date().toISOString(),
      } as never,
      overrideAccess: true,
    })
    const eventId = (event as unknown as { id: number | string }).id
    await payload.create({
      collection: DELIVERIES_SLUG as never,
      data: {
        destination: 'ga4',
        event: eventId,
        key: `${eventId}:ga4:r1:s0`,
        revision: 1,
        status: 'pending',
      } as never,
      overrideAccess: true,
    })

    const read = (await payload.findByID({
      id: eventId,
      collection: EVENTS_SLUG as never,
      depth: 0,
      overrideAccess: true,
    })) as unknown as {
      attribution: Record<string, unknown>
      deliveries: { docs: unknown[] }
    }
    expect(read.attribution.gclid).toBe('G'.repeat(20))
    expect(read.attribution.utmSource ?? undefined).toBeUndefined()
    expect(read.deliveries.docs).toHaveLength(1)
    expect(taskSlugs(payload)).toEqual(expect.arrayContaining([TASK_DELIVER, TASK_SWEEP]))
    expect(attributionRoutes(payload)).toEqual(PLUGIN_ROUTES)
  })

  it('schedules the sweep task when sweep.cron is set and leaves jobs.autoRun alone', async () => {
    const payload = await boot(
      'sweep_cron',
      { secret: 'boot-test-secret', sweep: { cron: '*/10 * * * *' } },
      { jobs: { tasks: [] } },
    )
    const sweep = (payload.config.jobs.tasks ?? []).find((task) => task.slug === TASK_SWEEP)
    expect(sweep?.schedule).toEqual([{ cron: '*/10 * * * *', queue: 'attribution' }])
    expect(payload.config.jobs.autoRun).toBeUndefined()
  })

  it('refuses a second plugin application through buildConfig', async () => {
    await expect(
      buildConfig({
        collections: [{ slug: 'users', auth: true, fields: [] }],
        db: sqliteAdapter({ client: { url: 'file::memory:' } }),
        plugins: [
          attributionPlugin({ secret: 'boot-test-secret' }),
          attributionPlugin({ secret: 'boot-test-secret' }),
        ],
        secret: 'test-payload-secret',
      }),
    ).rejects.toThrow(/only one plugin instance/)
  })

  it.each([
    [
      'a custom dispatcher that installs no sweep task',
      {
        dispatcher: { name: 'custom', dispatch: () => Promise.resolve() },
      } satisfies Partial<AttributionPluginOptions>,
      undefined,
    ],
    [
      'a host task under the sweep slug',
      {},
      { tasks: [{ slug: TASK_SWEEP, handler: () => ({ output: {} }) }] },
    ],
  ])('refuses sweep.cron through buildConfig with %s', async (_label, extra, jobs) => {
    await expect(
      buildConfig({
        collections: [{ slug: 'users', auth: true, fields: [] }],
        db: sqliteAdapter({ client: { url: 'file::memory:' } }),
        ...(jobs ? { jobs } : {}),
        plugins: [
          attributionPlugin({
            secret: 'boot-test-secret',
            sweep: { cron: '*/5 * * * *' },
            ...extra,
          }),
        ],
        secret: 'test-payload-secret',
      }),
    ).rejects.toThrow(/^payload-plugin-attribution: sweep\.cron/)
  })

  it('boots in disabled mode with collections and no job tasks', async () => {
    const payload = await boot('disabled', { disabled: true, secret: '' })
    for (const slug of [EVENTS_SLUG, DELIVERIES_SLUG, CLAIMS_SLUG]) {
      expect(payload.collections[slug as never]).toBeDefined()
      expect(payload.collections[slug as never].config.admin.hidden).toBe(true)
    }
    expect(taskSlugs(payload)).not.toContain(TASK_DELIVER)
    expect(taskSlugs(payload)).not.toContain(TASK_SWEEP)
    expect(attributionRoutes(payload)).toEqual([])
  })

  it('keeps a host task registered under a plugin task slug', async () => {
    const handler = () => ({ output: {} })
    const payload = await boot(
      'host_task',
      { secret: 'boot-test-secret' },
      { jobs: { tasks: [{ slug: TASK_DELIVER, handler }] } },
    )
    const delivers = (payload.config.jobs.tasks ?? []).filter((task) => task.slug === TASK_DELIVER)
    expect(delivers).toHaveLength(1)
    expect(delivers[0].handler).toBe(handler)
    expect(taskSlugs(payload)).toContain(TASK_SWEEP)
  })
})

type EventRead = {
  context?: { ipAddress?: string }
  deliveries: { docs: Array<{ key: string; request?: unknown }> }
  eventKey: string
  identifiers?: { google?: { emailSha256?: string } }
}

describe('ledger access through the Local API', () => {
  const PRIVACY_EMAIL = 'privacy@example.com'
  const authorize = ({ req, scope }: { req: PayloadRequest; scope: AuthorizeScope }): boolean => {
    const user = req.user as { collection?: string; email?: string } | null
    return user?.collection === 'users' && (scope !== 'pii' || user.email === PRIVACY_EMAIL)
  }
  let payload: Payload
  let eventId: number | string
  let deliveryId: number | string
  let staff: Record<string, unknown>
  let privacy: Record<string, unknown>

  const createUser = async (email: string): Promise<Record<string, unknown>> => {
    const user = await payload.create({
      collection: 'users' as never,
      data: { email, password: 'boot-test-password' } as never,
      overrideAccess: true,
    })
    return { ...(user as object), collection: 'users' }
  }

  const readEvent = async (user: Record<string, unknown>, depth: number): Promise<EventRead> =>
    (await payload.findByID({
      id: eventId,
      collection: EVENTS_SLUG as never,
      depth,
      overrideAccess: false,
      user,
    })) as unknown as EventRead

  beforeAll(async () => {
    payload = await boot('access', { authorize, secret: 'boot-test-secret' })
    staff = await createUser('staff@example.com')
    privacy = await createUser(PRIVACY_EMAIL)
    const event = await payload.create({
      collection: EVENTS_SLUG as never,
      data: {
        name: 'purchase',
        context: { ipAddress: '203.0.113.7', url: 'https://example.com/', userAgent: 'Vitest' },
        eventKey: 'access-event',
        identifiers: { google: { emailSha256: 'a'.repeat(64) }, meta: { em: 'b'.repeat(64) } },
        occurredAt: new Date().toISOString(),
      } as never,
      overrideAccess: true,
    })
    eventId = (event as unknown as { id: number | string }).id
    const delivery = await payload.create({
      collection: DELIVERIES_SLUG as never,
      data: {
        destination: 'meta',
        event: eventId,
        key: `${eventId}:meta:r1:s0`,
        request: { body: { user_data: { em: 'b'.repeat(64) } } },
        response: { events_received: 1 },
        revision: 1,
        status: 'sent',
      } as never,
      overrideAccess: true,
    })
    deliveryId = (delivery as unknown as { id: number | string }).id
  })

  it.each([
    [EVENTS_SLUG, () => eventId],
    [DELIVERIES_SLUG, () => deliveryId],
  ])('rejects create, update and delete on %s for an admin user', async (slug, id) => {
    const forbidden = { status: 403 }
    await expect(
      payload.create({
        collection: slug as never,
        data: {} as never,
        overrideAccess: false,
        user: staff,
      }),
    ).rejects.toMatchObject(forbidden)
    await expect(
      payload.update({
        id: id(),
        collection: slug as never,
        data: {} as never,
        overrideAccess: false,
        user: staff,
      }),
    ).rejects.toMatchObject(forbidden)
    await expect(
      payload.delete({ id: id(), collection: slug as never, overrideAccess: false, user: staff }),
    ).rejects.toMatchObject(forbidden)
  })

  it('strips identifiers, context and delivery requests without the pii scope', async () => {
    const shallow = await readEvent(staff, 0)
    expect(shallow.eventKey).toBe('access-event')
    expect(shallow.identifiers).toBeUndefined()
    expect(shallow.context).toBeUndefined()

    const deep = await readEvent(staff, 1)
    expect(deep.deliveries.docs).toHaveLength(1)
    expect(deep.deliveries.docs[0].key).toBe(`${eventId}:meta:r1:s0`)
    expect(deep.deliveries.docs[0].request).toBeUndefined()
  })

  it('returns identifiers, context and delivery requests with the pii scope', async () => {
    const deep = await readEvent(privacy, 1)
    expect(deep.identifiers?.google?.emailSha256).toBe('a'.repeat(64))
    expect(deep.context?.ipAddress).toBe('203.0.113.7')
    expect(deep.deliveries.docs[0].request).toEqual({
      body: { user_data: { em: 'b'.repeat(64) } },
    })
  })

  it('exposes the normalized options through the plugin context', () => {
    const { options } = getPluginContext(payload)
    expect(options).toMatchObject({
      adminGroup: 'Marketing',
      apiBasePath: '/attribution',
      disabled: false,
      maxAttempts: 6,
      privacy: { identifierRetentionDays: 90 },
      queue: 'attribution',
      secret: 'boot-test-secret',
    })
    expect(options.authorize).toBe(authorize)
  })
})
