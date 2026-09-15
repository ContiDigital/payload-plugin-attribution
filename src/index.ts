import type { Config } from 'payload'

import type { AttributionPluginOptions } from './types/index.js'

import { PLUGIN_APPLIED, PLUGIN_SLUG } from './constants.js'
import { applyCollections } from './plugin/applyCollections.js'
import { applyEndpoints } from './plugin/applyEndpoints.js'
import { applyJobs, assertSweepScheduled } from './plugin/applyJobs.js'
import { withPluginContext } from './plugin/getPluginContext.js'
import { normalizeOptions } from './plugin/normalizeOptions.js'

const assertNotApplied = (config: Config): void => {
  if ((config as Record<PropertyKey, unknown>)[PLUGIN_APPLIED] === true) {
    throw new Error(`${PLUGIN_SLUG}: only one plugin instance may be applied to a Payload config`)
  }
}

// Enumerable so the marker survives later plugins that spread the config.
const markApplied = (config: Config): Config => {
  Object.defineProperty(config, PLUGIN_APPLIED, {
    configurable: true,
    enumerable: true,
    value: true,
  })
  return config
}

export const attributionPlugin =
  (input: AttributionPluginOptions) =>
  (incoming: Config): Config => {
    assertNotApplied(incoming)
    const options = normalizeOptions(input, incoming)
    const config = applyJobs(
      withPluginContext(applyCollections(incoming, options), options),
      options,
    )
    assertSweepScheduled(config, options)
    return markApplied(applyEndpoints(config, options))
  }

export { attributionField } from './fields/attributionField.js'
export { redeliverConversion } from './server/deliveries/redeliver.js'
export { runDelivery } from './server/deliveries/runDelivery.js'
export { sweepDeliveries } from './server/deliveries/sweep.js'
export { payloadJobsDispatcher } from './server/dispatch/payloadJobs.js'
export { setupGa4Property } from './server/property/setupProperty.js'
export { recordConversion } from './server/record/recordConversion.js'
export { requestContextFromHeaders } from './server/requestContext.js'
export { verifyDestination } from './server/verify/verifyDestination.js'
export type * from './types/index.js'
