export const PLUGIN_SLUG = 'payload-plugin-attribution'
export const EVENTS_SLUG = 'conversion-events'
export const DELIVERIES_SLUG = 'conversion-deliveries'
export const CLAIMS_SLUG = 'conversion-delivery-claims'
export const DEFAULT_QUEUE = 'attribution'
export const TASK_DELIVER = 'attributionDeliver'
export const TASK_SWEEP = 'attributionSweep'
export const DESTINATIONS = ['ga4', 'googleAds', 'googleAdsAdjustment', 'meta'] as const
export const DELIVERY_STATUSES = [
  'pending',
  'sending',
  'retry',
  'sent',
  'eligible',
  'served',
  'withheld',
  'dead',
  'superseded',
] as const
export const TERMINAL_STATUSES = ['sent', 'withheld', 'dead', 'superseded'] as const
export const LEASE_MS = 120_000
export const CLAIM_BUSY_RETRIES = 5
export const CLAIM_BUSY_DELAY_MS = { max: 50, min: 10 } as const
// MongoDB reports a conflict while the winning transaction is still open, so the retry waits for it to commit.
export const WRITE_CONFLICT_RETRY_DELAY_MS = { max: 250, min: 100 } as const
// Settling a delivery whose provider call already finished must not give up on short contention.
export const FINISH_WRITE_CONFLICT_RETRIES = 8
export const PURCHASE_CLAIM_PREFIX = 'purchase:'
export const COMMIT_MARKER_PREFIX = 'commit:'
export const DEFAULT_IP_HEADER = 'x-forwarded-for'
export const MAX_USER_AGENT_LENGTH = 1024
export const DEFAULT_MAX_ATTEMPTS = 6
export const DEFAULT_DESTINATION_TIMEOUT_MS = 30_000
export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_MAX_MS = 1_800_000
export const BACKOFF_JITTER = 0.2
export const RETRY_AFTER_MAX_MS = 21_600_000
export const MIN_WAIT_MS = 60_000
export const DISPATCH_GRACE_MS = 300_000
export const DEFAULT_SWEEP_LIMIT = 100
export const PURGE_PAGE_SIZE = 100
export const SCAN_BOUND_FACTOR = 50
export const MAX_DESTINATION_TIMEOUT_MS = LEASE_MS / 2
export const PAYLOAD_JOBS_DISPATCHER = 'payload-jobs'
export const DEFAULT_API_BASE = '/attribution'
export const CLIENT_EXPORT = 'payload-plugin-attribution/client'
export const DELIVERY_STATUS_CELL_PATH = `${CLIENT_EXPORT}#DeliveryStatusCell`
export const DELIVERIES_PANEL_PATH = `${CLIENT_EXPORT}#DeliveriesPanel`
export const DELIVERIES_PANEL_LIMIT = 100
export const MAX_TEXT_ID_LENGTH = 64

export const PLUGIN_APPLIED = Symbol.for('payload-plugin-attribution.applied')
export const DEFAULT_ADMIN_GROUP = 'Marketing'
export const DEFAULT_CURRENCY = 'USD'
export const DEFAULT_IDENTIFIER_RETENTION_DAYS = 90
export const DEFAULT_FEED_LOOKBACK_DAYS = 90
export const MAX_FEED_LOOKBACK_DAYS = 90
export const MAX_FEED_CONVERSION_NAME_LENGTH = 100
export const FEED_PAGE_SIZE = 500
export const FEED_REALM = 'attribution'
export const MAX_BASIC_AUTH_HEADER_LENGTH = 4096
export const ADJUSTMENT_OPEN_AFTER_MS = 86_400_000
export const ADJUSTMENT_WINDOW_MS = 54 * 86_400_000
export const ORIGINAL_WAIT_MS = 21_600_000
export const ORIGINAL_WAIT_DEADLINE_MS = 7 * 86_400_000
export const DEFAULT_META_API_VERSION = 'v26.0'
export const DEFAULT_META_TIMEOUT_MS = 5000
export const DEFAULT_META_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  appointment_booked: 'Schedule',
  generate_lead: 'Lead',
  purchase: 'Purchase',
  sign_up: 'CompleteRegistration',
})
export const POSTGRES_IDENTIFIER_LIMIT = 63

export const CONSENT_STATES = ['granted', 'denied', 'unknown'] as const
export const CONSENT_POLICIES = ['ignore', 'require-granted', 'withhold-denied'] as const
export const ATTRIBUTION_SOURCES = ['web', 'staff', 'import', 'phone'] as const
export const EVENT_SOURCES = ['WEB', 'PHONE', 'IN_STORE', 'OTHER'] as const
export const GOOGLE_ADS_ACTIONS = ['lead', 'sale', 'none'] as const
export const GOOGLE_ADS_KINDS = ['conversion', 'restatement', 'retraction', 'none'] as const
export const GOOGLE_ADS_TRANSPORTS = ['dataManager', 'feed'] as const
export const GA4_ADMIN_API_BASE = 'https://analyticsadmin.googleapis.com/v1beta'
export const GA4_KEY_EVENT_COUNTING_METHODS = ['ONCE_PER_EVENT', 'ONCE_PER_SESSION'] as const
export const DEFAULT_GA4_KEY_EVENT_COUNTING_METHOD = 'ONCE_PER_EVENT'
export const GA4_DIMENSION_LIMITS = { EVENT: 50, ITEM: 10, USER: 25 } as const
export const GA4_KEY_EVENT_LIMIT = 30
export const GA4_USER_DIMENSION_NAME_MAX = 24
export const GA4_DIMENSION_NAME_MAX = 40
export const GA4_MP_ORIGIN = 'https://www.google-analytics.com'
export const GA4_MP_EU_ORIGIN = 'https://region1.google-analytics.com'
export const DATA_MANAGER_ORIGIN = 'https://datamanager.googleapis.com'
export const DATA_MANAGER_INGEST_PATH = '/v1/events:ingest'
export const META_GRAPH_ORIGIN = 'https://graph.facebook.com'
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const

export const META_ACTION_SOURCES = [
  'app',
  'business_messaging',
  'chat',
  'email',
  'other',
  'phone_call',
  'physical_store',
  'system_generated',
  'website',
] as const
