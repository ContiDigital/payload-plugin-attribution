import type { DestinationHandler, DestinationOutcome } from '../types.js'

import { HttpNetworkError } from '../../utilities/errors.js'
import { postJson, responseData } from '../../utilities/http.js'
import { retryAfterMs } from '../../utilities/retryAfter.js'
import { resolveSetting } from '../../utilities/settings.js'
import { metaEligibility, resolveMetaEvent } from './events.js'
import { buildMetaBody } from './payload.js'

// Meta error codes documented as transient/rate-limit-shaped: application request limit, API too
// many calls, temporary issues, and ad account/pixel throughput limits.
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 613, 80004])
// Access-token and permission failures: expired/invalid token, unknown user, no permission.
const AUTH_ERROR_CODES = new Set([10, 190, 200])

type MetaErrorBody = {
  code?: unknown
  error_subcode?: unknown
  fbtrace_id?: unknown
  is_transient?: unknown
  message?: unknown
  type?: unknown
}

function metaError(data: unknown): MetaErrorBody | undefined {
  if (!data || typeof data !== 'object' || !('error' in data)) {
    return undefined
  }
  const error = (data as { error?: unknown }).error
  return error && typeof error === 'object' ? (error as MetaErrorBody) : undefined
}

function successOutcome(
  data: unknown,
  request: Record<string, unknown>,
): DestinationOutcome | undefined {
  if (!data || typeof data !== 'object') {
    return undefined
  }
  const eventsReceived = (data as { events_received?: unknown }).events_received
  if (typeof eventsReceived !== 'number' || eventsReceived < 1) {
    return undefined
  }
  const fbtraceId = (data as { fbtrace_id?: unknown }).fbtrace_id
  return {
    kind: 'sent',
    request,
    response: { eventsReceived, ...(typeof fbtraceId === 'string' ? { fbtraceId } : {}) },
  }
}

function errorOutcome(
  status: number,
  data: unknown,
  headers: Headers,
  now: Date,
): DestinationOutcome {
  const error = metaError(data)
  const code = typeof error?.code === 'number' ? error.code : undefined
  const httpRetryable = status === 429 || status >= 500
  const metaTransient =
    error?.is_transient === true || (code !== undefined && RETRYABLE_CODES.has(code))

  if (httpRetryable || metaTransient) {
    return {
      kind: 'retry',
      reason: httpRetryable ? `http_${status}` : 'meta_transient',
      retryAfterMs: retryAfterMs(headers, now),
      ...(data === undefined ? {} : { response: data }),
    }
  }

  if ((code !== undefined && AUTH_ERROR_CODES.has(code)) || error?.type === 'OAuthException') {
    return { kind: 'dead', reason: 'auth_error', ...(data === undefined ? {} : { response: data }) }
  }

  const message = typeof error?.message === 'string' ? error.message : undefined
  const fbtraceId = typeof error?.fbtrace_id === 'string' ? error.fbtrace_id : undefined
  return {
    kind: 'dead',
    reason: 'invalid_request',
    ...(message !== undefined || fbtraceId !== undefined
      ? {
          response: {
            ...(message !== undefined ? { message } : {}),
            ...(fbtraceId !== undefined ? { fbtraceId } : {}),
          },
        }
      : {}),
  }
}

export const metaHandler: DestinationHandler = {
  deliver: async ({ event, now, options, signal }) => {
    const meta = options.destinations.meta
    if (!meta?.enabled) {
      return { kind: 'withheld', reason: 'not_configured' }
    }

    // Defense in depth: planDeliveries applies the destination's consent policy before a
    // delivery is ever planned, but the handler itself must never send when ad user data
    // consent has been withdrawn since planning.
    if (event.consent.adUserData === 'denied') {
      return { kind: 'withheld', reason: 'consent_denied' }
    }

    // The mapping can change between planning and delivery.
    const mapped = resolveMetaEvent(event, meta.events)
    if (!mapped) {
      return { kind: 'withheld', reason: 'event_not_mapped' }
    }

    const eligibility = metaEligibility(event, mapped, now)
    if (!eligibility.eligible) {
      return { kind: 'withheld', reason: eligibility.reason }
    }

    const [pixelId, accessToken, testEventCode] = await Promise.all([
      resolveSetting(meta.pixelId),
      resolveSetting(meta.accessToken),
      resolveSetting(meta.testEventCode),
    ])
    if (!pixelId || !accessToken) {
      return { kind: 'withheld', reason: 'not_configured' }
    }

    const limitedDataUse =
      typeof meta.limitedDataUse === 'function'
        ? meta.limitedDataUse(event)
        : meta.limitedDataUse === true

    const body = buildMetaBody(event, mapped, {
      ...(testEventCode ? { testEventCode } : {}),
      limitedDataUse,
    })

    // pixelId is an operator-supplied Setting with no format validation in normalizeOptions
    // (unlike Google Ads' digit-only account ids), so it is encoded before joining the path.
    const url = `${options.endpoints.meta}/${meta.apiVersion}/${encodeURIComponent(pixelId)}/events`

    let response: Awaited<ReturnType<typeof postJson>>
    try {
      response = await postJson(url, body, {
        headers: { authorization: `Bearer ${accessToken}` },
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
      return (
        successOutcome(data, body) ?? {
          kind: 'dead',
          reason: 'invalid_response',
          ...(data === undefined ? {} : { response: data }),
        }
      )
    }

    return errorOutcome(response.status, data, response.headers, now)
  },
  destination: 'meta',
}
