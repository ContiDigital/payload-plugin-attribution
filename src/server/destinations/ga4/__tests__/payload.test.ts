import { describe, expect, it } from 'vitest'

import type { ConversionEventDoc } from '../../../../types/index.js'

import { DEFAULT_CURRENCY } from '../../../../constants.js'
import { buildGa4Body } from '../payload.js'

const HOUR = 3_600_000
const now = new Date('2026-09-13T16:00:00.000Z')
const at = (hours: number) => new Date(now.getTime() - hours * HOUR).toISOString()

type Ga4Event = { name: string; params: Record<string, unknown> }
const eventsOf = (body: Record<string, unknown>): Ga4Event[] => body.events as Ga4Event[]

const event = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 1,
  name: 'purchase',
  attribution: {
    capturedAt: at(10),
    gaClientId: '123.456',
    gaSessionId: String(Date.parse(at(9)) / 1000),
    gaSessionStartedAt: at(9),
    gclid: 'abcdefghij12345',
  },
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: at(8),
  currency: 'USD',
  eventKey: 'purchase:order:1',
  eventSource: 'WEB',
  identifiers: {
    google: {
      city: 'Chicago',
      country: 'US',
      emailSha256: 'e'.repeat(64),
      firstNameSha256: 'f'.repeat(64),
      lastNameSha256: 'l'.repeat(64),
      phoneSha256: 'p'.repeat(64),
      postalCode: '60601',
      region: 'IL',
    },
  },
  items: [{ item_id: 'one', item_name: 'Object', price: 123.45, quantity: 1 }],
  occurredAt: at(8),
  revision: 1,
  shippingCents: 2000,
  taxCents: 1000,
  transactionId: 'order-1',
  updatedAt: at(8),
  valueCents: 12345,
  ...overrides,
})

