import type { Config } from 'payload'

import type { NormalizedOptions } from '../types/index.js'

import { PLUGIN_SLUG, TASK_SWEEP } from '../constants.js'

export const applyJobs = (config: Config, options: NormalizedOptions): Config =>
  options.disabled || !options.dispatcher.install
    ? config
    : options.dispatcher.install(config, options)

// A custom dispatcher or a host task under the sweep slug would otherwise drop the cron silently.
export const assertSweepScheduled = (config: Config, options: NormalizedOptions): void => {
  const { cron } = options.sweep
  if (options.disabled || !cron) {
    return
  }
  const scheduled = (config.jobs?.tasks ?? []).some(
    (task) =>
      task.slug === TASK_SWEEP && (task.schedule ?? []).some((entry) => entry.cron === cron),
  )
  if (!scheduled) {
    throw new Error(
      `${PLUGIN_SLUG}: sweep.cron "${cron}" is set but no "${TASK_SWEEP}" task carries that schedule. The dispatcher installs no sweep task or a host task already uses the slug; add the schedule to that task or remove sweep.cron.`,
    )
  }
}
