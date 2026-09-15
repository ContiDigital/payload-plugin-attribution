import type { AttributionPluginOptions } from 'payload-plugin-attribution'

import { authorize } from './authorize.js'
import { ga4 } from './ga4-options.js'
import { dataManager } from './google-ads.js'
import { meta } from './meta.js'

export const attributionOptions: AttributionPluginOptions = {
  adminGroup: 'Marketing',
  apiBasePath: '/attribution',
  authorize,
  destinations: { ga4, googleAds: dataManager, meta },
  // Keeps the collections in the schema with no endpoints, tasks or deliveries.
  disabled: process.env.ATTRIBUTION_DISABLED === 'true',
  identity: {
    defaultPhoneCountry: 'US',
    resolve: async ({ customerId, payload, req }) => {
      const customer = await payload.findByID({
        id: customerId,
        collection: 'customers',
        depth: 0,
        disableErrors: true,
        req,
      })
      if (!customer) {
        return null
      }
      return {
        email: typeof customer.email === 'string' ? customer.email : null,
        marketingConsent: customer.marketingOptIn === true,
        userId: String(customer.id),
      }
    },
  },
  maxAttempts: 6,
  policy: { formLeadValueCents: 2500, leadValuePercent: 5 },
  privacy: { identifierRetentionDays: 90 },
  queue: 'attribution',
  // Function settings resolve at first use, so builds and migrations run without secrets.
  secret: () => process.env.ATTRIBUTION_SECRET ?? '',
  sweep: { cron: '*/10 * * * *' },
}
