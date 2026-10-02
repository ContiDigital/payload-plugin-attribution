import type { Payload, PayloadRequest } from 'payload'

import type {
  CONSENT_POLICIES,
  DELIVERY_STATUSES,
  DESTINATIONS,
  EVENT_SOURCES,
  GA4_KEY_EVENT_COUNTING_METHODS,
  GOOGLE_ADS_ACTIONS,
  GOOGLE_ADS_KINDS,
  META_ACTION_SOURCES,
} from '../constants.js'
import type { GoogleIdentifiers } from '../core/identifiers/google.js'
import type { MetaIdentifiers } from '../core/identifiers/meta.js'
import type { BuyerIdentity } from '../core/identifiers/normalize.js'
import type { Ga4Item } from '../core/items.js'
import type { Attribution, ConsentState } from '../core/sanitize.js'
import type { AttributionDispatcher } from '../server/dispatch/types.js'

export type { GoogleIdentifiers } from '../core/identifiers/google.js'
export type { MetaIdentifiers } from '../core/identifiers/meta.js'
export type { BuyerIdentity } from '../core/identifiers/normalize.js'
export type { Ga4Item } from '../core/items.js'
export type { Attribution, ConsentState } from '../core/sanitize.js'
export type {
  DeliveryLookup,
  DeliveryResult,
  DestinationHandler,
  DestinationOutcome,
} from '../server/destinations/types.js'
export type { AttributionDispatcher } from '../server/dispatch/types.js'

export type Destination = (typeof DESTINATIONS)[number]
export type Ga4KeyEventCountingMethod = (typeof GA4_KEY_EVENT_COUNTING_METHODS)[number]
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]
export type Setting = (() => Promise<string> | string) | string
export type AuthorizeScope = 'operate' | 'pii' | 'read'
export type ConsentPolicy = (typeof CONSENT_POLICIES)[number]
export type EventSource = (typeof EVENT_SOURCES)[number]
export type GoogleAdsAction = (typeof GOOGLE_ADS_ACTIONS)[number]
export type GoogleAdsKind = (typeof GOOGLE_ADS_KINDS)[number]
export type MetaActionSource = (typeof META_ACTION_SOURCES)[number]
export type MetaEventMapping = { actionSource?: MetaActionSource; name: string } | string

export type AuthorizeFn = (args: {
  req: PayloadRequest
  scope: AuthorizeScope
}) => boolean | Promise<boolean>

export type ResolvedIdentity = {
  marketingConsent?: boolean
  userId: string
  userProperties?: Record<string, number | string>
} & BuyerIdentity

export type ConversionDraft = {
  attribution?: Attribution | null
  buyer?: BuyerIdentity
  channel?: string
  consent?: {
    adPersonalization?: ConsentState
    adUserData?: ConsentState
    analyticsStorage?: ConsentState
  }
  context?: { ipAddress?: string; url?: string; userAgent?: string }
  currency?: string
  customerId?: number | string
  destinations?: Partial<Record<Destination, boolean>>
  eventId?: string
  eventKey: string
  eventSource?: EventSource
  googleAds?: {
    action: GoogleAdsAction
    adjustedValueCents?: number
    kind?: 'auto' | GoogleAdsKind
  }
  items?: Ga4Item[]
  listPriceCents?: number
  name: string
  occurredAt: string
  params?: Record<string, boolean | number | string>
  revision?: number
  shippingCents?: number
  subject?: { collectionSlug: string; id: number | string }
  taxCents?: number
  transactionId?: string
  valueCents?: number
}

export type OriginalConversion = { eventKey: string; name: string; occurredAt: string } | null

export type PropertyPlan = {
  eventDimensions?: string[]
  itemDimensions?: string[]
  keyEvents?: Array<{ countingMethod?: Ga4KeyEventCountingMethod; eventName: string } | string>
  userDimensions?: string[]
}

export type Ga4DestinationOptions = {
  apiSecret: Setting
  consentPolicy?: ConsentPolicy
  enabled?: boolean
  euEndpoint?: boolean
  measurementId: Setting
  propertyId?: Setting
  resendRevisions?: boolean
  userProvidedData?: boolean
}

export type GoogleAdsFeedOptions = {
  lookbackDays?: number
  password: Setting
  username: Setting
}

export type GoogleAdsDestinationOptions = {
  /**
   * Data Manager only. Supplies a bearer token instead of minting one from serviceAccountJson,
   * for hosts that obtain tokens elsewhere and for local mock providers.
   */
  accessToken?: () => Promise<string> | string
  /** Data Manager restates value only; count retractions require the feed transport. */
  adjustments?: { enabled?: boolean; transport?: 'dataManager' | 'feed' }
  allowBraidsInFeed?: boolean
  consentPolicy?: ConsentPolicy
  /** Data Manager: conversion action ids. Feed: conversion names. */
  conversionActions: { lead: string; sale: string }
  enabled?: boolean
  feed?: GoogleAdsFeedOptions
  loginAccountId?: Setting
  /** Data Manager only, digits. */
  operatingAccountId?: Setting
  /** Data Manager only. */
  serviceAccountJson?: Setting
  transport: 'dataManager' | 'feed'
  /** Wait for Google's asynchronous processing result before marking a delivery sent. */
  verifyProcessing?: boolean
}

export type MetaDestinationOptions = {
  accessToken: Setting
  apiVersion?: string
  consentPolicy?: ConsentPolicy
  enabled?: boolean
  events?: Record<string, MetaEventMapping>
  limitedDataUse?: ((event: ConversionEventDoc) => boolean) | boolean
  pixelId: Setting
  /** Send later host revisions of an event. Meta deduplicates only within 48 hours by event_id, so a revision can double count. */
  resendRevisions?: boolean
  testEventCode?: Setting
  timeoutMs?: number
}

