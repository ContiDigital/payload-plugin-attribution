import { describe, expect, it } from 'vitest'

import { getDestinationHandler } from '../registry.js'

describe('destination handler registry', () => {
  it('registers the GA4 handler by default', () => {
    const handler = getDestinationHandler('ga4')
    expect(handler).toBeDefined()
    expect(handler?.destination).toBe('ga4')
  })

  it('registers the Google Ads handler by default', () => {
    const handler = getDestinationHandler('googleAds')
    expect(handler).toBeDefined()
    expect(handler?.destination).toBe('googleAds')
  })

  it('registers the Google Ads adjustment handler by default', () => {
    const handler = getDestinationHandler('googleAdsAdjustment')
    expect(handler).toBeDefined()
    expect(handler?.destination).toBe('googleAdsAdjustment')
  })

  it('registers the Meta handler by default', () => {
    const handler = getDestinationHandler('meta')
    expect(handler).toBeDefined()
    expect(handler?.destination).toBe('meta')
  })
})
