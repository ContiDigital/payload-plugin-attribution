import type { Payload } from 'payload'

import type { ConversionEventDoc, Destination, NormalizedOptions } from '../../types/index.js'

import { DATA_MANAGER_INGEST_PATH, GA4_MP_EU_ORIGIN, GA4_MP_ORIGIN } from '../../constants.js'
import { getPluginContext } from '../../plugin/getPluginContext.js'
import { deliveryLookup } from '../deliveries/lookup.js'
import { readEvent } from '../deliveries/store.js'
import { buildGa4Body } from '../destinations/ga4/payload.js'
import { prepareDataManagerAdjustment } from '../destinations/googleAds/adjustment.js'
import { dataManagerAccessToken, hostAccessToken } from '../destinations/googleAds/auth.js'
import {
  googleAdsEligibility,
  googleAdsFeedEligibility,
} from '../destinations/googleAds/eligibility.js'
import { buildIngestRequest } from '../destinations/googleAds/payload.js'
import {
  adjustmentNotApplicable,
  decideAdjustment,
  originalDelivered,
} from '../destinations/googleAdsFeed/adjustmentDecision.js'
import { adjustmentRow, conversionRow } from '../destinations/googleAdsFeed/rows.js'
import { metaEligibility, resolveMetaEvent } from '../destinations/meta/events.js'
import { buildMetaBody } from '../destinations/meta/payload.js'
import { feedCredentials } from '../endpoints/basicAuth.js'
import {
  HttpNetworkError,
  isAbortError,
  NotFoundError,
  SettingUnavailableError,
} from '../utilities/errors.js'
import { postJson, responseData } from '../utilities/http.js'
import { resolveSetting } from '../utilities/settings.js'

export type VerifyResult = { details: unknown; ok: boolean }

const VERIFY_TIMEOUT_MS = 10000

const withheld = (reason: string): VerifyResult => ({ details: { reason }, ok: false })

async function networkOutcome<T extends VerifyResult>(
  run: () => Promise<T>,
): Promise<T | VerifyResult> {
  try {
    return await run()
  } catch (error) {
    if (isAbortError(error)) {
      return withheld('timeout')
    }
    if (error instanceof HttpNetworkError) {
      return withheld('network_error')
    }
    throw error
  }
}

async function verifyGa4(
  event: ConversionEventDoc,
  options: NormalizedOptions,
  now: Date,
  signal: AbortSignal,
): Promise<VerifyResult> {
  const ga4 = options.destinations.ga4
  if (!ga4?.enabled) {
    return withheld('not_configured')
  }
  if (event.consent?.analyticsStorage === 'denied') {
    return withheld('consent_denied')
  }
  const [measurementId, apiSecret, secret] = await Promise.all([
    resolveSetting(ga4.measurementId),
    resolveSetting(ga4.apiSecret),
    resolveSetting(options.secret),
  ])
  if (!measurementId || !apiSecret || !secret) {
    return withheld('not_configured')
  }

  let built: ReturnType<typeof buildGa4Body>
  try {
    built = buildGa4Body(event, { now, secret, userProvidedData: ga4.userProvidedData })
  } catch {
    return withheld('invalid_payload')
  }

  return networkOutcome(async () => {
    const host = options.endpoints.ga4 ?? (ga4.euEndpoint ? GA4_MP_EU_ORIGIN : GA4_MP_ORIGIN)
    const url = `${host}/debug/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`
    // The Measurement Protocol validation server reads validation_behavior from the JSON body,
    // not the query string.
    const body = { ...built.body, validation_behavior: 'ENFORCE_RECOMMENDATIONS' }
    const response = await postJson(url, body, { signal })
    const data = responseData(response)
    if (response.status < 200 || response.status >= 300) {
      return { details: { reason: `http_${response.status}`, response: data }, ok: false }
    }
    const validationMessages =
      data &&
      typeof data === 'object' &&
      Array.isArray((data as { validationMessages?: unknown }).validationMessages)
        ? (data as { validationMessages: unknown[] }).validationMessages
        : []
    // Fix: the legacy verify command reported success on any 2xx response, ignoring
    // validationMessages returned by the debug endpoint entirely.
    return { details: { validationMessages }, ok: validationMessages.length === 0 }
  })
}