export type AttributionPluginOptions = {
  adminGroup?: string
  apiBasePath?: string
  authorize?: AuthorizeFn
  /**
   * Slugs for the ledger collections, for hosts that already use the defaults
   * (conversion-events, conversion-deliveries and conversion-delivery-claims).
   */
  collections?: {
    claims?: { slug?: string }
    deliveries?: { slug?: string }
    events?: { slug?: string }
  }
  destinations?: {
    ga4?: Ga4DestinationOptions
    googleAds?: GoogleAdsDestinationOptions
    meta?: MetaDestinationOptions
  }
  disabled?: boolean
  dispatcher?: AttributionDispatcher
  /**
   * Replaces provider base URLs, for local mock providers in development and tests. Each value
   * must be an https URL or an http URL on localhost, 127.0.0.1 or [::1].
   */
  endpoints?: ProviderEndpoints
  identity?: {
    defaultPhoneCountry?: string
    resolve?: (args: {
      customerId: number | string
      payload: Payload
      req?: PayloadRequest
    }) => Promise<null | ResolvedIdentity>
  }
  maxAttempts?: number
  policy?: { formLeadValueCents?: number; leadValuePercent?: number }
  privacy?: { identifierRetentionDays?: number }
  queue?: string
  secret: Setting
  /**
   * Schedules the sweep task with a 5 or 6 field cron. Payload only enqueues scheduled jobs; the
   * host still runs the queue through jobs.autoRun or a worker, which the plugin never configures.
   */
  sweep?: { cron?: string; queue?: string }
}

export type ProviderEndpoints = {
  /** Data Manager API origin, default https://datamanager.googleapis.com */
  dataManager?: string
  /** Measurement Protocol origin for collect and debug requests; replaces euEndpoint when set. */
  ga4?: string
  /** GA4 Admin API base, default https://analyticsadmin.googleapis.com/v1beta */
  ga4Admin?: string
  /** Graph API origin, default https://graph.facebook.com */
  meta?: string
}

export type NormalizedGa4Options = {
  consentPolicy: ConsentPolicy
  enabled: boolean
  euEndpoint: boolean
  resendRevisions: boolean
  userProvidedData: boolean
} & Ga4DestinationOptions

export type NormalizedGoogleAdsOptions = {
  adjustments: { enabled: boolean; transport: 'dataManager' | 'feed' }
  allowBraidsInFeed: boolean
  consentPolicy: ConsentPolicy
  enabled: boolean
  feed?: { lookbackDays: number } & GoogleAdsFeedOptions
} & Omit<GoogleAdsDestinationOptions, 'adjustments' | 'feed'>

export type NormalizedMetaOptions = {
  apiVersion: string
  consentPolicy: ConsentPolicy
  enabled: boolean
  events: Record<string, MetaEventMapping>
  limitedDataUse: ((event: ConversionEventDoc) => boolean) | boolean
  resendRevisions: boolean
  timeoutMs: number
} & MetaDestinationOptions

export type NormalizedOptions = {
  adminGroup: string
  apiBasePath: string
  authorize: AuthorizeFn
  collections: { claims: string; deliveries: string; events: string }
  destinations: {
    ga4?: NormalizedGa4Options
    googleAds?: NormalizedGoogleAdsOptions
    meta?: NormalizedMetaOptions
  }
  disabled: boolean
  dispatcher: AttributionDispatcher
  endpoints: { dataManager: string; ga4?: string; ga4Admin: string; meta: string }
  identity: NonNullable<AttributionPluginOptions['identity']>
  maxAttempts: number
  policy: NonNullable<AttributionPluginOptions['policy']>
  privacy: { identifierRetentionDays: number }
  queue: string
  secret: Setting
  sweep: { cron?: string; queue?: string }
}

export type DeliverySummary = Partial<
  Record<Destination, { reason?: null | string; status: DeliveryStatus }>
>

export type ConversionEventDoc = {
  adjustedValueCents?: null | number
  attribution?: Attribution
  channel?: null | string
  consent: {
    adPersonalization: ConsentState
    adUserData: ConsentState
    analyticsStorage: ConsentState
  }
  context?: { ipAddress?: string; url?: string; userAgent?: string }
  createdAt: string
  currency?: null | string
  deliveries?: {
    docs?: Array<DeliveryDoc | number | string>
    hasNextPage?: boolean
    totalDocs?: number
  }
  deliverySummary?: DeliverySummary
  eventId?: null | string
  eventKey: string
  eventSource?: EventSource | null
  googleAdsAction?: GoogleAdsAction | null
  googleAdsKind?: GoogleAdsKind | null
  id: number | string
  identifiers?: { google?: GoogleIdentifiers; meta?: MetaIdentifiers }
  identifiersPurgedAt?: null | string
  items?: Ga4Item[] | null
  name: string
  occurredAt: string
  params?: null | Record<string, boolean | number | string>
  revision: number
  shippingCents?: null | number
  subject?: { collectionSlug?: null | string; id?: null | string; recordId?: null | string }
  taxCents?: null | number
  transactionId?: null | string
  updatedAt: string
  userId?: null | string
  userProperties?: null | Record<string, number | string>
  valueCents?: null | number
}

export type DeliveryDoc = {
  attempt: number
  createdAt: string
  deadlineAt?: null | string
  destination: Destination
  event: ConversionEventDoc | number | string
  firstServedAt?: null | string
  id: number | string
  key: string
  lastDispatchedAt?: null | string
  lastServedAt?: null | string
  leaseExpiresAt?: null | string
  nextAttemptAt?: null | string
  reason?: null | string
  request?: unknown
  response?: unknown
  revision: number
  sentAt?: null | string
  sequence: number
  status: DeliveryStatus
  updatedAt: string
}
