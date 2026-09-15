export const RESERVED_EVENT_NAMES: ReadonlySet<string> = new Set([
  'ad_activeview',
  'ad_click',
  'ad_exposure',
  'ad_impression',
  'ad_query',
  'ad_reward',
  'adunit_exposure',
  'app_clear_data',
  'app_exception',
  'app_install',
  'app_remove',
  'app_store_refund',
  'app_store_subscription_cancel',
  'app_store_subscription_convert',
  'app_store_subscription_renew',
  'app_update',
  'app_upgrade',
  'dynamic_link_app_open',
  'dynamic_link_app_update',
  'dynamic_link_first_open',
  'error',
  'firebase_campaign',
  'firebase_in_app_message_action',
  'firebase_in_app_message_dismiss',
  'firebase_in_app_message_impression',
  'first_open',
  'first_visit',
  'in_app_purchase',
  'notification_dismiss',
  'notification_foreground',
  'notification_open',
  'notification_receive',
  'os_update',
  'session_start',
  'session_start_with_rollout',
  'user_engagement',
])

export const validName = (value: unknown, max = 40): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  /^[A-Z]\w*$/i.test(value) &&
  !/^(?:firebase_|ga_|google_|gtag\.)/.test(value)

export const validEventName = (value: unknown): value is string =>
  validName(value) && !RESERVED_EVENT_NAMES.has(value)
