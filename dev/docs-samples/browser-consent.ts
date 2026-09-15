import { consentDefaults, trackClient } from 'payload-plugin-attribution/browser'

// Call before gtag.js loads; the consent platform later sends gtag('consent', 'update', ...).
consentDefaults({
  adPersonalization: 'denied',
  adStorage: 'denied',
  adUserData: 'denied',
  analyticsStorage: 'denied',
  region: ['AT', 'BE', 'DE', 'FR', 'GB', 'IE', 'NL'],
  waitForUpdateMs: 500,
})

// Browser-only interactions; conversions are recorded on the server.
export const trackQuoteClick = (productId: string): null | string =>
  trackClient('quote_click', { product_id: productId }, { measurementId: 'G-XXXXXXXXXX' })
