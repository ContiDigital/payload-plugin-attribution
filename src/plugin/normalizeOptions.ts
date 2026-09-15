import type { Config } from 'payload'

import type {
  AttributionPluginOptions,
  ConsentPolicy,
  Ga4DestinationOptions,
  GoogleAdsDestinationOptions,
  MetaDestinationOptions,
  MetaEventMapping,
  NormalizedGa4Options,
  NormalizedGoogleAdsOptions,
  NormalizedMetaOptions,
  NormalizedOptions,
  Setting,
} from '../types/index.js'

import {
  CLAIMS_SLUG,
  CONSENT_POLICIES,
  DATA_MANAGER_ORIGIN,
  DEFAULT_ADMIN_GROUP,
  DEFAULT_API_BASE,
  DEFAULT_FEED_LOOKBACK_DAYS,
  DEFAULT_IDENTIFIER_RETENTION_DAYS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_META_API_VERSION,
  DEFAULT_META_EVENTS,
  DEFAULT_META_TIMEOUT_MS,
  DEFAULT_QUEUE,
  DELIVERIES_SLUG,
  EVENTS_SLUG,
  GA4_ADMIN_API_BASE,
  GOOGLE_ADS_TRANSPORTS,
  LOOPBACK_HOSTS,
  MAX_DESTINATION_TIMEOUT_MS,
  MAX_FEED_CONVERSION_NAME_LENGTH,
  MAX_FEED_LOOKBACK_DAYS,
  META_ACTION_SOURCES,
  META_GRAPH_ORIGIN,
  PLUGIN_SLUG,
} from '../constants.js'
import { payloadJobsDispatcher } from '../server/dispatch/payloadJobs.js'
import { sqlTableName } from './tableName.js'

const fail = (message: string): never => {
  throw new Error(`${PLUGIN_SLUG}: ${message}`)
}

const includes = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)

const presentSetting = (value: Setting | undefined): boolean =>
  typeof value === 'function' || (typeof value === 'string' && value.trim().length > 0)

// Function settings are resolved and validated at first use, not at config time.
const requireSetting = (value: Setting | undefined, label: string, context = ''): void => {
  if (!presentSetting(value)) {
    fail(`${label} is required${context}`)
  }
}

const digitSetting = (value: Setting | undefined, label: string): void => {
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    fail(`${label} must contain digits only, with no surrounding whitespace`)
  }
}

