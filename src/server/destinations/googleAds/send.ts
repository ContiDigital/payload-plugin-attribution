import type {
  ConversionEventDoc,
  DeliveryDoc,
  NormalizedGoogleAdsOptions,
} from '../../../types/index.js'
import type { DestinationHandler, DestinationOutcome } from '../types.js'

import { DATA_MANAGER_INGEST_PATH } from '../../../constants.js'
import { HttpNetworkError, isAbortError } from '../../utilities/errors.js'
import { postJson, responseData } from '../../utilities/http.js'
import { retryAfterMs } from '../../utilities/retryAfter.js'
import { resolveSetting } from '../../utilities/settings.js'
import {
  dataManagerAccessToken,
  GoogleAdsAuthNetworkError,
  GoogleAdsAuthUnavailableError,
  hostAccessToken,
} from './auth.js'
import { googleAdsEligibility, googleAdsFeedEligibility } from './eligibility.js'
import { buildIngestRequest } from './payload.js'
import { processingReceipt, processingWait, verifyProcessing } from './processing.js'

const errorMessage = (data: unknown): string | undefined => {
  if (!data || typeof data !== 'object' || !('error' in data)) {
    return undefined
  }
  const error = (data as { error?: unknown }).error
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return undefined
  }
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

function feedOutcome(
  event: ConversionEventDoc,
  now: Date,
  allowBraidsInFeed: boolean,
): DestinationOutcome {
  const result = googleAdsFeedEligibility(event, now, allowBraidsInFeed)
  return result.eligible ? { kind: 'eligible' } : { kind: 'withheld', reason: result.reason }
}

export async function dataManagerOutcome(
  event: ConversionEventDoc,
  googleAds: NormalizedGoogleAdsOptions,
  origin: string,
  now: Date,
  signal: AbortSignal,
  delivery?: DeliveryDoc,
): Promise<DestinationOutcome> {
  const action = event.googleAdsAction
  if (action !== 'lead' && action !== 'sale') {
    return { kind: 'dead', reason: 'invalid_payload' }
  }

  // Checked before any network call: an ineligible event (no usable identifiers, a stale
  // click, or denied consent leaving nothing to send) never reaches token acquisition or POST.
  const receipt = googleAds.verifyProcessing ? processingReceipt(delivery?.response) : undefined
  const eligibility = googleAdsEligibility(event, now)
  if (!receipt && !eligibility.eligible) {
    return { kind: 'withheld', reason: eligibility.reason }
  }

  const [operatingAccountId, loginAccountId, serviceAccountJson] = await Promise.all([
    resolveSetting(googleAds.operatingAccountId),
    resolveSetting(googleAds.loginAccountId),
    resolveSetting(googleAds.serviceAccountJson),
  ])
  if (!operatingAccountId || (!googleAds.accessToken && !serviceAccountJson)) {
    return { kind: 'withheld', reason: 'not_configured' }
  }

  let token: string
  try {
    token = googleAds.accessToken
      ? await hostAccessToken(googleAds.accessToken, signal)
      : await dataManagerAccessToken(serviceAccountJson, signal)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    if (error instanceof GoogleAdsAuthNetworkError) {
      return { kind: 'retry', reason: 'auth_network_error' }
    }
    if (error instanceof GoogleAdsAuthUnavailableError) {
      return { kind: 'retry', reason: 'auth_unavailable' }
    }
    return { kind: 'dead', reason: 'auth_error' }
  }

  if (receipt) {
    return verifyProcessing({ now, origin, receipt, signal, token })
  }

  const request = buildIngestRequest(event, {
    conversionActionId: googleAds.conversionActions[action],
    ...(loginAccountId ? { loginAccountId } : {}),
    match: eligibility.eligible ? eligibility.match : undefined,
    operatingAccountId,
  })

  let response: Awaited<ReturnType<typeof postJson>>
  try {
    response = await postJson(`${origin}${DATA_MANAGER_INGEST_PATH}`, request, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    })
  } catch (error) {
    if (error instanceof HttpNetworkError) {
      return { kind: 'retry', reason: 'network_error' }
    }
    throw error
  }

  const data = responseData(response)

  if (response.status >= 200 && response.status < 300) {
    const requestId =
      data && typeof data === 'object' && 'requestId' in data
        ? (data as { requestId?: unknown }).requestId
        : undefined
    if (googleAds.verifyProcessing) {
      if (typeof requestId !== 'string' || !requestId) {
        return { kind: 'retry', reason: 'missing_request_id' }
      }
      return { ...processingWait({ requestId, submittedAt: now.toISOString() }, now), request }
    }
    return {
      kind: 'sent',
      request,
      ...(requestId !== undefined ? { response: { requestId } } : {}),
    }
  }
  if (response.status === 429 || response.status >= 500) {
    return {
      kind: 'retry',
      reason: `http_${response.status}`,
      retryAfterMs: retryAfterMs(response.headers, now),
      ...(data === undefined ? {} : { response: data }),
    }
  }
  if (response.status === 401 || response.status === 403) {
    return {
      kind: 'dead',
      reason: 'permission_denied',
      ...(data === undefined ? {} : { response: data }),
    }
  }
  if (response.status === 400) {
    const message = errorMessage(data)
    return {
      kind: 'dead',
      reason: 'invalid_argument',
      ...(message !== undefined ? { response: message } : {}),
    }
  }
  return {
    kind: 'dead',
    reason: `http_${response.status}`,
    ...(data === undefined ? {} : { response: data }),
  }
}

export const googleAdsHandler: DestinationHandler = {
  deliver: async ({ delivery, event, now, options, signal }) => {
    const googleAds = options.destinations.googleAds
    if (!googleAds?.enabled) {
      return { kind: 'withheld', reason: 'not_configured' }
    }

    if (googleAds.transport !== 'dataManager') {
      return feedOutcome(event, now, googleAds.allowBraidsInFeed)
    }

    return dataManagerOutcome(
      event,
      googleAds,
      options.endpoints.dataManager,
      now,
      signal,
      delivery,
    )
  },
  destination: 'googleAds',
}
