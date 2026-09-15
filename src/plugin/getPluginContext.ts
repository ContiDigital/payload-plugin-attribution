import type { Config, Payload } from 'payload'

import type { NormalizedOptions } from '../types/index.js'

import { PLUGIN_SLUG } from '../constants.js'

export type PluginContext = { options: NormalizedOptions }

// Root `custom` is server-only and survives `disableOnInit` boots such as
// `payload migrate`, which a WeakMap filled in onInit would not.
export const withPluginContext = (config: Config, options: NormalizedOptions): Config => ({
  ...config,
  custom: { ...config.custom, [PLUGIN_SLUG]: { options } satisfies PluginContext },
})

const isPluginContext = (value: unknown): value is PluginContext =>
  typeof value === 'object' && value !== null && 'options' in value

export const getPluginContext = (payload: Pick<Payload, 'config'>): PluginContext => {
  const context: unknown = payload.config.custom?.[PLUGIN_SLUG]
  if (!isPluginContext(context)) {
    throw new Error(`${PLUGIN_SLUG}: plugin is not installed in this Payload config`)
  }
  return context
}

export const collectionSlugs = (
  payload: Pick<Payload, 'config'>,
): NormalizedOptions['collections'] => getPluginContext(payload).options.collections
