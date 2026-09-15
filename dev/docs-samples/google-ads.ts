import type { GoogleAdsDestinationOptions } from 'payload-plugin-attribution'

const feedCredentials = {
  password: () => process.env.GOOGLE_ADS_FEED_PASSWORD ?? '',
  username: 'google-ads',
}

// Conversions through the Data Manager API, adjustments through the scheduled CSV feed.
export const dataManager: GoogleAdsDestinationOptions = {
  adjustments: { enabled: true },
  conversionActions: { lead: '7000000001', sale: '7000000002' },
  feed: feedCredentials,
  loginAccountId: '1234567890',
  operatingAccountId: '9876543210',
  serviceAccountJson: () => process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON ?? '',
  transport: 'dataManager',
}

// Conversions and adjustments both through scheduled CSV feeds, matched by conversion name.
export const feed: GoogleAdsDestinationOptions = {
  adjustments: { enabled: true },
  conversionActions: { lead: 'Website lead', sale: 'Website sale' },
  feed: { ...feedCredentials, lookbackDays: 30 },
  transport: 'feed',
}
