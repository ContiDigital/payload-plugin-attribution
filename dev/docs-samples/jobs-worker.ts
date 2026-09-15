import { getPayload } from 'payload'

import config from './payload.config.js'

// A worker process run by an external scheduler instead of jobs.autoRun in the web process.
const payload = await getPayload({ config, cron: false })
try {
  await payload.jobs.handleSchedules({ queue: 'attribution' })
  await payload.jobs.run({ limit: 100, queue: 'attribution' })
} finally {
  await payload.destroy()
}
