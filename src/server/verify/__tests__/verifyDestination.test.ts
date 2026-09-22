import type { Payload } from 'payload'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConversionEventDoc, NormalizedOptions } from '../../../types/index.js'

import { PLUGIN_SLUG } from '../../../constants.js'
import { normalizeOptions } from '../../../plugin/normalizeOptions.js'
import { NotFoundError } from '../../utilities/errors.js'

const jwtAuthorize = vi.fn()
vi.mock('google-auth-library', () => ({
  gaxios: { GaxiosError: class FakeGaxiosError extends Error {} },
  JWT: vi.fn().mockImplementation(function () {
    return { authorize: jwtAuthorize }
  }),
}))

const { verifyDestination } = await import('../verifyDestination.js')

const now = new Date('2026-09-14T12:00:00.000Z')

const CACHE = Symbol.for('payload-plugin-attribution.googleAdsTokenCache')
const INFLIGHT = Symbol.for('payload-plugin-attribution.googleAdsTokenInflight')
const clearTokenCache = (): void => {
  const store = globalThis as { [CACHE]?: Map<string, unknown>; [INFLIGHT]?: Map<string, unknown> }
  store[CACHE]?.clear()
  store[INFLIGHT]?.clear()
}

const event = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 1,
  name: 'purchase',
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
  context: { url: 'https://example.invalid/checkout', userAgent: 'Mozilla/5.0' },
  createdAt: now.toISOString(),
  currency: 'USD',
  eventKey: 'purchase:order-1',
  eventSource: 'WEB',
  occurredAt: now.toISOString(),
  revision: 1,
  transactionId: 'order-1',
  updatedAt: now.toISOString(),
  valueCents: 1000,
  ...overrides,
})

const fakePayload = (options: NormalizedOptions, doc: ConversionEventDoc | null): Payload =>
  ({
    config: { custom: { [PLUGIN_SLUG]: { options } } },
    findByID: vi.fn().mockResolvedValue(doc),
  }) as unknown as Payload

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  clearTokenCache()
})

