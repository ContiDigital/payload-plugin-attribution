import type { Ga4DestinationOptions } from 'payload-plugin-attribution'

export const ga4: Ga4DestinationOptions = {
  apiSecret: () => process.env.GA4_API_SECRET ?? '',
  consentPolicy: 'ignore',
  euEndpoint: false,
  measurementId: 'G-XXXXXXXXXX',
  // Only property setup reads this.
  propertyId: '123456789',
  resendRevisions: false,
  userProvidedData: false,
}
