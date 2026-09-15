import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ConversionEventDoc,
  DeliveryDoc,
  DeliveryLookup,
  NormalizedOptions,
} from '../../../../types/index.js'

import { normalizeOptions } from '../../../../plugin/normalizeOptions.js'
import { SettingUnavailableError } from '../../../utilities/errors.js'
import { ga4Handler } from '../send.js'

const now = new Date('2026-09-14T12:00:00.000Z')

const event = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 1,
  name: 'purchase',
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
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

const delivery = (overrides: Partial<DeliveryDoc> = {}): DeliveryDoc => ({
  id: 1,
  attempt: 1,
  createdAt: now.toISOString(),
  destination: 'ga4',
  event: 1,
  key: 'ga4:1:1',
  revision: 1,
  sequence: 1,
  status: 'sending',
  updatedAt: now.toISOString(),
  ...overrides,
})

const buildOptions = (ga4Overrides: Record<string, unknown> = {}): NormalizedOptions =>
  normalizeOptions({
    destinations: {
      ga4: { apiSecret: 'ga4-secret', measurementId: 'G-TEST', ...ga4Overrides },
    },
    secret: 'plugin-secret',
  })

const lookup: DeliveryLookup = { originalConversion: vi.fn(), retracted: vi.fn() }

const deliver = (args: {
  event?: ConversionEventDoc
  ga4Overrides?: Record<string, unknown>
  signal?: AbortSignal
}) =>
  ga4Handler.deliver({
    delivery: delivery(),
    event: args.event ?? event(),
    lookup,
    now,
    options: buildOptions(args.ga4Overrides),
    payload: {} as never,
    signal: args.signal ?? new AbortController().signal,
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ga4Handler', () => {
  it('sends on a 2xx response, with request set to the built body and no secret in it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})

    expect(outcome.kind).toBe('sent')
    if (outcome.kind === 'sent') {
      expect(outcome.request).toMatchObject({ client_id: expect.any(String) })
      expect(JSON.stringify(outcome.request)).not.toContain('ga4-secret')
      expect(JSON.stringify(outcome.request)).not.toContain('plugin-secret')
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://www.google-analytics.com/mp/collect?measurement_id=G-TEST&api_secret=ga4-secret',
    )
    expect(init.method).toBe('POST')
  })

  it('uses the EU regional endpoint when euEndpoint is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await deliver({ ga4Overrides: { euEndpoint: true } })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url.startsWith('https://region1.google-analytics.com/mp/collect?')).toBe(true)
  })

  it('retries on 429, honoring a Retry-After in seconds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { 'retry-after': '120' }, status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'http_429', retryAfterMs: 120000 })
  })

  it('retries on 500', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toMatchObject({ kind: 'retry', reason: 'http_500' })
  })

  it('retries on 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toMatchObject({ kind: 'retry', reason: 'http_503' })
  })

  it('honors an HTTP-date Retry-After header', async () => {
    const future = new Date(now.getTime() + 30_000).toUTCString()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { 'retry-after': future }, status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome.kind).toBe('retry')
    if (outcome.kind === 'retry') {
      expect(outcome.retryAfterMs).toBeGreaterThan(29_000)
      expect(outcome.retryAfterMs).toBeLessThanOrEqual(30_000)
    }
  })

  it.each([
    ['a negative number', '-5'],
    ['a non-numeric, non-date string', 'abc'],
    ['a past HTTP date', new Date(now.getTime() - 60_000).toUTCString()],
  ])(
    'yields retryAfterMs undefined for an unusable Retry-After header (%s)',
    async (_label, header) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { headers: { 'retry-after': header }, status: 503 }))
      vi.stubGlobal('fetch', fetchMock)

      const outcome = await deliver({})
      expect(outcome).toStrictEqual({ kind: 'retry', reason: 'http_503', retryAfterMs: undefined })
    },
  )

  it('goes dead on other 4xx responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad request' }), {
        headers: { 'content-type': 'application/json' },
        status: 400,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toMatchObject({ kind: 'dead', reason: 'http_400' })
  })

  it('withholds not_configured when ga4 is disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({ ga4Overrides: { enabled: false } })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('withholds consent_denied without a request when analytics storage is denied', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({
      event: event({
        consent: {
          adPersonalization: 'granted',
          adUserData: 'granted',
          analyticsStorage: 'denied',
        },
      }),
      ga4Overrides: { consentPolicy: 'ignore' },
    })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'consent_denied' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('withholds not_configured when a setting resolves to an empty string', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({ ga4Overrides: { apiSecret: () => '' } })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('raises SettingUnavailableError when a setting function throws, so runDelivery retries', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      deliver({
        ga4Overrides: {
          measurementId: () => {
            throw new Error('boom')
          },
        },
      }),
    ).rejects.toBeInstanceOf(SettingUnavailableError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('withholds not_configured when the plugin secret resolves to an empty string', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await ga4Handler.deliver({
      delivery: delivery(),
      event: event(),
      lookup,
      now,
      options: normalizeOptions({
        destinations: { ga4: { apiSecret: 'ga4-secret', measurementId: 'G-TEST' } },
        secret: () => '',
      }),
      payload: {} as never,
      signal: new AbortController().signal,
    })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('goes dead on an invalid payload without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({ event: event({ occurredAt: 'not-a-date' }) })
    expect(outcome).toStrictEqual({ kind: 'dead', reason: 'invalid_payload' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries on a network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'network_error' })
  })

  it('rethrows an AbortError for runDelivery to classify', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    const fetchMock = vi.fn().mockRejectedValue(abortError)
    vi.stubGlobal('fetch', fetchMock)

    await expect(deliver({})).rejects.toBe(abortError)
  })

  it.each([false, true])(
    'posts to endpoints.ga4 instead of Google when configured (euEndpoint %s)',
    async (euEndpoint) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)

      await ga4Handler.deliver({
        delivery: delivery(),
        event: event(),
        lookup,
        now,
        options: normalizeOptions({
          destinations: { ga4: { apiSecret: 'ga4-secret', euEndpoint, measurementId: 'G-TEST' } },
          endpoints: { ga4: 'http://127.0.0.1:3199/' },
          secret: 'plugin-secret',
        }),
        payload: {} as never,
        signal: new AbortController().signal,
      })

      const [url] = fetchMock.mock.calls[0] as [string]
      expect(url).toBe(
        'http://127.0.0.1:3199/mp/collect?measurement_id=G-TEST&api_secret=ga4-secret',
      )
    },
  )
})
