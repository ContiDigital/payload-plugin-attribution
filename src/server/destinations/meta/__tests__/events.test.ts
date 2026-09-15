import { describe, expect, it } from 'vitest'

import type { ConversionEventDoc, MetaEventMapping } from '../../../../types/index.js'

import { metaEligibility, resolveMetaEvent } from '../events.js'

const now = new Date('2026-09-14T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString()

const event = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 1,
  name: 'purchase',
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: now.toISOString(),
  eventKey: 'purchase:order-1',
  eventSource: 'WEB',
  occurredAt: now.toISOString(),
  revision: 1,
  transactionId: 'order-1',
  updatedAt: now.toISOString(),
  ...overrides,
})

describe('resolveMetaEvent', () => {
  const mapping: Record<string, MetaEventMapping> = {
    generate_lead: 'Lead',
    in_store_visit: { name: 'Contact', actionSource: 'physical_store' },
    purchase: 'Purchase',
  }

  it('returns null when the event name has no mapping entry', () => {
    expect(resolveMetaEvent(event({ name: 'unmapped_event' }), mapping)).toBeNull()
  })

  it('resolves a string mapping entry and defaults actionSource from eventSource (WEB -> website)', () => {
    expect(
      resolveMetaEvent(event({ name: 'purchase', eventSource: 'WEB' }), mapping),
    ).toStrictEqual({
      name: 'Purchase',
      actionSource: 'website',
    })
  })

  it('defaults actionSource from eventSource PHONE -> phone_call', () => {
    expect(
      resolveMetaEvent(event({ name: 'purchase', eventSource: 'PHONE' }), mapping),
    ).toStrictEqual({
      name: 'Purchase',
      actionSource: 'phone_call',
    })
  })

  it('defaults actionSource from eventSource IN_STORE -> physical_store', () => {
    expect(
      resolveMetaEvent(event({ name: 'purchase', eventSource: 'IN_STORE' }), mapping),
    ).toStrictEqual({
      name: 'Purchase',
      actionSource: 'physical_store',
    })
  })

  it('defaults actionSource from eventSource OTHER -> system_generated', () => {
    expect(
      resolveMetaEvent(event({ name: 'purchase', eventSource: 'OTHER' }), mapping),
    ).toStrictEqual({
      name: 'Purchase',
      actionSource: 'system_generated',
    })
  })

  it('uses the mapping entry actionSource override over the eventSource default', () => {
    expect(
      resolveMetaEvent(event({ name: 'in_store_visit', eventSource: 'WEB' }), mapping),
    ).toStrictEqual({ name: 'Contact', actionSource: 'physical_store' })
  })
})

describe('metaEligibility', () => {
  it('is eligible for a physical store event 30 days old with sufficient user data', () => {
    const result = metaEligibility(
      event({
        identifiers: { meta: { ph: 'p'.repeat(64) } },
        occurredAt: at(30),
      }),
      { actionSource: 'physical_store' },
      now,
    )
    expect(result).toStrictEqual({ eligible: true })
  })

  it('withholds event_too_old for a website event 8 days old', () => {
    const result = metaEligibility(
      event({
        context: { url: 'https://example.com/checkout', userAgent: 'Mozilla/5.0' },
        identifiers: { meta: { em: 'e'.repeat(64) } },
        occurredAt: at(8),
      }),
      { actionSource: 'website' },
      now,
    )
    expect(result).toStrictEqual({ eligible: false, reason: 'event_too_old' })
  })

  it('is eligible for a website event exactly 7 days old', () => {
    const result = metaEligibility(
      event({
        context: { url: 'https://example.com/checkout', userAgent: 'Mozilla/5.0' },
        identifiers: { meta: { em: 'e'.repeat(64) } },
        occurredAt: at(7),
      }),
      { actionSource: 'website' },
      now,
    )
    expect(result).toStrictEqual({ eligible: true })
  })

  it('withholds missing_web_context for a website event without a user agent', () => {
    const result = metaEligibility(
      event({
        context: { url: 'https://example.com/checkout' },
        identifiers: { meta: { em: 'e'.repeat(64) } },
        occurredAt: now.toISOString(),
      }),
      { actionSource: 'website' },
      now,
    )
    expect(result).toStrictEqual({ eligible: false, reason: 'missing_web_context' })
  })

  it('withholds missing_web_context for a website event without a url', () => {
    const result = metaEligibility(
      event({
        context: { userAgent: 'Mozilla/5.0' },
        identifiers: { meta: { em: 'e'.repeat(64) } },
        occurredAt: now.toISOString(),
      }),
      { actionSource: 'website' },
      now,
    )
    expect(result).toStrictEqual({ eligible: false, reason: 'missing_web_context' })
  })

  it('withholds no_user_data when nothing identifies the customer', () => {
    const result = metaEligibility(
      event({
        context: { url: 'https://example.com/checkout', userAgent: 'Mozilla/5.0' },
        occurredAt: now.toISOString(),
      }),
      { actionSource: 'website' },
      now,
    )
    expect(result).toStrictEqual({ eligible: false, reason: 'no_user_data' })
  })

  it('is eligible on fbp alone', () => {
    const result = metaEligibility(
      event({
        attribution: { fbp: 'fb.1.1111111111.222' },
        context: { url: 'https://example.com/checkout', userAgent: 'Mozilla/5.0' },
        occurredAt: now.toISOString(),
      }),
      { actionSource: 'website' },
      now,
    )
    expect(result).toStrictEqual({ eligible: true })
  })

  it('is eligible on client_ip_address plus client_user_agent alone (phone_call, no email/phone hash)', () => {
    const result = metaEligibility(
      event({
        context: { ipAddress: '203.0.113.4', userAgent: 'Mozilla/5.0' },
        occurredAt: now.toISOString(),
      }),
      { actionSource: 'phone_call' },
      now,
    )
    expect(result).toStrictEqual({ eligible: true })
  })

  it('tolerates up to 5 minutes of clock skew (occurredAt after now)', () => {
    const occurredAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString()
    const result = metaEligibility(
      event({ identifiers: { meta: { em: 'e'.repeat(64) } }, occurredAt }),
      { actionSource: 'system_generated' },
      now,
    )
    expect(result).toStrictEqual({ eligible: true })
  })
})