describe('buildGa4Body', () => {
  it('lowercases the address city and region and sends the hashed street', () => {
    const { body } = buildGa4Body(
      event({
        identifiers: {
          google: { city: 'New York', country: 'US', region: 'NY', streetSha256: 's'.repeat(64) },
        },
      }),
      { now, secret: 'secret', userProvidedData: true },
    )
    expect((body.user_data as { address: unknown[] }).address).toEqual([
      { city: 'new york', country: 'US', region: 'ny', sha256_street: 's'.repeat(64) },
    ])
  })

  it('keeps an hour of margin before the 72 hour timestamp_micros limit', () => {
    expect(
      buildGa4Body(event({ occurredAt: at(71.5) }), { now, secret: 'secret' }).timestampMode,
    ).toBe('now')
    expect(
      buildGa4Body(event({ occurredAt: at(70.5) }), { now, secret: 'secret' }).timestampMode,
    ).toBe('exact')
  })

  it('(a) builds a full purchase body: items, session, granted consent, user-provided data', () => {
    expect(buildGa4Body(event(), { now, secret: 'secret', userProvidedData: true })).toStrictEqual({
      body: {
        client_id: '123.456',
        consent: { ad_personalization: 'GRANTED', ad_user_data: 'GRANTED' },
        events: [
          {
            name: 'purchase',
            params: {
              currency: 'USD',
              engagement_time_msec: 100,
              event_source: 'WEB',
              items: [{ item_id: 'one', item_name: 'Object', price: 123.45, quantity: 1 }],
              session_id: String(Date.parse(at(9)) / 1000),
              shipping: 20,
              tax: 10,
              transaction_id: 'order-1',
              value: 123.45,
            },
          },
        ],
        timestamp_micros: Date.parse(at(8)) * 1000,
        user_data: {
          address: [
            {
              city: 'chicago',
              country: 'US',
              postal_code: '60601',
              region: 'il',
              sha256_first_name: 'f'.repeat(64),
              sha256_last_name: 'l'.repeat(64),
            },
          ],
          sha256_email_address: ['e'.repeat(64)],
          sha256_phone_number: ['p'.repeat(64)],
        },
      },
      sessionAttached: true,
      timestampMode: 'exact',
    })
  })

  it('(b) a 4 day old refund uses sale_date, excludes timestamp_micros', () => {
    const refund = event({
      name: 'refund',
      attribution: undefined,
      items: undefined,
      occurredAt: at(96),
      valueCents: 2345,
    })
    // No gaClientId (attribution undefined): synthetic id from sha256('secret' + transactionId
    // 'order-1'), since userId is unset. No gaSessionId either, so no session_id.
    expect(buildGa4Body(refund, { now, secret: 'secret' })).toStrictEqual({
      body: {
        client_id: '3687929768.1218503887',
        consent: { ad_personalization: 'GRANTED', ad_user_data: 'GRANTED' },
        events: [
          {
            name: 'refund',
            params: {
              currency: 'USD',
              engagement_time_msec: 100,
              event_source: 'WEB',
              sale_date: at(96).slice(0, 10),
              shipping: 20,
              tax: 10,
              transaction_id: 'order-1',
              value: 23.45,
            },
          },
        ],
      },
      sessionAttached: false,
      timestampMode: 'now',
    })
  })

  it.each([
    [
      'only ad_user_data when adPersonalization is unknown',
      { adPersonalization: 'unknown', adUserData: 'denied' },
      { ad_user_data: 'DENIED' },
    ],
    [
      'only ad_personalization when adUserData is unknown',
      { adPersonalization: 'granted', adUserData: 'unknown' },
      { ad_personalization: 'GRANTED' },
    ],
    [
      'both fields when both are known',
      { adPersonalization: 'denied', adUserData: 'granted' },
      { ad_personalization: 'DENIED', ad_user_data: 'GRANTED' },
    ],
    [
      'no consent block when both are unknown',
      { adPersonalization: 'unknown', adUserData: 'unknown' },
      undefined,
    ],
  ] as const)('(c0) sends %s', (_label, states, consent) => {
    const { body } = buildGa4Body(event({ consent: { ...states, analyticsStorage: 'granted' } }), {
      now,
      secret: 'secret',
    })
    expect(body).toStrictEqual({
      client_id: '123.456',
      ...(consent ? { consent } : {}),
      events: [
        {
          name: 'purchase',
          params: {
            currency: 'USD',
            engagement_time_msec: 100,
            event_source: 'WEB',
            items: [{ item_id: 'one', item_name: 'Object', price: 123.45, quantity: 1 }],
            session_id: String(Date.parse(at(9)) / 1000),
            shipping: 20,
            tax: 10,
            transaction_id: 'order-1',
            value: 123.45,
          },
        },
      ],
      timestamp_micros: Date.parse(at(8)) * 1000,
    })
  })

  it('(c) unknown consent omits the consent block; denied consent omits user_data but keeps a known consent block', () => {
    const unknownConsentBody = {
      client_id: '123.456',
      events: [
        {
          name: 'purchase',
          params: {
            currency: 'USD',
            engagement_time_msec: 100,
            event_source: 'WEB',
            items: [{ item_id: 'one', item_name: 'Object', price: 123.45, quantity: 1 }],
            session_id: String(Date.parse(at(9)) / 1000),
            shipping: 20,
            tax: 10,
            transaction_id: 'order-1',
            value: 123.45,
          },
        },
      ],
      timestamp_micros: Date.parse(at(8)) * 1000,
      user_data: {
        address: [
          {
            city: 'chicago',
            country: 'US',
            postal_code: '60601',
            region: 'il',
            sha256_first_name: 'f'.repeat(64),
            sha256_last_name: 'l'.repeat(64),
          },
        ],
        sha256_email_address: ['e'.repeat(64)],
        sha256_phone_number: ['p'.repeat(64)],
      },
    }

    const unknown = event({
      consent: { adPersonalization: 'unknown', adUserData: 'granted', analyticsStorage: 'unknown' },
    })
    // adPersonalization is unknown, so only ad_user_data is sent; adUserData is not 'denied', so
    // user_data is still built from identifiers.google.
    expect(buildGa4Body(unknown, { now, secret: 'secret', userProvidedData: true })).toStrictEqual({
      body: { ...unknownConsentBody, consent: { ad_user_data: 'GRANTED' } },
      sessionAttached: true,
      timestampMode: 'exact',
    })

    const denied = event({
      consent: { adPersonalization: 'denied', adUserData: 'denied', analyticsStorage: 'denied' },
    })
    // 'denied' is a known state (unlike 'unknown'), so the consent block is still sent; but
    // adUserData === 'denied' suppresses user_data entirely.
    const { user_data: _omit, ...deniedConsentBody } = unknownConsentBody
    expect(buildGa4Body(denied, { now, secret: 'secret', userProvidedData: true })).toStrictEqual({
      body: {
        ...deniedConsentBody,
        consent: { ad_personalization: 'DENIED', ad_user_data: 'DENIED' },
      },
      sessionAttached: true,
      timestampMode: 'exact',
    })
  })

  it('(c2) omits user_data entirely without userProvidedData, even with identifiers present', () => {
    const built = buildGa4Body(event(), { now, secret: 'secret' })
    expect(built.body).not.toHaveProperty('user_data')
  })

  it('(d) converts JPY minor units 1:1 with major units, and omits undefined tax/shipping', () => {
    const jpy = event({
      currency: 'JPY',
      shippingCents: undefined,
      taxCents: undefined,
      valueCents: 5000,
    })
    expect(buildGa4Body(jpy, { now, secret: 'secret' })).toStrictEqual({
      body: {
        client_id: '123.456',
        consent: { ad_personalization: 'GRANTED', ad_user_data: 'GRANTED' },
        events: [
          {
            name: 'purchase',
            params: {
              currency: 'JPY',
              engagement_time_msec: 100,
              event_source: 'WEB',
              items: [{ item_id: 'one', item_name: 'Object', price: 123.45, quantity: 1 }],
              session_id: String(Date.parse(at(9)) / 1000),
              transaction_id: 'order-1',
              value: 5000,
            },
          },
        ],
        timestamp_micros: Date.parse(at(8)) * 1000,
      },
      sessionAttached: true,
      timestampMode: 'exact',
    })
  })

  it('(e) reserves mandatory parameters when the host supplies 30 parameters, capped at 25, in order', () => {
    const params = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`p${i}`, 'x'.repeat(120)]),
    )
    const hostParams = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`p${i}`, 'x'.repeat(100)]),
    )
    const built = buildGa4Body(event({ params }), { now, secret: 'secret' })
    expect(built).toStrictEqual({
      body: {
        client_id: '123.456',
        consent: { ad_personalization: 'GRANTED', ad_user_data: 'GRANTED' },
        events: [
          {
            name: 'purchase',
            params: {
              currency: 'USD',
              engagement_time_msec: 100,
              event_source: 'WEB',
              items: [{ item_id: 'one', item_name: 'Object', price: 123.45, quantity: 1 }],
              session_id: String(Date.parse(at(9)) / 1000),
              shipping: 20,
              tax: 10,
              transaction_id: 'order-1',
              value: 123.45,
              ...hostParams,
            },
          },
        ],
        timestamp_micros: Date.parse(at(8)) * 1000,
      },
      sessionAttached: true,
      timestampMode: 'exact',
    })
    // The mandatory params come first, in the documented order, before any host params;
    // only p0 through p15 fit under the 25-param cap (9 mandatory + 16 host = 25).
    expect(Object.keys(eventsOf(built.body)[0]?.params ?? {})).toStrictEqual([
      'transaction_id',
      'currency',
      'value',
      'tax',
      'shipping',
      'items',
      'session_id',
      'engagement_time_msec',
      'event_source',
      ...Array.from({ length: 16 }, (_, i) => `p${i}`),
    ])
  })

  it('defaults params.currency to DEFAULT_CURRENCY when the event has no currency', () => {
    const built = buildGa4Body(event({ currency: undefined }), { now, secret: 'secret' })
    expect(eventsOf(built.body)[0]?.params.currency).toBe(DEFAULT_CURRENCY)
    expect(DEFAULT_CURRENCY).toBe('USD')
  })

  it('omits the address entry when no address fields are present', () => {
    const noAddress = event({ identifiers: { google: { emailSha256: 'e'.repeat(64) } } })
    const built = buildGa4Body(noAddress, { now, secret: 'secret', userProvidedData: true })
    expect(built.body.user_data).toStrictEqual({ sha256_email_address: ['e'.repeat(64)] })
  })

  it('omits empty keys within the address object', () => {
    const partial = event({
      identifiers: { google: { firstNameSha256: 'f'.repeat(64), region: 'IL' } },
    })
    const built = buildGa4Body(partial, { now, secret: 'secret', userProvidedData: true })
    expect(built.body.user_data).toStrictEqual({
      address: [{ region: 'il', sha256_first_name: 'f'.repeat(64) }],
    })
  })

  it('sets debug_mode only when requested', () => {
    const built = buildGa4Body(event(), { debug: true, now, secret: 'secret' })
    expect(eventsOf(built.body)[0]?.params.debug_mode).toBe(true)
  })

  it('throws when the serialized body would exceed 130 kB', () => {
    // Item string values are truncated to 100 chars each, so bulk the body up
    // with many attributes per item rather than one very long string.
    const attrs = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`attr${i}`, 'y'.repeat(100)]),
    )
    const items = Array.from({ length: 200 }, (_, i) => ({
      ...attrs,
      item_id: `item-${i}`,
      item_name: 'Object',
      price: 1,
      quantity: 1,
    }))
    expect(() => buildGa4Body(event({ items }), { now, secret: 'secret' })).toThrow(RangeError)
  })

  it('throws on invalid input: missing secret, bad event name, unparsable time', () => {
    expect(() => buildGa4Body(event(), { now, secret: '' })).toThrow(TypeError)
    expect(() => buildGa4Body(event({ name: '9invalid' }), { now, secret: 'secret' })).toThrow(
      TypeError,
    )
    expect(() =>
      buildGa4Body(event({ occurredAt: 'not-a-date' }), { now, secret: 'secret' }),
    ).toThrow(TypeError)
  })

  it('derives a synthetic client_id, preferring userId over transactionId and eventKey', () => {
    const row = event({ attribution: undefined, userId: 'customer-1' })
    const built = buildGa4Body(row, { now, secret: 'secret' })
    expect(built.body.client_id).toMatch(/^\d+\.\d+$/)
    // userId wins, so changing transactionId does not change the synthetic id.
    const again = buildGa4Body({ ...row, transactionId: 'different' }, { now, secret: 'secret' })
    expect(again.body.client_id).toBe(built.body.client_id)
  })
})
