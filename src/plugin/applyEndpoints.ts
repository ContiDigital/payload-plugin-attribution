import type { Config, Endpoint } from 'payload'

import type { NormalizedOptions } from '../types/index.js'

import { feedEndpoints } from '../server/endpoints/feedEndpoints.js'
import { healthEndpoint } from '../server/endpoints/healthEndpoint.js'
import { redeliverEndpoint } from '../server/endpoints/redeliverEndpoint.js'
import { createLogger } from '../server/utilities/logger.js'

const routeKey = ({ method, path }: Pick<Endpoint, 'method' | 'path'>): string =>
  `${method.toLowerCase()} ${path}`

export const applyEndpoints = (config: Config, options: NormalizedOptions): Config => {
  if (options.disabled) {
    return config
  }
  const hostRoutes = new Set((config.endpoints ?? []).map(routeKey))
  const plugin = [...feedEndpoints(options), redeliverEndpoint(options), healthEndpoint(options)]
  const overridden = plugin.filter((endpoint) => hostRoutes.has(routeKey(endpoint)))
  const installed: Config = {
    ...config,
    endpoints: [
      ...(config.endpoints ?? []),
      ...plugin.filter((endpoint) => !hostRoutes.has(routeKey(endpoint))),
    ],
  }
  if (overridden.length === 0) {
    return installed
  }
  const hostOnInit = config.onInit
  return {
    ...installed,
    onInit: async (payload) => {
      for (const endpoint of overridden) {
        createLogger(payload).warn(
          `endpoint ${endpoint.method.toUpperCase()} ${endpoint.path} is already defined by the host; the host endpoint is kept and the plugin endpoint is not registered`,
        )
      }
      await hostOnInit?.(payload)
    },
  }
}
