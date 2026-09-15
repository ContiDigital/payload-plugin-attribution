import type { Config, Payload, TaskConfig } from 'payload'

import type { NormalizedOptions } from '../../types/index.js'
import type { DeliveryResult } from '../destinations/types.js'
import type { AttributionDispatcher } from './types.js'

import { PAYLOAD_JOBS_DISPATCHER, TASK_DELIVER, TASK_SWEEP } from '../../constants.js'
import { getPluginContext } from '../../plugin/getPluginContext.js'
import { runDelivery } from '../deliveries/runDelivery.js'
import { sweepDeliveries } from '../deliveries/sweep.js'
import { createLogger } from '../utilities/logger.js'

type DeliverTask = { input: { deliveryId: string }; output: DeliveryResult }
type SweepTask = {
  input: object
  output: Awaited<ReturnType<typeof sweepDeliveries>>
}

// Job input is text; number-id adapters need the number back for the delivery lookup.
const deliveryIdFor = (payload: Payload, id: string): number | string =>
  payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id

const deliverTask: TaskConfig<DeliverTask> = {
  slug: TASK_DELIVER,
  handler: async ({ input, req }) => ({
    output: await runDelivery({
      deliveryId: deliveryIdFor(req.payload, input.deliveryId),
      payload: req.payload,
    }),
  }),
  inputSchema: [{ name: 'deliveryId', type: 'text', required: true }],
  retries: 0,
}

const sweepTask: TaskConfig<SweepTask> = {
  slug: TASK_SWEEP,
  handler: async ({ req }) => ({ output: await sweepDeliveries({ payload: req.payload }) }),
  retries: 0,
}

export function payloadJobsDispatcher(
  dispatcherOptions: { queue?: string } = {},
): AttributionDispatcher {
  return {
    name: PAYLOAD_JOBS_DISPATCHER,
    dispatch: async ({ deliveryId, notBefore, payload, req }) => {
      await payload.jobs.queue({
        input: { deliveryId: String(deliveryId) },
        queue: dispatcherOptions.queue ?? getPluginContext(payload).options.queue,
        req,
        task: TASK_DELIVER,
        waitUntil: notBefore,
      } as unknown as Parameters<Payload['jobs']['queue']>[0])
    },
    // A task the host already registered under the same slug wins. The config has no logger,
    // so the collision found here is reported once Payload initializes.
    install: (config: Config, options: NormalizedOptions): Config => {
      const tasks = [...(config.jobs?.tasks ?? [])]
      const overridden: string[] = []
      const { cron, queue } = options.sweep
      const sweep: TaskConfig<SweepTask> = cron
        ? { ...sweepTask, schedule: [{ cron, queue: queue ?? options.queue }] }
        : sweepTask
      for (const task of [deliverTask, sweep]) {
        if (tasks.some((existing) => existing.slug === task.slug)) {
          overridden.push(task.slug)
        } else {
          tasks.push(task as never)
        }
      }
      const installed: Config = { ...config, jobs: { ...config.jobs, tasks } }
      if (overridden.length === 0) {
        return installed
      }
      const hostOnInit = config.onInit
      return {
        ...installed,
        onInit: async (payload) => {
          for (const slug of overridden) {
            createLogger(payload).warn(
              `job task "${slug}" is already registered by the host; plugin deliveries will be routed to the host task`,
            )
          }
          await hostOnInit?.(payload)
        },
      }
    },
  }
}
