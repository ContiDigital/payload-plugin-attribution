import type {
  Attribution,
  ConversionEventDoc,
  Ga4Item,
  MetaActionSource,
} from '../../../types/index.js'

import { DEFAULT_CURRENCY } from '../../../constants.js'
import { sha256 } from '../../../core/identifiers/normalize.js'
import { toMajorUnits } from '../../../core/money.js'
import { safePageUrl } from '../../../core/sanitize.js'

// Meta's own fbc: fb.1.<creation ms>.<fbclid>. When the browser pixel never set attribution.fbc,
// the server event reconstructs it from the fbclid captured on the touch that carried it, using
// that touch's own capturedAt (not clickCapturedAt, which tracks a possibly different click id).
function buildFbc(attribution?: Attribution): string | undefined {
  if (attribution?.fbc) {
    return attribution.fbc
  }
  if (attribution?.fbclid && attribution.capturedAt) {
    const capturedAtMs = Date.parse(attribution.capturedAt)
    if (Number.isFinite(capturedAtMs)) {
      return `fb.1.${capturedAtMs}.${attribution.fbclid}`
    }
  }
  return undefined
}

function buildExternalId(event: ConversionEventDoc): string | undefined {
  const externalId = event.identifiers?.meta?.external_id
  if (externalId) {
    return externalId
  }
  return event.userId ? sha256(event.userId) : undefined
}

/** Meta `user_data`: identifiers.meta is already SHA-256 hashed; ip, user agent, fbc and fbp are not. */
export function buildMetaUserData(event: ConversionEventDoc): Record<string, string> {
  const identifiers = event.identifiers?.meta
  const userData: Record<string, string> = {}
  if (identifiers?.em) {
    userData.em = identifiers.em
  }
  if (identifiers?.ph) {
    userData.ph = identifiers.ph
  }
  if (identifiers?.fn) {
    userData.fn = identifiers.fn
  }
  if (identifiers?.ln) {
    userData.ln = identifiers.ln
  }
  if (identifiers?.ct) {
    userData.ct = identifiers.ct
  }
  if (identifiers?.st) {
    userData.st = identifiers.st
  }
  if (identifiers?.zp) {
    userData.zp = identifiers.zp
  }
  if (identifiers?.country) {
    userData.country = identifiers.country
  }
  const externalId = buildExternalId(event)
  if (externalId) {
    userData.external_id = externalId
  }
  if (event.context?.ipAddress) {
    userData.client_ip_address = event.context.ipAddress
  }
  if (event.context?.userAgent) {
    userData.client_user_agent = event.context.userAgent
  }
  const fbc = buildFbc(event.attribution)
  if (fbc) {
    userData.fbc = fbc
  }
  if (event.attribution?.fbp) {
    userData.fbp = event.attribution.fbp
  }
  return userData
}

/** Meta requires at least one customer information parameter; client_ip_address alone (with no user agent) does not count. */
export function hasSufficientMetaUserData(event: ConversionEventDoc): boolean {
  const userData = buildMetaUserData(event)
  return Boolean(
    userData.em ||
    userData.ph ||
    userData.external_id ||
    userData.fbc ||
    userData.fbp ||
    (userData.client_ip_address && userData.client_user_agent),
  )
}

function buildContents(items?: Ga4Item[] | null): Record<string, unknown>[] | undefined {
  if (!items?.length) {
    return undefined
  }
  return items.map((item) => ({
    ...(item.item_id !== undefined ? { id: item.item_id } : {}),
    ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
    ...(item.price !== undefined ? { item_price: item.price } : {}),
  }))
}

function buildCustomData(event: ConversionEventDoc): Record<string, unknown> | undefined {
  const currency = event.currency ?? DEFAULT_CURRENCY
  const hasValue = event.valueCents !== undefined && event.valueCents !== null
  const contents = buildContents(event.items)
  const customData: Record<string, unknown> = {
    ...(hasValue ? { currency, value: toMajorUnits(event.valueCents as number, currency) } : {}),
    ...(event.transactionId ? { order_id: event.transactionId } : {}),
    ...(contents ? { contents } : {}),
  }
  return Object.keys(customData).length ? customData : undefined
}

export function buildMetaBody(
  event: ConversionEventDoc,
  mapped: { actionSource: MetaActionSource; name: string },
  options: { limitedDataUse?: boolean; testEventCode?: string },
): Record<string, unknown> {
  const customData = buildCustomData(event)
  const sourceUrl = event.context?.url ? safePageUrl(event.context.url) : undefined

  const data: Record<string, unknown> = {
    action_source: mapped.actionSource,
    event_id: event.eventId ?? event.eventKey,
    event_name: mapped.name,
    event_time: Math.floor(Date.parse(event.occurredAt) / 1000),
    ...(sourceUrl ? { event_source_url: sourceUrl } : {}),
    user_data: buildMetaUserData(event),
    ...(customData ? { custom_data: customData } : {}),
    ...(options.limitedDataUse
      ? {
          data_processing_options: ['LDU'],
          data_processing_options_country: 0,
          data_processing_options_state: 0,
        }
      : {}),
  }

  return {
    data: [data],
    ...(options.testEventCode ? { test_event_code: options.testEventCode } : {}),
  }
}
