import { isIP } from 'node:net'

import type { ConversionDraft, Ga4Item } from '../../types/index.js'

import {
  CONSENT_STATES,
  DESTINATIONS,
  EVENT_SOURCES,
  GOOGLE_ADS_ACTIONS,
  GOOGLE_ADS_KINDS,
} from '../../constants.js'
import { currencyDigits, isMinorUnits } from '../../core/money.js'
import { validEventName, validName } from '../../core/names.js'
import { hasControlChar, plainObject, safePageUrl } from '../../core/sanitize.js'

export const validStableID = (value: unknown, max = 64): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[A-Z0-9][\w.:-]*$/i.test(value) &&
  !/^[a-f0-9]{64}$/i.test(value)

const EVENT_ID_PATTERN = /^[\w.:-]{1,128}$/

// Active ISO 4217 codes only, in uppercase: every destination converts minor units with the same
// table, so an unknown code would otherwise be stored and fail at delivery.
const knownCurrency = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false
  }
  try {
    currencyDigits(value)
    return true
  } catch {
    return false
  }
}
const ADS_KINDS = ['auto', ...GOOGLE_ADS_KINDS] as const
const CONSENT_KEYS = ['adUserData', 'adPersonalization', 'analyticsStorage'] as const

export function validateItems(items: unknown): items is Ga4Item[] {
  return (
    Array.isArray(items) &&
    items.length <= 200 &&
    items.every((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return false
      }
      const row = item as Record<string, unknown>
      if (!(
        (typeof row.item_id === 'string' && row.item_id.trim()) ||
        (typeof row.item_name === 'string' && row.item_name.trim())
      )) {
        return false
      }
      if (Object.keys(row).length > 42) {
        return false
      }
      return Object.entries(row).every(
        ([key, value]) =>
          validName(key) &&
          (typeof value === 'string'
            ? !value.includes('@')
            : typeof value === 'number' && Number.isFinite(value) && value >= 0),
      )
    })
  )
}

function validContextIp(value: unknown): boolean {
  return typeof value === 'string' && (isIP(value) === 4 || isIP(value) === 6)
}

function validContextUrl(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function validUserAgent(value: unknown): boolean {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= 1024 && !hasControlChar(value)
  )
}

/**
 * Turns a value into a fresh object if (and only if) it is a plain object,
 * reading each of its own enumerable keys exactly once in the process. A
 * getter/accessor property on the source is read once here and becomes a
 * plain data property on the copy, so later reads of the copy can never
 * observe a different answer than the one validated.
 */
function shallowCopyIfPlainObject(value: unknown): unknown {
  return plainObject(value) ? { ...value } : value
}

function copyItems(value: unknown): unknown {
  return Array.isArray(value) ? value.map((item) => shallowCopyIfPlainObject(item)) : value
}

/**
 * Reads every field of the caller-supplied draft exactly once into a fresh
 * object, so that (a) validation cannot be fooled by a getter that answers
 * differently on a later read than it did during validation (TOCTOU), and
 * (b) the value returned to the caller never aliases an object the caller
 * still holds a reference to.
 */
function snapshotDraft(input: Record<string, unknown>): ConversionDraft {
  const attribution = input.attribution
  return {
    name: input.name,
    attribution: attribution === null ? null : shallowCopyIfPlainObject(attribution),
    buyer: shallowCopyIfPlainObject(input.buyer),
    channel: input.channel,
    consent: shallowCopyIfPlainObject(input.consent),
    context: shallowCopyIfPlainObject(input.context),
    currency: input.currency,
    customerId: input.customerId,
    destinations: shallowCopyIfPlainObject(input.destinations),
    eventId: input.eventId,
    eventKey: input.eventKey,
    eventSource: input.eventSource,
    googleAds: shallowCopyIfPlainObject(input.googleAds),
    items: copyItems(input.items),
    listPriceCents: input.listPriceCents,
    occurredAt: input.occurredAt,
    params: shallowCopyIfPlainObject(input.params),
    revision: input.revision,
    shippingCents: input.shippingCents,
    subject: shallowCopyIfPlainObject(input.subject),
    taxCents: input.taxCents,
    transactionId: input.transactionId,
    valueCents: input.valueCents,
  } as ConversionDraft
}

export function validateDraft(
  draft: unknown,
): { draft: ConversionDraft; ok: true } | { ok: false; reason: string } {
  try {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      return { ok: false, reason: 'invalid_event_name' }
    }
    const snapshot = snapshotDraft(draft as Record<string, unknown>)
    const reason = validateDraftFields(snapshot)
    if (reason) {
      return { ok: false, reason }
    }
    if (typeof snapshot.context?.url === 'string') {
      snapshot.context = { ...snapshot.context, url: safePageUrl(snapshot.context.url) }
    }
    return { draft: snapshot, ok: true }
  } catch {
    return { ok: false, reason: 'invalid_draft' }
  }
}

