import type { Config } from 'payload'

import { describe, expect, it } from 'vitest'

import type { AttributionDispatcher } from '../../types/index.js'

import { TASK_SWEEP } from '../../constants.js'
import { attributionPlugin } from '../../index.js'

const CRON = '*/5 * * * *'
const SWEEP_MISSING = /^payload-plugin-attribution: sweep\.cron/

const sweepTask = (schedule?: Array<{ cron: string; queue: string }>) => ({
  slug: TASK_SWEEP,
  handler: () => ({ output: {} }),
  ...(schedule ? { schedule } : {}),
})

describe('sweep.cron schedule assertion', () => {
  it('accepts the built-in Payload Jobs dispatcher, which schedules its own sweep task', () => {
    const config = attributionPlugin({ secret: 'jobs-secret', sweep: { cron: CRON } })({} as Config)
    expect(config.jobs?.tasks?.find((task) => task.slug === TASK_SWEEP)?.schedule).toEqual([
      { cron: CRON, queue: 'attribution' },
    ])
  })

  it('rejects a custom dispatcher without install', () => {
    const dispatcher: AttributionDispatcher = { name: 'custom', dispatch: () => Promise.resolve() }
    expect(() =>
      attributionPlugin({ dispatcher, secret: 'jobs-secret', sweep: { cron: CRON } })({} as Config),
    ).toThrow(SWEEP_MISSING)
  })

  it('rejects a custom dispatcher whose install registers no sweep task', () => {
    const dispatcher: AttributionDispatcher = {
      name: 'custom',
      dispatch: () => Promise.resolve(),
      install: (config) => ({ ...config, jobs: { ...config.jobs, tasks: [] } }),
    }
    expect(() =>
      attributionPlugin({ dispatcher, secret: 'jobs-secret', sweep: { cron: CRON } })({} as Config),
    ).toThrow(SWEEP_MISSING)
  })

  it('rejects a host task under the sweep slug that does not carry the schedule', () => {
    const config = { jobs: { tasks: [sweepTask()] } } as unknown as Config
    expect(() =>
      attributionPlugin({ secret: 'jobs-secret', sweep: { cron: CRON } })(config),
    ).toThrow(SWEEP_MISSING)
  })

  it('rejects a host sweep task scheduled with a different cron', () => {
    const config = {
      jobs: { tasks: [sweepTask([{ cron: '0 * * * *', queue: 'attribution' }])] },
    } as unknown as Config
    expect(() =>
      attributionPlugin({ secret: 'jobs-secret', sweep: { cron: CRON } })(config),
    ).toThrow(SWEEP_MISSING)
  })

  it('accepts a host sweep task that already carries the schedule', () => {
    const config = {
      jobs: { tasks: [sweepTask([{ cron: CRON, queue: 'maintenance' }])] },
    } as unknown as Config
    expect(() =>
      attributionPlugin({ secret: 'jobs-secret', sweep: { cron: CRON } })(config),
    ).not.toThrow()
  })

  it('checks nothing without a cron or in disabled mode', () => {
    const dispatcher: AttributionDispatcher = { name: 'custom', dispatch: () => Promise.resolve() }
    expect(() =>
      attributionPlugin({ dispatcher, secret: 'jobs-secret' })({} as Config),
    ).not.toThrow()
    expect(() =>
      attributionPlugin({ disabled: true, dispatcher, secret: '', sweep: { cron: CRON } })(
        {} as Config,
      ),
    ).not.toThrow()
  })
})