async function verifyGoogleAdsDataManager(
  event: ConversionEventDoc,
  options: NonNullable<NormalizedOptions['destinations']['googleAds']>,
  origin: string,
  now: Date,
  signal: AbortSignal,
): Promise<VerifyResult> {
  const action = event.googleAdsAction
  if (action !== 'lead' && action !== 'sale') {
    return withheld('invalid_payload')
  }
  const eligibility = googleAdsEligibility(event, now)
  if (!eligibility.eligible) {
    return withheld(eligibility.reason)
  }
  const [operatingAccountId, loginAccountId, serviceAccountJson] = await Promise.all([
    resolveSetting(options.operatingAccountId),
    resolveSetting(options.loginAccountId),
    resolveSetting(options.serviceAccountJson),
  ])
  if (!operatingAccountId || (!options.accessToken && !serviceAccountJson)) {
    return withheld('not_configured')
  }

  let token: string
  try {
    token = options.accessToken
      ? await hostAccessToken(options.accessToken, signal)
      : await dataManagerAccessToken(serviceAccountJson, signal)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    return withheld('auth_error')
  }

  const request = buildIngestRequest(event, {
    conversionActionId: options.conversionActions[action],
    ...(loginAccountId ? { loginAccountId } : {}),
    match: eligibility.match,
    operatingAccountId,
    validateOnly: true,
  })

  return networkOutcome(async () => {
    const response = await postJson(`${origin}${DATA_MANAGER_INGEST_PATH}`, request, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    })
    const data = responseData(response)
    if (response.status >= 200 && response.status < 300) {
      return { details: data === undefined ? {} : { response: data }, ok: true }
    }
    return { details: { reason: `http_${response.status}`, response: data }, ok: false }
  })
}

function verifyGoogleAdsFeed(
  event: ConversionEventDoc,
  options: NonNullable<NormalizedOptions['destinations']['googleAds']>,
  now: Date,
): VerifyResult {
  const eligibility = googleAdsFeedEligibility(event, now, options.allowBraidsInFeed)
  if (!eligibility.eligible) {
    return withheld(eligibility.reason)
  }
  const row = conversionRow(event, options.conversionActions, {
    allowBraids: options.allowBraidsInFeed,
    now,
  })
  return row === null ? withheld('not_eligible') : { details: { row }, ok: true }
}

async function verifyGoogleAds(
  event: ConversionEventDoc,
  options: NormalizedOptions,
  now: Date,
  signal: AbortSignal,
): Promise<VerifyResult> {
  const googleAds = options.destinations.googleAds
  if (!googleAds?.enabled) {
    return withheld('not_configured')
  }
  return googleAds.transport === 'dataManager'
    ? verifyGoogleAdsDataManager(event, googleAds, options.endpoints.dataManager, now, signal)
    : verifyGoogleAdsFeed(event, googleAds, now)
}