function validateDraftFields(draft: ConversionDraft): string | undefined {
  if (!draft || !validEventName(draft.name)) {
    return 'invalid_event_name'
  }
  if (!validStableID(draft.eventKey, 200)) {
    return 'invalid_event_key'
  }
  if (typeof draft.occurredAt !== 'string' || !Number.isFinite(Date.parse(draft.occurredAt))) {
    return 'invalid_time'
  }
  if (draft.eventId !== undefined && !EVENT_ID_PATTERN.test(draft.eventId)) {
    return 'invalid_event_id'
  }
  if (draft.transactionId !== undefined && !validStableID(draft.transactionId)) {
    return 'invalid_transaction_id'
  }
  if (
    draft.buyer !== undefined &&
    (!plainObject(draft.buyer) ||
      Object.values(draft.buyer).some((value) => value != null && typeof value !== 'string'))
  ) {
    return 'invalid_identifiers'
  }
  if (draft.eventSource !== undefined && !EVENT_SOURCES.includes(draft.eventSource)) {
    return 'invalid_event_source'
  }
  if (
    draft.channel !== undefined &&
    (typeof draft.channel !== 'string' || draft.channel.length > 100 || draft.channel.includes('@'))
  ) {
    return 'invalid_channel'
  }
  for (const value of [
    draft.valueCents,
    draft.taxCents,
    draft.shippingCents,
    draft.listPriceCents,
    draft.googleAds?.adjustedValueCents,
  ]) {
    if (value !== undefined && !isMinorUnits(value)) {
      return 'invalid_money'
    }
  }
  if (
    draft.revision !== undefined &&
    (!Number.isSafeInteger(draft.revision) || draft.revision < 1)
  ) {
    return 'invalid_revision'
  }
  if (draft.currency !== undefined && !knownCurrency(draft.currency)) {
    return 'invalid_currency'
  }
  if (draft.items !== undefined && !validateItems(draft.items)) {
    return 'invalid_items'
  }
  if (
    draft.name === 'purchase' &&
    (!draft.transactionId || draft.valueCents === undefined || !draft.items?.length)
  ) {
    return 'invalid_purchase'
  }
  if (draft.name === 'refund' && !draft.transactionId) {
    return 'invalid_refund'
  }
  if (
    draft.googleAds &&
    (!GOOGLE_ADS_ACTIONS.includes(draft.googleAds.action) ||
      (draft.googleAds.kind !== undefined && !ADS_KINDS.includes(draft.googleAds.kind)))
  ) {
    return 'invalid_ads_kind'
  }
  if (
    draft.googleAds &&
    draft.googleAds.action !== 'none' &&
    draft.googleAds.kind !== 'none' &&
    !draft.transactionId
  ) {
    return 'missing_transaction_id'
  }
  if (
    draft.name === 'refund' &&
    draft.googleAds?.kind === 'restatement' &&
    draft.googleAds.adjustedValueCents === undefined
  ) {
    return 'refund_requires_adjusted_value'
  }
  if (
    draft.attribution !== undefined &&
    draft.attribution !== null &&
    !plainObject(draft.attribution)
  ) {
    return 'invalid_attribution'
  }
  if (draft.consent !== undefined) {
    if (!plainObject(draft.consent)) {
      return 'invalid_consent'
    }
    for (const [key, value] of Object.entries(draft.consent)) {
      if (
        !(CONSENT_KEYS as readonly string[]).includes(key) ||
        !(CONSENT_STATES as readonly string[]).includes(value as string)
      ) {
        return 'invalid_consent'
      }
    }
  }
  if (draft.context !== undefined) {
    if (!plainObject(draft.context)) {
      return 'invalid_context'
    }
    if (draft.context.ipAddress !== undefined && !validContextIp(draft.context.ipAddress)) {
      return 'invalid_ip_address'
    }
    if (draft.context.url !== undefined && !validContextUrl(draft.context.url)) {
      return 'invalid_url'
    }
    if (draft.context.userAgent !== undefined && !validUserAgent(draft.context.userAgent)) {
      return 'invalid_context'
    }
  }
  if (draft.destinations !== undefined) {
    if (!plainObject(draft.destinations)) {
      return 'invalid_destinations'
    }
    for (const [key, value] of Object.entries(draft.destinations)) {
      if (!(DESTINATIONS as readonly string[]).includes(key) || typeof value !== 'boolean') {
        return 'invalid_destinations'
      }
    }
  }
  if (draft.params) {
    if (!plainObject(draft.params)) {
      return 'invalid_params'
    }
    const protectedKeys = new Set([
      'currency',
      'engagement_time_msec',
      'items',
      'session_id',
      'shipping',
      'tax',
      'timestamp_micros',
      'transaction_id',
      'user_id',
      'value',
    ])
    for (const [key, value] of Object.entries(draft.params)) {
      if (!validName(key) || protectedKeys.has(key)) {
        return 'reserved_parameter'
      }
      if (
        !['boolean', 'number', 'string'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value)) ||
        (typeof value === 'string' && value.includes('@'))
      ) {
        return 'invalid_parameter_value'
      }
    }
  }
}
