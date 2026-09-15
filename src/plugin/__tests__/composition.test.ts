import type { Config, Endpoint, Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import { EVENTS_SLUG, TASK_SWEEP } from '../../constants.js'
import { attributionPlugin } from '../../index.js'

const hostConfig = () => {
  const endpoint: Endpoint = {
    handler: () => Response.json({ ok: true }),
    method: 'get',
    path: '/host',
  }
  const onInit = vi.fn()
  const config: Config = {
    collections: [{ slug: 'leads', fields: [] }],
    db: {} as Config['db'],
    endpoints: [endpoint],
    jobs: {
      autoRun: [{ cron: '* * * * *', queue: 'host' }],
      tasks: [{ slug: 'hostTask', handler: () => Promise.resolve({ output: {} }) }],
    },
    onInit,
    secret: 'host-secret',
  }
  return { config, onInit }
}

describe('host configuration composition', () => {
  it('keeps host tasks, jobs.autoRun, collections, endpoints and onInit ahead of the plugin', async () => {
    const { config, onInit } = hostConfig()
    const snapshot = { ...config, jobs: { ...config.jobs } }
    const result = attributionPlugin({ secret: 'plugin-secret', sweep: { cron: '*/5 * * * *' } })(
      config,
    )

    expect(result.jobs?.tasks?.[0]).toBe(snapshot.jobs.tasks?.[0])
    expect(result.jobs?.tasks?.map((task) => task.slug)).toContain(TASK_SWEEP)
    expect(result.jobs?.autoRun).toBe(snapshot.jobs.autoRun)
    expect(result.collections?.[0]).toBe(snapshot.collections?.[0])
    expect(result.collections?.map((collection) => collection.slug)).toContain(EVENTS_SLUG)
    expect(result.endpoints?.[0]).toBe(snapshot.endpoints?.[0])
    expect(config.onInit).toBe(onInit)

    const payload = { logger: { warn: vi.fn() } } as unknown as Payload
    await result.onInit?.(payload)
    expect(onInit).toHaveBeenCalledTimes(1)
    expect(onInit).toHaveBeenCalledWith(payload)
  })

  it('does not mutate the host config arrays', () => {
    const { config } = hostConfig()
    const tasks = config.jobs?.tasks
    const collections = config.collections
    const endpoints = config.endpoints
    attributionPlugin({ secret: 'plugin-secret' })(config)
    expect(config.jobs?.tasks).toBe(tasks)
    expect(tasks).toHaveLength(1)
    expect(collections).toHaveLength(1)
    expect(endpoints).toHaveLength(1)
  })
})

describe('plugin collection table names', () => {
  const build = (
    collections: Config['collections'],
    options: Parameters<typeof attributionPlugin>[0] = { secret: 'plugin-secret' },
  ): Config =>
    attributionPlugin(options)({ collections, db: {} as Config['db'], secret: 'host-secret' })

  it.each([
    ['a camelCase slug', { slug: 'conversionEvents', fields: [] }],
    ['an underscore slug', { slug: 'conversion_delivery_claims', fields: [] }],
    [
      'an explicit dbName',
      { slug: 'legacy-deliveries', dbName: 'conversion_deliveries', fields: [] },
    ],
  ])('throws when %s maps to a plugin table', (_label, collection) => {
    expect(() => build([collection])).toThrow(/database table/)
  })

  it('compares against overridden plugin slugs and accepts distinct tables', () => {
    const options = {
      collections: { events: { slug: 'attribution-events' } },
      secret: 'plugin-secret',
    }
    expect(() => build([{ slug: 'attributionEvents', fields: [] }], options)).toThrow(
      /attribution_events/,
    )
    const result = build([{ slug: 'conversion-events', fields: [] }], options)
    expect(result.collections?.map((collection) => collection.slug)).toEqual([
      'conversion-events',
      'attribution-events',
      'conversion-deliveries',
      'conversion-delivery-claims',
    ])
  })
})