// Mirrors googleAdsAdjustmentHandler.deliver exactly (src/server/destinations/googleAdsFeed/handler.ts),
// using the same read-only DeliveryLookup runDelivery uses, so verify never reports an adjustment
// as ready when a real delivery would withhold it (original not delivered, window closed,
// already retracted) or wait on it.
async function verifyGoogleAdsAdjustment(
  event: ConversionEventDoc,
  options: NormalizedOptions,
  payload: Payload,
  now: Date,
  signal: AbortSignal,
): Promise<VerifyResult> {
  const googleAds = options.destinations.googleAds
  if (!googleAds?.enabled || !googleAds.adjustments.enabled) {
    return withheld('not_configured')
  }
  if (googleAds.adjustments.transport === 'dataManager') {
    const prepared = await prepareDataManagerAdjustment({
      event,
      lookup: deliveryLookup(payload),
      now,
      payload,
    })
    if ('kind' in prepared) {
      return { details: prepared, ok: false }
    }
    return verifyGoogleAdsDataManager(
      prepared,
      googleAds,
      options.endpoints.dataManager,
      now,
      signal,
    )
  }
  const { password, username } = await feedCredentials(googleAds)
  if (!username || !password) {
    return withheld('not_configured')
  }
  const notApplicable = adjustmentNotApplicable(event)
  if (notApplicable) {
    return withheld(notApplicable)
  }
  const lookup = deliveryLookup(payload)
  const original = (await lookup.originalConversion(event))?.delivery ?? null
  const retracted = originalDelivered(original) ? await lookup.retracted(event) : false
  const outcome = decideAdjustment({ event, now, original, retracted })
  switch (outcome.kind) {
    case 'eligible': {
      const row = adjustmentRow(event, googleAds.conversionActions)
      return row === null ? withheld('not_eligible') : { details: { row }, ok: true }
    }
    case 'wait': {
      return {
        details: { deadlineAt: outcome.deadlineAt, reason: outcome.reason, until: outcome.until },
        ok: false,
      }
    }
    case 'withheld': {
      return withheld(outcome.reason)
    }
    default: {
      return withheld('invalid_outcome')
    }
  }
}

async function verifyMeta(
  event: ConversionEventDoc,
  options: NormalizedOptions,
  now: Date,
  signal: AbortSignal,
): Promise<VerifyResult> {
  const meta = options.destinations.meta
  if (!meta?.enabled) {
    return withheld('not_configured')
  }
  if (event.consent?.adUserData === 'denied') {
    return withheld('consent_denied')
  }
  const mapped = resolveMetaEvent(event, meta.events)
  if (!mapped) {
    return withheld('event_not_mapped')
  }
  const eligibility = metaEligibility(event, mapped, now)
  if (!eligibility.eligible) {
    return withheld(eligibility.reason)
  }
  const [pixelId, accessToken, testEventCode] = await Promise.all([
    resolveSetting(meta.pixelId),
    resolveSetting(meta.accessToken),
    resolveSetting(meta.testEventCode),
  ])
  if (!pixelId || !accessToken) {
    return withheld('not_configured')
  }
  // Sending without a test event code would create a real, billable conversion event.
  if (!testEventCode) {
    return withheld('test_event_code_required')
  }

  const limitedDataUse =
    typeof meta.limitedDataUse === 'function'
      ? meta.limitedDataUse(event)
      : meta.limitedDataUse === true
  const body = buildMetaBody(event, mapped, { limitedDataUse, testEventCode })
  const url = `${options.endpoints.meta}/${meta.apiVersion}/${encodeURIComponent(pixelId)}/events`

  return networkOutcome(async () => {
    const response = await postJson(url, body, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    })
    const data = responseData(response)
    if (response.status >= 200 && response.status < 300) {
      const eventsReceived =
        data && typeof data === 'object'
          ? (data as { events_received?: unknown }).events_received
          : undefined
      return {
        details: data === undefined ? {} : { response: data },
        ok: typeof eventsReceived === 'number' && eventsReceived >= 1,
      }
    }
    return { details: { reason: `http_${response.status}`, response: data }, ok: false }
  })
}

export async function verifyDestination(args: {
  destination: Destination
  eventId: number | string
  payload: Payload
}): Promise<VerifyResult> {
  const { destination, eventId, payload } = args
  const { options } = getPluginContext(payload)
  const event = await readEvent(payload, eventId)
  if (!event) {
    throw new NotFoundError('event_not_found')
  }
  const now = new Date()
  const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS)

  try {
    switch (destination) {
      case 'ga4': {
        return await verifyGa4(event, options, now, signal)
      }
      case 'googleAds': {
        return await verifyGoogleAds(event, options, now, signal)
      }
      case 'googleAdsAdjustment': {
        return await verifyGoogleAdsAdjustment(event, options, payload, now, signal)
      }
      case 'meta': {
        return await verifyMeta(event, options, now, signal)
      }
    }
  } catch (error) {
    // Mirrors runDelivery, which retries such a delivery instead of withholding it.
    if (error instanceof SettingUnavailableError) {
      return withheld('settings_unavailable')
    }
    throw error
  }
}
