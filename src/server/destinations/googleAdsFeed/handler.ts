import type { DestinationHandler, DestinationOutcome } from '../types.js'

import { feedCredentials } from '../../endpoints/basicAuth.js'
import {
  adjustmentNotApplicable,
  decideAdjustment,
  originalDelivered,
} from './adjustmentDecision.js'

export const googleAdsAdjustmentHandler: DestinationHandler = {
  deliver: async ({ event, lookup, now, options }): Promise<DestinationOutcome> => {
    const googleAds = options.destinations.googleAds
    if (!googleAds?.enabled || !googleAds.adjustments.enabled) {
      return { kind: 'withheld', reason: 'not_configured' }
    }
    const { password, username } = await feedCredentials(googleAds)
    if (!username || !password) {
      return { kind: 'withheld', reason: 'not_configured' }
    }
    const notApplicable = adjustmentNotApplicable(event)
    if (notApplicable) {
      return { kind: 'withheld', reason: notApplicable }
    }
    const original = (await lookup.originalConversion(event))?.delivery ?? null
    const retracted = originalDelivered(original) ? await lookup.retracted(event) : false
    return decideAdjustment({ event, now, original, retracted })
  },
  destination: 'googleAdsAdjustment',
}
