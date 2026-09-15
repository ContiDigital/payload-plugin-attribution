import type { Config, Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import { TASK_DELIVER, TASK_SWEEP } from '../../../constants.js'
import { attributionPlugin } from '../../../index.js'
import { normalizeOptions } from '../../../plugin/normalizeOptions.js'
import { payloadJobsDispatcher } from '../payloadJobs.js'

const options = normalizeOptions({ secret: 'jobs-unit-secret' })

describe('payloadJobsDispatcher install', () => {
  it('keeps a host task under a plugin slug and warns that deliveries route to it', async () => {
    const hostOnInit = vi.fn()
    const handler = () => ({ output: {} })
    const config = {
      jobs: { tasks: [{ slug: TASK_DELIVER, handler }] },
      onInit: hostOnInit,
    } as unknown as Config
    const installed = payloadJobsDispatcher().install?.(config, options)
    const tasks = installed?.jobs?.tasks ?? []
    expect(tasks.filter((task) => task.slug === TASK_DELIVER)).toHaveLength(1)
    expect(tasks.find((task) => task.slug === TASK_DELIVER)?.handler).toBe(handler)
    expect(tasks.map((task) => task.slug)).toContain(TASK_SWEEP)

    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
    const payload = { logger } as unknown as Payload
    await installed?.onInit?.(payload)
    expect(logger.warn).toHaveBeenCalledWith({
      msg: expect.stringContaining(`"${TASK_DELIVER}" is already registered by the host`),
    })
    expect(hostOnInit).toHaveBeenCalledWith(payload)
  })

  it('attaches no schedule to the sweep task without a sweep cron', () => {
    const installed = payloadJobsDispatcher().install?.({} as Config, options)
    const sweep = installed?.jobs?.tasks?.find((task) => task.slug === TASK_SWEEP)
    expect(sweep?.schedule).toBeUndefined()
  })

  it('schedules the sweep on the plugin queue without touching jobs.autoRun', () => {
    const autoRun = [{ cron: '* * * * *', limit: 10, queue: 'attribution' }]
    const config = { jobs: { autoRun, tasks: [] } } as unknown as Config
    const scheduled = normalizeOptions({
      secret: 'jobs-unit-secret',
      sweep: { cron: '*/5 * * * *' },
    })
    const installed = payloadJobsDispatcher().install?.(config, scheduled)
    const sweep = installed?.jobs?.tasks?.find((task) => task.slug === TASK_SWEEP)
    expect(sweep?.schedule).toEqual([{ cron: '*/5 * * * *', queue: 'attribution' }])
    expect(installed?.jobs?.autoRun).toBe(autoRun)
    expect(installed?.jobs?.tasks?.find((task) => task.slug === TASK_DELIVER)?.schedule).toBe(
      undefined,
    )
  })

  it('schedules the sweep on sweep.queue when given', () => {
    const scheduled = normalizeOptions({
      queue: 'deliveries',
      secret: 'jobs-unit-secret',
      sweep: { cron: '0 */10 * * * *', queue: 'maintenance' },
    })
    const installed = payloadJobsDispatcher().install?.({} as Config, scheduled)
    expect(installed?.jobs?.autoRun).toBeUndefined()
    expect(installed?.jobs?.tasks?.find((task) => task.slug === TASK_SWEEP)?.schedule).toEqual([
      { cron: '0 */10 * * * *', queue: 'maintenance' },
    ])
  })

  it('rejects sweep.cron instead of dropping it when a host task holds the sweep slug', () => {
    const hostSweep = { slug: TASK_SWEEP, handler: () => ({ output: {} }) }
    expect(() =>
      attributionPlugin({ secret: 'jobs-unit-secret', sweep: { cron: '* * * * *' } })({
        jobs: { tasks: [hostSweep] },
      } as unknown as Config),
    ).toThrow(/^payload-plugin-attribution: sweep\.cron/)
    expect(hostSweep).not.toHaveProperty('schedule')
  })

  it('leaves onInit alone without a collision', () => {
    const installed = payloadJobsDispatcher().install?.({} as Config, options)
    expect(installed?.onInit).toBeUndefined()
    expect((installed?.jobs?.tasks ?? []).map((task) => task.slug)).toEqual([
      TASK_DELIVER,
      TASK_SWEEP,
    ])
  })
})
