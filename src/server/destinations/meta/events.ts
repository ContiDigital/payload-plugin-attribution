import type {
  ConversionEventDoc,
  EventSource,
  MetaActionSource,
  MetaEventMapping,
} from '../../../types/index.js'

import { ageMs, DAY_MS } from '../../../core/time.js'
import { hasSufficientMetaUserData } from './payload.js'

const DEFAULT_MAX_AGE_MS = 7 * DAY_MS
const PHYSICAL_STORE_MAX_AGE_MS = 62 * DAY_MS

const ACTION_SOURCE_BY_EVENT_SOURCE: Record<EventSource, MetaActionSource> = {
  IN_STORE: 'physical_store',
  OTHER: 'system_generated',
  PHONE: 'phone_call',
  WEB: 'website',
}

export function resolveMetaEvent(
  event: ConversionEventDoc,
  mapping: Record<string, MetaEventMapping>,
): { actionSource: MetaActionSource; name: string } | null {
  const entry = mapping[event.name]
  if (entry === undefined) {
    return null
  }
  const name = typeof entry === 'string' ? entry : entry.name
  const override = typeof entry === 'string' ? undefined : entry.actionSource
  const actionSource = override ?? ACTION_SOURCE_BY_EVENT_SOURCE[event.eventSource ?? 'OTHER']
  return { name, actionSource }
}

export function metaEligibility(
  event: ConversionEventDoc,
  mapped: { actionSource: MetaActionSource },
  now: Date,
):
  | { eligible: false; reason: 'event_too_old' | 'missing_web_context' | 'no_user_data' }
  | { eligible: true } {
  const maxAgeMs =
    mapped.actionSource === 'physical_store' ? PHYSICAL_STORE_MAX_AGE_MS : DEFAULT_MAX_AGE_MS
  const age = ageMs(Date.parse(event.occurredAt), now.getTime())
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
    return { eligible: false, reason: 'event_too_old' }
  }
  if (mapped.actionSource === 'website' && !(event.context?.url && event.context?.userAgent)) {
    return { eligible: false, reason: 'missing_web_context' }
  }
  if (!hasSufficientMetaUserData(event)) {
    return { eligible: false, reason: 'no_user_data' }
  }
  return { eligible: true }
}
