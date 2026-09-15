import { describe, expect, it } from 'vitest'

import type { ConversionEventDoc } from '../../../../types/index.js'

import { sha256 } from '../../../../core/identifiers/normalize.js'
import { buildMetaBody } from '../payload.js'

const now = new Date('2026-09-14T12:00:00.000Z')

const event = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 1,
  name: 'generate_lead',
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: now.toISOString(),
  eventKey: 'generate_lead:lead-1',
  eventSource: 'WEB',
  occurredAt: now.toISOString(),
  revision: 1,
  updatedAt: now.toISOString(),
  ...overrides,
})

describe('buildMetaBody', () => {
  it('builds a web lead with fbclid only: fbc is constructed from fbclid and capturedAt', () => {
    const captured = '2026-09-01T00:00:00.000Z'
    const body = buildMetaBody(
      event({
        attribution: { capturedAt: captured, fbclid: 'sample-fbclid-1' },
        context: { url: 'https://example.com/contact', userAgent: 'Mozilla/5.0 Test' },
        eventKey: 'generate_lead:lead-1',
        occurredAt: now.toISOString(),
      }),
      { name: 'Lead', actionSource: 'website' },
      {},
    )

    expect(body).toStrictEqual({
      data: [
        {
          action_source: 'website',
          event_id: 'generate_lead:lead-1',
          event_name: 'Lead',
          event_source_url: 'https://example.com/contact',
          event_time: Math.floor(Date.parse(now.toISOString()) / 1000),
          user_data: {
            client_user_agent: 'Mozilla/5.0 Test',
            fbc: `fb.1.${Date.parse(captured)}.sample-fbclid-1`,
          },
        },
      ],
    })
  })

  it('sends event_source_url without query, fragment or a token-shaped path', () => {
    const url = (value: string): unknown =>
      (
        buildMetaBody(
          event({ context: { url: value } }),
          { name: 'Lead', actionSource: 'website' },
          {},
        ).data as Record<string, unknown>[]
      )[0].event_source_url
    expect(url('https://shop.example.com/thanks?email=jane%40x.com&token=eyJabc#top')).toBe(
      'https://shop.example.com/thanks',
    )
    expect(url('https://example.com/verify-email/some-code')).toBe('https://example.com')
  })

  it('builds a phone purchase with items and Limited Data Use', () => {
    const body = buildMetaBody(
      event({
        name: 'purchase',
        eventId: 'evt-123',
        eventSource: 'PHONE',
        identifiers: {
          meta: { country: sha256('us'), external_id: sha256('customer-9'), ph: 'p'.repeat(64) },
        },
        items: [
          { item_id: 'sku-1', price: 99.99, quantity: 2 },
          { item_id: 'sku-2', price: 49.99, quantity: 1 },
        ],
        transactionId: 'order-99',
        valueCents: 250_000,
      }),
      { name: 'Purchase', actionSource: 'phone_call' },
      { limitedDataUse: true },
    )

    expect(body).toStrictEqual({
      data: [
        {
          action_source: 'phone_call',
          custom_data: {
            contents: [
              { id: 'sku-1', item_price: 99.99, quantity: 2 },
              { id: 'sku-2', item_price: 49.99, quantity: 1 },
            ],
            currency: 'USD',
            order_id: 'order-99',
            value: 2500,
          },
          data_processing_options: ['LDU'],
          data_processing_options_country: 0,
          data_processing_options_state: 0,
          event_id: 'evt-123',
          event_name: 'Purchase',
          event_time: Math.floor(Date.parse(now.toISOString()) / 1000),
          user_data: {
            country: sha256('us'),
            external_id: sha256('customer-9'),
            ph: 'p'.repeat(64),
          },
        },
      ],
    })
  })

  it('includes test_event_code at the top level when provided', () => {
    const body = buildMetaBody(
      event({ identifiers: { meta: { em: 'e'.repeat(64) } } }),
      { name: 'Lead', actionSource: 'website' },
      { testEventCode: 'TEST12345' },
    )
    expect(body.test_event_code).toBe('TEST12345')
  })

  it('omits data_processing_options when limitedDataUse is false', () => {
    const body = buildMetaBody(
      event({ identifiers: { meta: { em: 'e'.repeat(64) } } }),
      { name: 'Lead', actionSource: 'website' },
      { limitedDataUse: false },
    )
    const data = (body.data as Record<string, unknown>[])[0]
    expect(data.data_processing_options).toBeUndefined()
  })

  it('passes through an explicit attribution.fbc rather than constructing one from fbclid', () => {
    const body = buildMetaBody(
      event({
        attribution: {
          capturedAt: '2026-09-01T00:00:00.000Z',
          fbc: 'fb.1.999.explicit',
          fbclid: 'ignored',
        },
      }),
      { name: 'Lead', actionSource: 'system_generated' },
      {},
    )
    const data = (body.data as Record<string, unknown>[])[0]
    expect((data.user_data as Record<string, unknown>).fbc).toBe('fb.1.999.explicit')
  })

  it('falls back to sha256(userId) for external_id when identifiers.meta.external_id is absent', () => {
    const body = buildMetaBody(
      event({ userId: 'user-42' }),
      { name: 'Lead', actionSource: 'system_generated' },
      {},
    )
    const data = (body.data as Record<string, unknown>[])[0]
    expect((data.user_data as Record<string, unknown>).external_id).toBe(sha256('user-42'))
  })

  it('falls back to eventKey for event_id when eventId is absent', () => {
    const body = buildMetaBody(
      event({
        eventId: undefined,
        eventKey: 'generate_lead:lead-fallback',
        identifiers: { meta: { em: 'e'.repeat(64) } },
      }),
      { name: 'Lead', actionSource: 'website' },
      {},
    )
    const data = (body.data as Record<string, unknown>[])[0]
    expect(data.event_id).toBe('generate_lead:lead-fallback')
  })

  it('omits custom_data entirely when there is no value, transactionId or items', () => {
    const body = buildMetaBody(
      event({ identifiers: { meta: { em: 'e'.repeat(64) } } }),
      { name: 'Lead', actionSource: 'website' },
      {},
    )
    const data = (body.data as Record<string, unknown>[])[0]
    expect(data.custom_data).toBeUndefined()
  })

  it('omits event_source_url when there is no context url', () => {
    const body = buildMetaBody(
      event({ identifiers: { meta: { em: 'e'.repeat(64) } } }),
      { name: 'Purchase', actionSource: 'phone_call' },
      {},
    )
    const data = (body.data as Record<string, unknown>[])[0]
    expect(data.event_source_url).toBeUndefined()
  })
})
