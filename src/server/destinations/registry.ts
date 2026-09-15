import type { Destination } from '../../types/index.js'
import type { DestinationHandler } from './types.js'

import { ga4Handler } from './ga4/send.js'
import { googleAdsHandler } from './googleAds/send.js'
import { googleAdsAdjustmentHandler } from './googleAdsFeed/handler.js'
import { metaHandler } from './meta/send.js'

// Kept on globalThis so a second module instance (bundler duplication, dev reloads) shares handlers.
const REGISTRY = Symbol.for('payload-plugin-attribution.destinationHandlers')

const handlers = (): Map<Destination, DestinationHandler> => {
  const store = globalThis as { [REGISTRY]?: Map<Destination, DestinationHandler> }
  store[REGISTRY] ??= new Map()
  return store[REGISTRY]
}

export const registerDestinationHandler = (handler: DestinationHandler): void => {
  handlers().set(handler.destination, handler)
}

export const getDestinationHandler = (destination: Destination): DestinationHandler | undefined =>
  handlers().get(destination)

/** Test only: forgets every registered handler. */
export const resetDestinationHandlers = (): void => {
  handlers().clear()
}

registerDestinationHandler(ga4Handler)
registerDestinationHandler(googleAdsHandler)
registerDestinationHandler(googleAdsAdjustmentHandler)
registerDestinationHandler(metaHandler)
