import type { Field, NamedGroupField } from 'payload'

import { ATTRIBUTION_SOURCES, CONSENT_STATES } from '../constants.js'
import { CLICK_ID_KEYS, plainObject, sanitizeAttribution } from '../core/sanitize.js'
import { boundedEnumName } from './boundedEnumName.js'

// Lengths are the longest value each sanitizer pattern in core/sanitize.ts accepts.
const TEXT_MAX_LENGTHS: Record<string, number> = {
  ...Object.fromEntries(CLICK_ID_KEYS.map((key) => [key, 500])),
  fbc: 522,
  fbp: 522,
  gaClientId: 47,
  gadCampaignId: 32,
  gadSource: 16,
  gaSessionId: 411,
  landingPath: 500,
  referrerHost: 200,
  utmCampaign: 200,
  utmContent: 200,
  utmCreativeFormat: 200,
  utmId: 200,
  utmMarketingTactic: 200,
  utmMedium: 200,
  utmSource: 200,
  utmSourcePlatform: 200,
  utmTerm: 200,
}

const DATE_KEYS = ['capturedAt', 'clickCapturedAt', 'firstSeenAt', 'gaSessionStartedAt'] as const

const SELECTS = [
  { name: 'consentAdUserData', options: CONSENT_STATES, suffix: 'c_aud' },
  { name: 'consentAdPersonalization', options: CONSENT_STATES, suffix: 'c_ap' },
  { name: 'consentAnalyticsStorage', options: CONSENT_STATES, suffix: 'c_as' },
  { name: 'source', options: ATTRIBUTION_SOURCES, suffix: 'src' },
] as const

export function attributionField(name = 'attribution'): NamedGroupField {
  const group = name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase()
  const fields: Field[] = [
    ...Object.entries(TEXT_MAX_LENGTHS).map(([key, maxLength]): Field => ({
      name: key,
      type: 'text',
      maxLength,
    })),
    { name: 'gaSessionNumber', type: 'number' },
    ...DATE_KEYS.map((key): Field => ({
      name: key,
      type: 'date',
      admin: { date: { pickerAppearance: 'dayAndTime' } },
    })),
    ...SELECTS.map((select): Field => ({
      name: select.name,
      type: 'select',
      enumName: boundedEnumName(`${group}_${select.suffix}`),
      options: [...select.options],
    })),
  ]
  const leaves = new Set(fields.map((field) => ('name' in field ? field.name : '')))
  // Payload merges group updates, so an explicit null is the only way to clear a stored leaf.
  const clearedLeaves = (value: unknown): Record<string, null> =>
    plainObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .filter((key) => leaves.has(key) && value[key] === null)
            .map((key) => [key, null]),
        )
      : {}
  return {
    name,
    type: 'group',
    admin: { readOnly: true },
    fields: fields.map(
      (field) => ({ ...field, admin: { ...field.admin, readOnly: true } }) as Field,
    ),
    hooks: {
      beforeValidate: [
        ({ value }) =>
          value === undefined
            ? value
            : { ...clearedLeaves(value), ...(sanitizeAttribution(value) ?? {}) },
      ],
    },
  }
}