describe('verifyDestination', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    clearTokenCache()
  })

  it('throws NotFoundError when the event does not exist', async () => {
    const options = normalizeOptions({ secret: 'plugin-secret' })
    await expect(
      verifyDestination({ destination: 'ga4', eventId: 99, payload: fakePayload(options, null) }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  describe('ga4', () => {
    const ga4Options = (overrides: Record<string, unknown> = {}): NormalizedOptions =>
      normalizeOptions({
        destinations: { ga4: { apiSecret: 'ga4-secret', measurementId: 'G-TEST', ...overrides } },
        secret: 'plugin-secret',
      })

    it('returns not_configured with no network call when ga4 is disabled', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'ga4',
        eventId: 1,
        payload: fakePayload(ga4Options({ enabled: false }), event()),
      })

      expect(result).toEqual({ details: { reason: 'not_configured' }, ok: false })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('posts to the debug endpoint with ENFORCE_RECOMMENDATIONS and reports ok when clean', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ validationMessages: [] }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'ga4',
        eventId: 1,
        payload: fakePayload(ga4Options(), event()),
      })

      expect(result.ok).toBe(true)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toContain('/debug/mp/collect?')
      // The Measurement Protocol validation server reads validation_behavior from the JSON body,
      // not the query string, so it must never appear in the URL.
      expect(url).not.toContain('validation_behavior')
      const body = JSON.parse(init.body as string) as { validation_behavior?: string }
      expect(body.validation_behavior).toBe('ENFORCE_RECOMMENDATIONS')
    })

    it('withholds consent_denied with no network call when analytics storage is denied', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'ga4',
        eventId: 1,
        payload: fakePayload(
          ga4Options(),
          event({
            consent: {
              adPersonalization: 'granted',
              adUserData: 'granted',
              analyticsStorage: 'denied',
            },
          }),
        ),
      })

      expect(result).toEqual({ details: { reason: 'consent_denied' }, ok: false })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('validates against the EU regional endpoint when euEndpoint is set', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ validationMessages: [] }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
      vi.stubGlobal('fetch', fetchMock)

      await verifyDestination({
        destination: 'ga4',
        eventId: 1,
        payload: fakePayload(ga4Options({ euEndpoint: true }), event()),
      })

      const [url] = fetchMock.mock.calls[0] as [string]
      expect(url.startsWith('https://region1.google-analytics.com/debug/mp/collect?')).toBe(true)
    })

    // Regression: the legacy verify command reported "completed" whenever the HTTP response was
    // 2xx, ignoring validationMessages entirely.
    it('reports ok: false when the debug endpoint returns validation messages', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            validationMessages: [{ description: 'bad param', fieldPath: 'events[0].params.foo' }],
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      )
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'ga4',
        eventId: 1,
        payload: fakePayload(ga4Options(), event()),
      })

      expect(result.ok).toBe(false)
      expect(result.details).toMatchObject({
        validationMessages: [expect.objectContaining({ fieldPath: 'events[0].params.foo' })],
      })
    })

    it('reports a network error without throwing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

      const result = await verifyDestination({
        destination: 'ga4',
        eventId: 1,
        payload: fakePayload(ga4Options(), event()),
      })

      expect(result).toEqual({ details: { reason: 'network_error' }, ok: false })
    })

    it('reports invalid_payload without calling fetch for an unbuildable event', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'ga4',
        eventId: 1,
        payload: fakePayload(ga4Options(), event({ occurredAt: 'not-a-date' })),
      })

      expect(result).toEqual({ details: { reason: 'invalid_payload' }, ok: false })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('googleAds (Data Manager)', () => {
    const adsOptions = (overrides: Record<string, unknown> = {}): NormalizedOptions =>
      normalizeOptions({
        destinations: {
          googleAds: {
            conversionActions: { lead: '111', sale: '222' },
            operatingAccountId: '5551234567',
            serviceAccountJson: () =>
              JSON.stringify({
                client_email: 'svc@example-project.iam.gserviceaccount.com',
                private_key: 'fake-only',
              }),
            transport: 'dataManager',
            ...overrides,
          },
        },
        secret: 'plugin-secret',
      })

    it('returns the eligibility reason with no network call when ineligible', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'googleAds',
        eventId: 1,
        payload: fakePayload(adsOptions(), event({ googleAdsAction: 'sale' })),
      })

      expect(result.ok).toBe(false)
      expect(result.details).toMatchObject({ reason: 'no_identifiers' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(jwtAuthorize).not.toHaveBeenCalled()
    })

    it('sends validateOnly: true and reports ok on a 2xx response', async () => {
      jwtAuthorize.mockResolvedValue({
        access_token: 'token-1',
        expiry_date: Date.now() + 3_600_000,
      })
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'googleAds',
        eventId: 1,
        payload: fakePayload(
          adsOptions(),
          event({
            attribution: { clickCapturedAt: now.toISOString(), gclid: 'click-1', source: 'web' },
            googleAdsAction: 'sale',
          }),
        ),
      })

      expect(result.ok).toBe(true)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://datamanager.googleapis.com/v1/events:ingest')
      const body = JSON.parse(init.body as string) as { validateOnly: boolean }
      expect(body.validateOnly).toBe(true)
    })

    it('reports dead on a 400 without throwing', async () => {
      jwtAuthorize.mockResolvedValue({
        access_token: 'token-1',
        expiry_date: Date.now() + 3_600_000,
      })
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: { message: 'bad request' } }), {
            headers: { 'content-type': 'application/json' },
            status: 400,
          }),
        ),
      )

      const result = await verifyDestination({
        destination: 'googleAds',
        eventId: 1,
        payload: fakePayload(
          adsOptions(),
          event({
            attribution: { clickCapturedAt: now.toISOString(), gclid: 'click-1', source: 'web' },
            googleAdsAction: 'sale',
          }),
        ),
      })

      expect(result.ok).toBe(false)
      expect(result.details).toMatchObject({ reason: 'http_400' })
    })
  })

  describe('googleAds (feed)', () => {
    const feedOptions = (overrides: Record<string, unknown> = {}): NormalizedOptions =>
      normalizeOptions({
        destinations: {
          googleAds: {
            conversionActions: { lead: 'Lead conversion', sale: 'Sale conversion' },
            feed: { password: 'pw', username: 'user' },
            transport: 'feed',
            ...overrides,
          },
        },
        secret: 'plugin-secret',
      })

    it('returns the CSV row that would be served with no network call', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'googleAds',
        eventId: 1,
        payload: fakePayload(
          feedOptions(),
          event({
            attribution: { clickCapturedAt: now.toISOString(), gclid: 'click-1', source: 'web' },
            googleAdsAction: 'sale',
            googleAdsKind: 'conversion',
          }),
        ),
      })

      expect(result.ok).toBe(true)
      expect(result.details).toMatchObject({ row: expect.arrayContaining(['click-1']) })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns not eligible with the feed reason when there is no click id', async () => {
      const result = await verifyDestination({
        destination: 'googleAds',
        eventId: 1,
        payload: fakePayload(feedOptions(), event({ googleAdsAction: 'sale' })),
      })

      expect(result.ok).toBe(false)
      expect(result.details).toMatchObject({ reason: 'no_identifiers' })
    })
  })

  describe('googleAdsAdjustment', () => {
    const adjustmentOptions = (): NormalizedOptions =>
      normalizeOptions({
        destinations: {
          googleAds: {
            adjustments: { enabled: true },
            conversionActions: { lead: 'Lead conversion', sale: 'Sale conversion' },
            feed: { password: 'pw', username: 'user' },
            transport: 'feed',
          },
        },
        secret: 'plugin-secret',
      })

    it('returns not_configured when adjustments are disabled', async () => {
      const options = normalizeOptions({
        destinations: {
          googleAds: {
            conversionActions: { lead: 'Lead conversion', sale: 'Sale conversion' },
            feed: { password: 'pw', username: 'user' },
            transport: 'feed',
          },
        },
        secret: 'plugin-secret',
      })

      const result = await verifyDestination({
        destination: 'googleAdsAdjustment',
        eventId: 1,
        payload: fakePayload(
          options,
          event({ googleAdsAction: 'sale', googleAdsKind: 'restatement' }),
        ),
      })

      expect(result).toEqual({ details: { reason: 'not_configured' }, ok: false })
    })

    it('returns the not_applicable reason for a plain conversion event', async () => {
      const result = await verifyDestination({
        destination: 'googleAdsAdjustment',
        eventId: 1,
        payload: fakePayload(
          adjustmentOptions(),
          event({ googleAdsAction: 'sale', googleAdsKind: 'conversion' }),
        ),
      })

      expect(result.ok).toBe(false)
      expect(result.details).toMatchObject({ reason: 'not_applicable' })
    })

    // The full decision (original-delivered, adjustment window, already-retracted) requires a
    // real DeliveryLookup backed by the events/deliveries collections; covered by integration
    // tests in src/__tests__/verifyDestination.int.test.ts rather than a fake payload here.
  })

  describe('meta', () => {
    const metaOptions = (overrides: Record<string, unknown> = {}): NormalizedOptions =>
      normalizeOptions({
        destinations: {
          meta: { accessToken: 'token', pixelId: 'pixel-1', ...overrides },
        },
        secret: 'plugin-secret',
      })

    const metaEvent = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc =>
      event({ name: 'purchase', identifiers: { meta: { em: 'hashed-email-value' } }, ...overrides })

    it('withholds consent_denied like the handler, even with a test event code', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'meta',
        eventId: 1,
        payload: fakePayload(
          metaOptions({ consentPolicy: 'ignore', testEventCode: 'TEST123' }),
          metaEvent({
            consent: {
              adPersonalization: 'denied',
              adUserData: 'denied',
              analyticsStorage: 'granted',
            },
          }),
        ),
      })

      expect(result).toEqual({ details: { reason: 'consent_denied' }, ok: false })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('requires a test event code before sending, with no network call', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'meta',
        eventId: 1,
        payload: fakePayload(metaOptions(), metaEvent()),
      })

      expect(result).toEqual({ details: { reason: 'test_event_code_required' }, ok: false })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('sends with test_event_code and reports ok on success', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-1' }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'meta',
        eventId: 1,
        payload: fakePayload(metaOptions({ testEventCode: 'TEST123' }), metaEvent()),
      })

      expect(result.ok).toBe(true)
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string) as { test_event_code: string }
      expect(body.test_event_code).toBe('TEST123')
    })

    it('reports the eligibility reason with no network call when ineligible', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'meta',
        eventId: 1,
        payload: fakePayload(
          metaOptions({ testEventCode: 'TEST123' }),
          metaEvent({ occurredAt: '2000-01-01T00:00:00.000Z' }),
        ),
      })

      expect(result.ok).toBe(false)
      expect(result.details).toMatchObject({ reason: 'event_too_old' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reports dead on a 4xx Meta rejection without throwing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: { message: 'Invalid parameter' } }), {
            headers: { 'content-type': 'application/json' },
            status: 400,
          }),
        ),
      )

      const result = await verifyDestination({
        destination: 'meta',
        eventId: 1,
        payload: fakePayload(metaOptions({ testEventCode: 'TEST123' }), metaEvent()),
      })

      expect(result.ok).toBe(false)
      expect(result.details).toMatchObject({ reason: 'http_400' })
    })
  })

  describe('endpoint overrides', () => {
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    const endpoints = {
      dataManager: 'http://127.0.0.1:3199',
      ga4: 'http://127.0.0.1:3199',
      meta: 'http://127.0.0.1:3199',
    }

    it('sends GA4 validation to endpoints.ga4 with validation_behavior in the body', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ validationMessages: [] }))
      vi.stubGlobal('fetch', fetchMock)

      await verifyDestination({
        destination: 'ga4',
        eventId: 1,
        payload: fakePayload(
          normalizeOptions({
            destinations: { ga4: { apiSecret: 'ga4-secret', measurementId: 'G-TEST' } },
            endpoints,
            secret: 'plugin-secret',
          }),
          event(),
        ),
      })

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(
        'http://127.0.0.1:3199/debug/mp/collect?measurement_id=G-TEST&api_secret=ga4-secret',
      )
      expect(JSON.parse(init.body as string)).toMatchObject({
        validation_behavior: 'ENFORCE_RECOMMENDATIONS',
      })
    })

    it('validates Data Manager requests with the host token function at endpoints.dataManager', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}))
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifyDestination({
        destination: 'googleAds',
        eventId: 1,
        payload: fakePayload(
          normalizeOptions({
            destinations: {
              googleAds: {
                accessToken: () => 'host-token',
                conversionActions: { lead: '111', sale: '222' },
                operatingAccountId: '5551234567',
                transport: 'dataManager',
              },
            },
            endpoints,
            secret: 'plugin-secret',
          }),
          event({
            attribution: { clickCapturedAt: now.toISOString(), gclid: 'click-1', source: 'web' },
            googleAdsAction: 'sale',
          }),
        ),
      })

      expect(result.ok).toBe(true)
      expect(jwtAuthorize).not.toHaveBeenCalled()
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('http://127.0.0.1:3199/v1/events:ingest')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer host-token')
    })

    it('sends Meta test events to endpoints.meta', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ events_received: 1 }))
      vi.stubGlobal('fetch', fetchMock)

      await verifyDestination({
        destination: 'meta',
        eventId: 1,
        payload: fakePayload(
          normalizeOptions({
            destinations: {
              meta: { accessToken: 'token', pixelId: '42', testEventCode: 'TEST1' },
            },
            endpoints,
            secret: 'plugin-secret',
          }),
          event({ identifiers: { meta: { em: 'e'.repeat(64) } } }),
        ),
      })

      const [url] = fetchMock.mock.calls[0] as [string]
      expect(url).toBe('http://127.0.0.1:3199/v26.0/42/events')
    })
  })
})
