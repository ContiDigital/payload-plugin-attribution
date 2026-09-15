import { describe, expect, it } from 'vitest'

import type { ConversionDraft } from '../../../types/index.js'

import { validateDraft, validateItems, validStableID } from '../validateDraft.js'

const base: ConversionDraft = {
  name: 'generate_lead',
  eventKey: 'lead:test',
  occurredAt: '2026-09-13T12:00:00.000Z',
}

describe('validateDraft', () => {
  it.each([
    [{ name: 'session_start' }, 'invalid_event_name'],
    [{ name: '_private' }, 'invalid_event_name'],
    [{ eventKey: '' }, 'invalid_event_key'],
    [{ eventKey: 'user@example.com' }, 'invalid_event_key'],
    [{ occurredAt: 'not-a-date' }, 'invalid_time'],
    [{ eventId: '' }, 'invalid_event_id'],
    [{ eventId: 'x'.repeat(129) }, 'invalid_event_id'],
    [{ eventId: 'bad id with spaces' }, 'invalid_event_id'],
    [{ transactionId: 'customer@example.com' }, 'invalid_transaction_id'],
    [{ buyer: [] }, 'invalid_identifiers'],
    [{ buyer: { email: 1 } }, 'invalid_identifiers'],
    [{ buyer: null }, 'invalid_identifiers'],
    [{ eventSource: 'EMAIL' }, 'invalid_event_source'],
    [{ channel: 'user@example.com' }, 'invalid_channel'],
    [{ channel: 1 }, 'invalid_channel'],
    [{ valueCents: -1 }, 'invalid_money'],
    [{ taxCents: 1.5 }, 'invalid_money'],
    [{ shippingCents: Infinity }, 'invalid_money'],
    [{ listPriceCents: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_money'],
    [{ googleAds: { action: 'sale', adjustedValueCents: -1 } }, 'invalid_money'],
    [{ revision: 0 }, 'invalid_revision'],
    [{ revision: 1.5 }, 'invalid_revision'],
    [{ currency: 'usd' }, 'invalid_currency'],
    [{ currency: 'ABC' }, 'invalid_currency'],
    [{ currency: 'XYZ' }, 'invalid_currency'],
    [{ currency: 'US' }, 'invalid_currency'],
    [{ currency: 840 as unknown as string }, 'invalid_currency'],
    [{ items: [{}] }, 'invalid_items'],
    [{ name: 'purchase' }, 'invalid_purchase'],
    [{ name: 'refund' }, 'invalid_refund'],
    [{ googleAds: { action: 'sale', kind: 'bad' } }, 'invalid_ads_kind'],
    [{ googleAds: { action: 'bad', kind: 'conversion' } }, 'invalid_ads_kind'],
    [{ googleAds: { action: 'sale', kind: 'conversion' } }, 'missing_transaction_id'],
    [{ googleAds: { action: 'sale' } }, 'missing_transaction_id'],
    [
      {
        name: 'refund',
        googleAds: { action: 'sale', kind: 'restatement' },
        transactionId: 'order',
      },
      'refund_requires_adjusted_value',
    ],
    [{ params: [] }, 'invalid_params'],
    [{ params: 'bad' }, 'invalid_params'],
    [{ params: { transaction_id: 'overridden' } }, 'reserved_parameter'],
    [{ params: { google_bad: 'value' } }, 'reserved_parameter'],
    [{ params: { amount: NaN } }, 'invalid_parameter_value'],
    [{ params: { note: 'customer@example.com' } }, 'invalid_parameter_value'],
    [{ params: { nested: {} } }, 'invalid_parameter_value'],
    [{ attribution: 'bad' }, 'invalid_attribution'],
    [{ attribution: [] }, 'invalid_attribution'],
    [{ consent: 'bad' }, 'invalid_consent'],
    [{ consent: { badKey: 'granted' } }, 'invalid_consent'],
    [{ consent: { adUserData: 'yes' } }, 'invalid_consent'],
    [{ context: [] }, 'invalid_context'],
    [{ context: { ipAddress: 'bad' } }, 'invalid_ip_address'],
    [{ context: { ipAddress: '999.1.1.1' } }, 'invalid_ip_address'],
    [{ context: { ipAddress: 1 } }, 'invalid_ip_address'],
    [{ context: { url: 'not a url' } }, 'invalid_url'],
    [{ context: { url: 'ftp://example.com' } }, 'invalid_url'],
    [{ context: { userAgent: '' } }, 'invalid_context'],
    [{ context: { userAgent: 'x'.repeat(1025) } }, 'invalid_context'],
    [{ context: { userAgent: 'bad\nagent' } }, 'invalid_context'],
    [{ context: { userAgent: 1 } }, 'invalid_context'],
    [{ destinations: { facebook: true } }, 'invalid_destinations'],
    [{ destinations: { ga4: 'yes' } }, 'invalid_destinations'],
    [{ destinations: [] }, 'invalid_destinations'],
  ])('rejects malformed input %# with a stable reason', (fields, reason) => {
    const result = validateDraft({ ...base, ...fields } as ConversionDraft)
    expect(result).toEqual({ ok: false, reason })
  })

  it('rejects throwing input accessors without leaking error details', () => {
    const result = validateDraft(
      new Proxy(base, {
        get() {
          throw new Error('private')
        },
      }),
    )
    expect(result).toEqual({ ok: false, reason: 'invalid_draft' })
  })

  it('accepts zero money, scalar parameters and null attribution', () => {
    const draft: ConversionDraft = {
      ...base,
      attribution: null,
      params: { accepted: false, count: 2, label: 'lead' },
      valueCents: 0,
    }
    expect(validateDraft(draft)).toEqual({ draft, ok: true })
    expect(validStableID('a'.repeat(64))).toBe(false)
  })

  it('accepts a valid IPv4 context address', () => {
    const draft: ConversionDraft = { ...base, context: { ipAddress: '203.0.113.10' } }
    expect(validateDraft(draft)).toEqual({ draft, ok: true })
  })

  it('accepts a valid IPv6 context address', () => {
    const draft: ConversionDraft = { ...base, context: { ipAddress: '2001:db8::1' } }
    expect(validateDraft(draft)).toEqual({ draft, ok: true })
  })

  it('accepts a valid http(s) context url', () => {
    const draft: ConversionDraft = { ...base, context: { url: 'https://example.com/lp' } }
    expect(validateDraft(draft)).toEqual({ draft, ok: true })
  })

  it.each([
    [
      'https://shop.example.com/thanks?email=jane%40x.com&token=eyJabc#done',
      'https://shop.example.com/thanks',
    ],
    ['https://user:secret@example.com/contact/', 'https://example.com/contact/'],
    ['http://example.com', 'http://example.com/'],
    ['https://example.com/reset-password/some-reset-code', 'https://example.com'],
    ['https://example.com/orders/a1b2c3d4e5f6a7b8c9d0/receipt', 'https://example.com'],
    ['https://example.com/u/jane%40example.com', 'https://example.com'],
  ])('stores context url %s as origin and safe path only', (url, expected) => {
    const result = validateDraft({ ...base, context: { url, userAgent: 'Mozilla/5.0' } })
    expect(result).toEqual({
      draft: { ...base, context: { url: expected, userAgent: 'Mozilla/5.0' } },
      ok: true,
    })
  })

  it('does not rewrite the caller context object when normalizing the url', () => {
    const context = { url: 'https://example.com/lp?gclid=abc' }
    validateDraft({ ...base, context })
    expect(context.url).toBe('https://example.com/lp?gclid=abc')
  })

  it('accepts a valid eventId', () => {
    const draft: ConversionDraft = { ...base, eventId: 'evt:2026-09-13.1' }
    expect(validateDraft(draft)).toEqual({ draft, ok: true })
  })

  it('accepts destinations restricted to known destinations', () => {
    const draft: ConversionDraft = { ...base, destinations: { ga4: true, meta: false } }
    expect(validateDraft(draft)).toEqual({ draft, ok: true })
  })

  it.each(['USD', 'JPY', 'KWD', 'EUR'])('accepts the active ISO 4217 currency %s', (currency) => {
    const draft: ConversionDraft = { ...base, currency }
    expect(validateDraft(draft)).toEqual({ draft, ok: true })
  })

  it('accepts a full valid consent object', () => {
    const draft: ConversionDraft = {
      ...base,
      consent: { adPersonalization: 'denied', adUserData: 'granted', analyticsStorage: 'unknown' },
    }
    expect(validateDraft(draft)).toEqual({ draft, ok: true })
  })

  it('accepts a valid context userAgent', () => {
    const draft: ConversionDraft = { ...base, context: { userAgent: 'Mozilla/5.0 (compatible)' } }
    expect(validateDraft(draft)).toEqual({ draft, ok: true })
  })
})

describe('validateDraft no aliasing / TOCTOU', () => {
  it('returns a draft that is not the same object reference as the input', () => {
    const draft: ConversionDraft = { ...base, buyer: { email: 'buyer@example.com' } }
    const result = validateDraft(draft)
    if (!result.ok) {
      throw new Error('expected draft to validate')
    }
    expect(result.draft).not.toBe(draft)
    expect(result.draft).toEqual(draft)
  })

  it('does not alias any nested plain object or array on the input', () => {
    const draft: ConversionDraft = {
      ...base,
      attribution: { gaClientId: '1.2' },
      buyer: { email: 'buyer@example.com' },
      consent: { adUserData: 'granted' },
      context: { ipAddress: '203.0.113.10' },
      destinations: { ga4: true },
      googleAds: { action: 'lead', kind: 'auto' },
      items: [{ item_name: 'Service' }],
      params: { label: 'x' },
      subject: { id: 1, collectionSlug: 'orders' },
      transactionId: 'order:1',
    }
    const result = validateDraft(draft)
    if (!result.ok) {
      throw new Error('expected draft to validate')
    }
    expect(result.draft.attribution).not.toBe(draft.attribution)
    expect(result.draft.buyer).not.toBe(draft.buyer)
    expect(result.draft.consent).not.toBe(draft.consent)
    expect(result.draft.context).not.toBe(draft.context)
    expect(result.draft.destinations).not.toBe(draft.destinations)
    expect(result.draft.googleAds).not.toBe(draft.googleAds)
    expect(result.draft.items).not.toBe(draft.items)
    expect(result.draft.items?.[0]).not.toBe(draft.items?.[0])
    expect(result.draft.params).not.toBe(draft.params)
    expect(result.draft.subject).not.toBe(draft.subject)
    expect(result.draft).toEqual(draft)
  })

  it('reads a getter-backed field exactly once, never observing a later value', () => {
    let reads = 0
    const draftWithGetter: Record<string, unknown> = {
      name: 'purchase',
      eventKey: 'order:1',
      googleAds: { action: 'sale', kind: 'conversion' },
      items: [{ item_name: 'Service' }],
      occurredAt: '2026-09-13T12:00:00.000Z',
      valueCents: 100,
    }
    Object.defineProperty(draftWithGetter, 'transactionId', {
      enumerable: true,
      get() {
        reads += 1
        return reads === 1 ? 'order-1' : 'bad id with spaces'
      },
    })
    const result = validateDraft(draftWithGetter)
    expect(reads).toBe(1)
    expect(result).toEqual({
      draft: {
        name: 'purchase',
        eventKey: 'order:1',
        googleAds: { action: 'sale', kind: 'conversion' },
        items: [{ item_name: 'Service' }],
        occurredAt: '2026-09-13T12:00:00.000Z',
        transactionId: 'order-1',
        valueCents: 100,
      },
      ok: true,
    })
  })

  it('a getter that is invalid on first read is rejected even if a later read would be valid', () => {
    let reads = 0
    const draftWithGetter: Record<string, unknown> = {
      name: 'generate_lead',
      eventKey: 'order:1',
      occurredAt: '2026-09-13T12:00:00.000Z',
    }
    Object.defineProperty(draftWithGetter, 'eventId', {
      enumerable: true,
      get() {
        reads += 1
        return reads === 1 ? '' : 'evt-1'
      },
    })
    const result = validateDraft(draftWithGetter)
    expect(reads).toBe(1)
    expect(result).toEqual({ ok: false, reason: 'invalid_event_id' })
  })

  it('reads a getter-backed attribution exactly once when it is null on first read', () => {
    let reads = 0
    const draftWithGetter: Record<string, unknown> = {
      name: 'generate_lead',
      eventKey: 'lead:test',
      occurredAt: '2026-09-13T12:00:00.000Z',
    }
    Object.defineProperty(draftWithGetter, 'attribution', {
      enumerable: true,
      get() {
        reads += 1
        return reads === 1 ? null : { gaClientId: '1.2' }
      },
    })
    const result = validateDraft(draftWithGetter)
    expect(reads).toBe(1)
    expect(result).toEqual({
      draft: {
        name: 'generate_lead',
        attribution: null,
        eventKey: 'lead:test',
        occurredAt: '2026-09-13T12:00:00.000Z',
      },
      ok: true,
    })
  })

  it('reads a getter-backed attribution exactly once when it is an object on first read', () => {
    let reads = 0
    const draftWithGetter: Record<string, unknown> = {
      name: 'generate_lead',
      eventKey: 'lead:test',
      occurredAt: '2026-09-13T12:00:00.000Z',
    }
    Object.defineProperty(draftWithGetter, 'attribution', {
      enumerable: true,
      get() {
        reads += 1
        return reads === 1 ? { gaClientId: '1.2' } : null
      },
    })
    const result = validateDraft(draftWithGetter)
    expect(reads).toBe(1)
    expect(result).toEqual({
      draft: {
        name: 'generate_lead',
        attribution: { gaClientId: '1.2' },
        eventKey: 'lead:test',
        occurredAt: '2026-09-13T12:00:00.000Z',
      },
      ok: true,
    })
  })
})

describe('validateItems', () => {
  it.each([
    null,
    {},
    [null],
    [[]],
    [{}],
    [{ item_id: '' }],
    [{ item_name: ' ' }],
    [{ item_id: 'one', price: NaN }],
    [{ item_id: 'one', item_name: 'a@b.com' }],
    [{ bad: true, item_id: 'one' }],
    Array.from({ length: 201 }, () => ({ item_id: 'one' })),
    [
      {
        item_id: 'one',
        ...Object.fromEntries(Array.from({ length: 43 }, (_, index) => [`p${index}`, 1])),
      },
    ],
  ])('rejects invalid item arrays %#', (items) => {
    expect(validateItems(items)).toBe(false)
  })

  it('accepts name-only items', () => {
    expect(validateItems([{ item_name: 'Service' }])).toBe(true)
  })
})
