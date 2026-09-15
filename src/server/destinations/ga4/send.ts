import type { DestinationHandler } from '../types.js'

import { GA4_MP_EU_ORIGIN, GA4_MP_ORIGIN } from '../../../constants.js'
import { HttpNetworkError } from '../../utilities/errors.js'
import { postJson, responseData } from '../../utilities/http.js'
import { retryAfterMs } from '../../utilities/retryAfter.js'
import { resolveSetting } from '../../utilities/settings.js'
import { buildGa4Body } from './payload.js'

export const ga4Handler: DestinationHandler = {
  deliver: async ({ event, now, options, signal }) => {
    const ga4 = options.destinations.ga4
    if (!ga4?.enabled) {
      return { kind: 'withheld', reason: 'not_configured' }
    }
    if (event.consent?.analyticsStorage === 'denied') {
      return { kind: 'withheld', reason: 'consent_denied' }
    }
    const [measurementId, apiSecret, secret] = await Promise.all([
      resolveSetting(ga4.measurementId),
      resolveSetting(ga4.apiSecret),
      resolveSetting(options.secret),
    ])
    if (!measurementId || !apiSecret || !secret) {
      return { kind: 'withheld', reason: 'not_configured' }
    }

    let built: ReturnType<typeof buildGa4Body>
    try {
      built = buildGa4Body(event, { now, secret, userProvidedData: ga4.userProvidedData })
    } catch {
      return { kind: 'dead', reason: 'invalid_payload' }
    }

    const host = options.endpoints.ga4 ?? (ga4.euEndpoint ? GA4_MP_EU_ORIGIN : GA4_MP_ORIGIN)
    const url = `${host}/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`

    let response: Awaited<ReturnType<typeof postJson>>
    try {
      response = await postJson(url, built.body, { signal })
    } catch (error) {
      if (error instanceof HttpNetworkError) {
        return { kind: 'retry', reason: 'network_error' }
      }
      throw error
    }

    if (response.status >= 200 && response.status < 300) {
      const data = responseData(response)
      return {
        kind: 'sent',
        request: built.body,
        ...(data === undefined ? {} : { response: data }),
      }
    }
    const data = responseData(response)
    const reason = `http_${response.status}`
    if (response.status === 429 || response.status >= 500) {
      return {
        kind: 'retry',
        reason,
        retryAfterMs: retryAfterMs(response.headers, now),
        ...(data === undefined ? {} : { response: data }),
      }
    }
    return { kind: 'dead', reason, ...(data === undefined ? {} : { response: data }) }
  },
  destination: 'ga4',
}
