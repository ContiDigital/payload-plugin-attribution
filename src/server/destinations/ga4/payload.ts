import { createHash } from 'node:crypto'

import type { ConversionEventDoc, GoogleIdentifiers } from '../../../types/index.js'

import { DEFAULT_CURRENCY } from '../../../constants.js'
import { toMajorUnits } from '../../../core/money.js'
import { validEventName, validName } from '../../../core/names.js'
import { sessionSeconds } from '../../../core/sanitize.js'
import { validateItems } from '../../record/validateDraft.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
// Google accepts timestamp_micros up to 72 hours old; an hour of margin covers queue and clock delay.
const EXACT_TIMESTAMP_WINDOW_MS = 71 * HOUR_MS
const SESSION_JOIN_WINDOW_MS = DAY_MS
const MAX_BODY_BYTES = 130_000
const MAX_PARAMS = 25
const MAX_USER_PROPERTIES = 25
const USER_PROPERTY_NAME_MAX = 24
const USER_PROPERTY_VALUE_MAX = 36
const HOST_PARAM_VALUE_MAX = 100
const CHANNEL_MAX = 100

function withinExactTimestampWindow(occurredAt: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(occurredAt)
  return age >= 0 && age <= EXACT_TIMESTAMP_WINDOW_MS
}

function sessionStartedWithinWindow(occurredAt: string, startedAt?: string): boolean {
  if (!startedAt) {
    return false
  }
  const elapsed = Date.parse(occurredAt) - Date.parse(startedAt)
  return elapsed >= 0 && elapsed <= SESSION_JOIN_WINDOW_MS
}

/**
 * Google Ads-style enhanced conversions for leads share this shape: a flat
 * set of hashed identity fields, plus one non-hashed address broken out into
 * its own object. Keys with no value are omitted rather than sent empty, and
 * the whole `address` array is omitted when none of its fields are present.
 */
function buildUserData(identifiers?: GoogleIdentifiers): Record<string, unknown> | undefined {
  if (!identifiers) {
    return undefined
  }
  const userData: Record<string, unknown> = {}
  if (identifiers.emailSha256) {
    userData.sha256_email_address = [identifiers.emailSha256]
  }
  if (identifiers.phoneSha256) {
    userData.sha256_phone_number = [identifiers.phoneSha256]
  }
  const address: Record<string, unknown> = {}
  if (identifiers.firstNameSha256) {
    address.sha256_first_name = identifiers.firstNameSha256
  }
  if (identifiers.lastNameSha256) {
    address.sha256_last_name = identifiers.lastNameSha256
  }
  if (identifiers.streetSha256) {
    address.sha256_street = identifiers.streetSha256
  }
  if (identifiers.city) {
    address.city = identifiers.city.toLowerCase()
  }
  if (identifiers.region) {
    address.region = identifiers.region.toLowerCase()
  }
  if (identifiers.postalCode) {
    address.postal_code = identifiers.postalCode
  }
  if (identifiers.country) {
    address.country = identifiers.country
  }
  if (Object.keys(address).length) {
    userData.address = [address]
  }
  return Object.keys(userData).length ? userData : undefined
}

export function buildGa4Body(
  event: ConversionEventDoc,
  options: { debug?: boolean; now: Date; secret: string; userProvidedData?: boolean },
): { body: Record<string, unknown>; sessionAttached: boolean; timestampMode: 'exact' | 'now' } {
  if (
    !options.secret ||
    !validEventName(event.name) ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    (event.items != null && !validateItems(event.items))
  ) {
    throw new TypeError('payload-plugin-attribution: invalid GA4 payload input')
  }

  const timestampMode = withinExactTimestampWindow(event.occurredAt, options.now)
    ? ('exact' as const)
    : ('now' as const)
  const seconds = sessionSeconds(event.attribution?.gaSessionId ?? '')
  const sessionAttached = Boolean(
    seconds && sessionStartedWithinWindow(event.occurredAt, event.attribution?.gaSessionStartedAt),
  )
  const digest = createHash('sha256')
    .update(options.secret + (event.userId || event.transactionId || event.eventKey))
    .digest()
  const clientId =
    event.attribution?.gaClientId ?? `${digest.readUInt32BE(0)}.${digest.readUInt32BE(4)}`

  const currency = event.currency ?? DEFAULT_CURRENCY
  const params: Record<string, unknown> = {}
  if (event.transactionId) {
    params.transaction_id = event.transactionId
  }
  params.currency = currency
  for (const [key, cents] of [
    ['value', event.valueCents],
    ['tax', event.taxCents],
    ['shipping', event.shippingCents],
  ] as const) {
    if (cents !== undefined && cents !== null) {
      params[key] = toMajorUnits(cents, currency)
    }
  }
  if (event.items?.length) {
    params.items = event.items.map((item) =>
      Object.fromEntries(
        Object.entries(item)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [
            key,
            typeof value === 'number' ? Math.round(value * 100) / 100 : String(value).slice(0, 100),
          ]),
      ),
    )
  }
  if (sessionAttached) {
    params.session_id = seconds
  }
  params.engagement_time_msec = 100
  if (timestampMode === 'now') {
    params.sale_date = event.occurredAt.slice(0, 10)
  }
  if (event.channel) {
    params.sales_channel = event.channel.slice(0, CHANNEL_MAX)
  }
  if (event.eventSource) {
    params.event_source = event.eventSource
  }
  if (options.debug) {
    params.debug_mode = true
  }
  for (const [key, value] of Object.entries(event.params ?? {})) {
    if (Object.keys(params).length >= MAX_PARAMS) {
      break
    }
    if (validName(key) && !Object.hasOwn(params, key)) {
      params[key] = typeof value === 'string' ? value.slice(0, HOST_PARAM_VALUE_MAX) : value
    }
  }

  const userProperties = Object.fromEntries(
    Object.entries(event.userProperties ?? {})
      .filter(([key]) => validName(key, USER_PROPERTY_NAME_MAX))
      .slice(0, MAX_USER_PROPERTIES)
      .map(([key, value]) => [
        key,
        { value: typeof value === 'string' ? value.slice(0, USER_PROPERTY_VALUE_MAX) : value },
      ]),
  )

  const consent = {
    ...(event.consent.adPersonalization === 'unknown'
      ? {}
      : { ad_personalization: event.consent.adPersonalization.toUpperCase() }),
    ...(event.consent.adUserData === 'unknown'
      ? {}
      : { ad_user_data: event.consent.adUserData.toUpperCase() }),
  }

  const userData =
    options.userProvidedData && event.consent.adUserData !== 'denied'
      ? buildUserData(event.identifiers?.google)
      : undefined

  const body = {
    client_id: clientId,
    ...(event.userId ? { user_id: event.userId } : {}),
    ...(timestampMode === 'exact' ? { timestamp_micros: Date.parse(event.occurredAt) * 1000 } : {}),
    ...(Object.keys(userProperties).length ? { user_properties: userProperties } : {}),
    ...(Object.keys(consent).length ? { consent } : {}),
    ...(userData ? { user_data: userData } : {}),
    events: [{ name: event.name, params }],
  }

  if (Buffer.byteLength(JSON.stringify(body), 'utf8') >= MAX_BODY_BYTES) {
    throw new RangeError('payload-plugin-attribution: GA4 payload exceeds 130 kB')
  }

  return { body, sessionAttached, timestampMode }
}