const positiveInteger = (value: number | undefined, fallback: number, label: string): number => {
  if (value === undefined) {
    return fallback
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive integer`)
  }
  return value
}

const consentPolicy = (
  value: unknown,
  fallback: ConsentPolicy,
  label: string,
  enabled: boolean,
): ConsentPolicy => {
  if (includes(CONSENT_POLICIES, value)) {
    return value
  }
  if (value !== undefined && enabled) {
    fail(`${label}.consentPolicy must be one of ${CONSENT_POLICIES.join(', ')}`)
  }
  return fallback
}

const normalizeGa4 = (input: Ga4DestinationOptions): NormalizedGa4Options => {
  const label = 'destinations.ga4'
  const enabled = input.enabled !== false
  if (enabled) {
    requireSetting(input.measurementId, `${label}.measurementId`)
    requireSetting(input.apiSecret, `${label}.apiSecret`)
  }
  return {
    ...input,
    consentPolicy: consentPolicy(input.consentPolicy, 'ignore', label, enabled),
    enabled,
    euEndpoint: input.euEndpoint === true,
    resendRevisions: input.resendRevisions === true,
    userProvidedData: input.userProvidedData === true,
  }
}

const FEED_NAME_PATTERN = /^[^\n\r",]+$/
// Spreadsheet tools that open the feed CSV treat these leading characters as a formula.
const FORMULA_PREFIX = /^[\t\r+=@-]/

const validateConversionActions = (input: GoogleAdsDestinationOptions, label: string): void => {
  for (const key of ['lead', 'sale'] as const) {
    const value: unknown = input.conversionActions?.[key]
    const field = `${label}.conversionActions.${key}`
    if (input.transport === 'dataManager') {
      if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        fail(
          `${field} must be a Data Manager conversion action id (digits only, no surrounding whitespace)`,
        )
      }
    } else if (typeof value === 'string' && FORMULA_PREFIX.test(value)) {
      fail(`${field} must not start with +, -, =, @, a tab or a carriage return`)
    } else if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value !== value.trim() ||
      value.length > MAX_FEED_CONVERSION_NAME_LENGTH ||
      !FEED_NAME_PATTERN.test(value)
    ) {
      fail(
        `${field} must be a conversion name of 1 to ${MAX_FEED_CONVERSION_NAME_LENGTH} characters without commas, double quotes, newlines or surrounding whitespace`,
      )
    }
  }
}

const normalizeGoogleAds = (input: GoogleAdsDestinationOptions): NormalizedGoogleAdsOptions => {
  const label = 'destinations.googleAds'
  const enabled = input.enabled !== false
  const adjustments = { enabled: input.adjustments?.enabled === true }
  const lookbackDays = input.feed?.lookbackDays ?? DEFAULT_FEED_LOOKBACK_DAYS
  if (enabled) {
    if (!includes(GOOGLE_ADS_TRANSPORTS, input.transport)) {
      fail(`${label}.transport must be one of ${GOOGLE_ADS_TRANSPORTS.join(', ')}`)
    }
    validateConversionActions(input, label)
    if (input.accessToken !== undefined && typeof input.accessToken !== 'function') {
      fail(`${label}.accessToken must be a function returning a bearer token`)
    }
    if (input.transport === 'dataManager') {
      const context = ' for transport "dataManager"'
      requireSetting(input.operatingAccountId, `${label}.operatingAccountId`, context)
      if (!input.accessToken) {
        requireSetting(
          input.serviceAccountJson,
          `${label}.serviceAccountJson`,
          `${context} unless accessToken is set`,
        )
      }
      digitSetting(input.operatingAccountId, `${label}.operatingAccountId`)
      digitSetting(input.loginAccountId, `${label}.loginAccountId`)
    }
    if (
      (input.transport === 'feed' || adjustments.enabled) &&
      !(presentSetting(input.feed?.username) && presentSetting(input.feed?.password))
    ) {
      fail(
        `${label} feed credentials (feed.username and feed.password) are required for transport "feed" and for adjustments`,
      )
    }
    if (
      !Number.isInteger(lookbackDays) ||
      lookbackDays < 1 ||
      lookbackDays > MAX_FEED_LOOKBACK_DAYS
    ) {
      fail(`${label}.feed.lookbackDays must be an integer from 1 to ${MAX_FEED_LOOKBACK_DAYS}`)
    }
  }
  const { feed, ...rest } = input
  return {
    ...rest,
    adjustments,
    allowBraidsInFeed: input.allowBraidsInFeed === true,
    consentPolicy: consentPolicy(input.consentPolicy, 'withhold-denied', label, enabled),
    enabled,
    ...(feed ? { feed: { ...feed, lookbackDays } } : {}),
  }
}

const validMetaMapping = (mapping: MetaEventMapping): boolean =>
  typeof mapping === 'string'
    ? mapping.trim().length > 0
    : typeof mapping === 'object' &&
      mapping !== null &&
      typeof mapping.name === 'string' &&
      mapping.name.trim().length > 0 &&
      (mapping.actionSource === undefined || includes(META_ACTION_SOURCES, mapping.actionSource))

const normalizeMeta = (input: MetaDestinationOptions): NormalizedMetaOptions => {
  const label = 'destinations.meta'
  const enabled = input.enabled !== false
  const apiVersion = input.apiVersion ?? DEFAULT_META_API_VERSION
  const events = { ...(input.events ?? DEFAULT_META_EVENTS) }
  const timeoutMs = enabled
    ? positiveInteger(input.timeoutMs, DEFAULT_META_TIMEOUT_MS, `${label}.timeoutMs`)
    : (input.timeoutMs ?? DEFAULT_META_TIMEOUT_MS)
  if (enabled) {
    requireSetting(input.pixelId, `${label}.pixelId`)
    requireSetting(input.accessToken, `${label}.accessToken`)
    if (timeoutMs > MAX_DESTINATION_TIMEOUT_MS) {
      fail(
        `${label}.timeoutMs must be at most ${MAX_DESTINATION_TIMEOUT_MS} ms, half the delivery lease`,
      )
    }
    if (!/^v\d+\.\d+$/.test(apiVersion)) {
      fail(`${label}.apiVersion must look like "${DEFAULT_META_API_VERSION}"`)
    }
    for (const [name, mapping] of Object.entries(events)) {
      if (!validMetaMapping(mapping)) {
        fail(`${label}.events.${name} must be an event name or { name, actionSource }`)
      }
    }
  }
  return {
    ...input,
    apiVersion,
    consentPolicy: consentPolicy(input.consentPolicy, 'withhold-denied', label, enabled),
    enabled,
    events,
    limitedDataUse: input.limitedDataUse ?? false,
    resendRevisions: input.resendRevisions === true,
    timeoutMs,
  }
}

const normalizeDestinations = (
  input: AttributionPluginOptions['destinations'],
): NormalizedOptions['destinations'] => ({
  ...(input?.ga4 ? { ga4: normalizeGa4(input.ga4) } : {}),
  ...(input?.googleAds ? { googleAds: normalizeGoogleAds(input.googleAds) } : {}),
  ...(input?.meta ? { meta: normalizeMeta(input.meta) } : {}),
})

const normalizePolicy = (
  input: AttributionPluginOptions['policy'],
): NormalizedOptions['policy'] => {
  for (const key of ['leadValuePercent', 'formLeadValueCents'] as const) {
    const value = input?.[key]
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      fail(`policy.${key} must be a finite non-negative number`)
    }
  }
  if (input?.formLeadValueCents !== undefined && !Number.isSafeInteger(input.formLeadValueCents)) {
    fail('policy.formLeadValueCents must be integer minor units')
  }
  return { ...input }
}

const endpoint = (value: unknown, label: string, fallback: string): string => {
  if (value === undefined) {
    return fallback
  }
  let url: undefined | URL
  try {
    url = typeof value === 'string' ? new URL(value) : undefined
  } catch {
    url = undefined
  }
  if (
    url === undefined ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && includes(LOOPBACK_HOSTS, url.hostname))
    )
  ) {
    return fail(
      `endpoints.${label} must be an https URL, or an http URL on localhost, 127.0.0.1 or [::1], without credentials, query or fragment`,
    )
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

const normalizeEndpoints = (
  input: AttributionPluginOptions['endpoints'],
): NormalizedOptions['endpoints'] => {
  const ga4 = input?.ga4 === undefined ? undefined : endpoint(input.ga4, 'ga4', '')
  return {
    dataManager: endpoint(input?.dataManager, 'dataManager', DATA_MANAGER_ORIGIN),
    ...(ga4 === undefined ? {} : { ga4 }),
    ga4Admin: endpoint(input?.ga4Admin, 'ga4Admin', GA4_ADMIN_API_BASE),
    meta: endpoint(input?.meta, 'meta', META_GRAPH_ORIGIN),
  }
}

const COLLECTION_SLUG = /^[a-z][\w-]*$/i

const normalizeCollections = (
  input: AttributionPluginOptions['collections'],
): NormalizedOptions['collections'] => {
  const collections = {
    claims: input?.claims?.slug ?? CLAIMS_SLUG,
    deliveries: input?.deliveries?.slug ?? DELIVERIES_SLUG,
    events: input?.events?.slug ?? EVENTS_SLUG,
  }
  for (const [key, slug] of Object.entries(collections)) {
    if (typeof slug !== 'string' || slug.length > 60 || !COLLECTION_SLUG.test(slug)) {
      fail(
        `collections.${key}.slug must start with a letter and contain only letters, digits, - and _`,
      )
    }
  }
  if (new Set(Object.values(collections).map(sqlTableName)).size !== 3) {
    fail('collections slugs must name three different database tables')
  }
  return collections
}

const CRON_FIELD = /^[\d*,/?#A-Z-]+$/i

const normalizeSweep = (input: AttributionPluginOptions['sweep']): NormalizedOptions['sweep'] => {
  const cron: unknown = input?.cron
  const queue: unknown = input?.queue
  if (cron !== undefined) {
    const fields = typeof cron === 'string' ? cron.split(' ') : []
    if (
      typeof cron !== 'string' ||
      (fields.length !== 5 && fields.length !== 6) ||
      !fields.every((field) => CRON_FIELD.test(field))
    ) {
      fail('sweep.cron must be a cron expression with 5 or 6 space-separated fields')
    }
  }
  if (queue !== undefined && (typeof queue !== 'string' || queue.trim().length === 0)) {
    fail('sweep.queue must be a non-empty string')
  }
  return {
    ...(typeof cron === 'string' ? { cron } : {}),
    ...(typeof queue === 'string' ? { queue } : {}),
  }
}

export const normalizeOptions = (
  input: AttributionPluginOptions,
  config: Pick<Config, 'admin'> = {},
): NormalizedOptions => {
  const disabled = input.disabled === true
  if (!disabled) {
    requireSetting(input.secret, 'secret')
  }
  if (input.authorize !== undefined && typeof input.authorize !== 'function') {
    fail('authorize must be a function')
  }

  const apiBasePath = input.apiBasePath ?? DEFAULT_API_BASE
  if (!/^(?:\/[\w-]+)+$/.test(apiBasePath)) {
    fail('apiBasePath must be a path such as "/attribution" with no trailing slash')
  }
  const queue = input.queue ?? DEFAULT_QUEUE
  if (typeof queue !== 'string' || queue.trim().length === 0) {
    fail('queue must be a non-empty string')
  }
  const adminGroup = input.adminGroup ?? DEFAULT_ADMIN_GROUP
  const defaultPhoneCountry = input.identity?.defaultPhoneCountry
  if (defaultPhoneCountry !== undefined && !/^[A-Z]{2}$/.test(defaultPhoneCountry)) {
    fail('identity.defaultPhoneCountry must be two uppercase letters, such as "US"')
  }

  const adminUser = config.admin?.user ?? 'users'
  return {
    adminGroup,
    apiBasePath,
    authorize:
      input.authorize ??
      (({ req, scope }) =>
        scope !== 'pii' && Boolean(req.user && req.user.collection === adminUser)),
    collections: normalizeCollections(input.collections),
    destinations: disabled ? {} : normalizeDestinations(input.destinations),
    disabled,
    dispatcher: input.dispatcher ?? payloadJobsDispatcher(),
    endpoints: normalizeEndpoints(input.endpoints),
    identity: { ...input.identity },
    maxAttempts: positiveInteger(input.maxAttempts, DEFAULT_MAX_ATTEMPTS, 'maxAttempts'),
    policy: normalizePolicy(input.policy),
    privacy: {
      identifierRetentionDays: positiveInteger(
        input.privacy?.identifierRetentionDays,
        DEFAULT_IDENTIFIER_RETENTION_DAYS,
        'privacy.identifierRetentionDays',
      ),
    },
    queue,
    secret: input.secret ?? '',
    sweep: normalizeSweep(input.sweep),
  }
}
