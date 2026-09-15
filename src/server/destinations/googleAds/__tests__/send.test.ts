import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authorizeMock = vi.fn()

vi.mock('google-auth-library', () => ({
  gaxios: { GaxiosError: class FakeGaxiosError extends Error {} },
  JWT: vi.fn().mockImplementation(function () {
    return { authorize: authorizeMock }
  }),
}))

const { normalizeOptions } = await import('../../../../plugin/normalizeOptions.js')
const { googleAdsHandler } = await import('../send.js')

const CACHE = Symbol.for('payload-plugin-attribution.googleAdsTokenCache')
const INFLIGHT = Symbol.for('payload-plugin-attribution.googleAdsTokenInflight')
const clearTokenCache = (): void => {
  const store = globalThis as { [CACHE]?: Map<string, unknown>; [INFLIGHT]?: Map<string, unknown> }
  store[CACHE]?.clear()
  store[INFLIGHT]?.clear()
}

import type {
  ConversionEventDoc,
  DeliveryDoc,
  DeliveryLookup,
  NormalizedOptions,
} from '../../../../types/index.js'

const now = new Date('2026-09-14T12:00:00.000Z')

const serviceAccountJson = JSON.stringify({
  client_email: 'svc@example-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
})

const event = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 1,
  name: 'purchase',
  attribution: { clickCapturedAt: now.toISOString(), gclid: 'gclid-1' },
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: now.toISOString(),
  currency: 'USD',
  eventKey: 'purchase:order-1',
  eventSource: 'WEB',
  googleAdsAction: 'sale',
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
  destination: 'googleAds',
  event: 1,
  key: 'googleAds:1:1',
  revision: 1,
  sequence: 1,
  status: 'sending',
  updatedAt: now.toISOString(),
  ...overrides,
})

const lookup: DeliveryLookup = { originalConversion: vi.fn(), retracted: vi.fn() }

const buildOptions = (googleAdsOverrides: Record<string, unknown> = {}): NormalizedOptions =>
  normalizeOptions({
    destinations: {
      googleAds: {
        conversionActions: { lead: '111', sale: '555' },
        operatingAccountId: '1234567890',
        serviceAccountJson,
        transport: 'dataManager',
        ...googleAdsOverrides,
      },
    },
    secret: 'plugin-secret',
  })

const deliver = (args: {
  event?: ConversionEventDoc
  googleAdsOverrides?: Record<string, unknown>
  signal?: AbortSignal
}) =>
  googleAdsHandler.deliver({
    delivery: delivery(),
    event: args.event ?? event(),
    lookup,
    now,
    options: buildOptions(args.googleAdsOverrides),
    payload: {} as never,
    signal: args.signal ?? new AbortController().signal,
  })

beforeEach(() => {
  clearTokenCache()
  authorizeMock.mockReset()
  authorizeMock.mockResolvedValue({
    access_token: 'access-token-1',
    expiry_date: Date.now() + 3_600_000,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('googleAdsHandler (dataManager transport)', () => {
  it('sends on a 2xx response, posting exactly the built request on the provided signal, carrying the requestId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ requestId: 'req-1' }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const outcome = await deliver({ signal: controller.signal })

    expect(outcome.kind).toBe('sent')
    if (outcome.kind === 'sent') {
      expect(outcome.response).toStrictEqual({ requestId: 'req-1' })
      expect(outcome.request).toMatchObject({ encoding: 'HEX' })
    }
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://datamanager.googleapis.com/v1/events:ingest')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer access-token-1')
    expect(init.signal).toBe(controller.signal)
    expect(JSON.parse(init.body as string)).toStrictEqual(
      outcome.kind === 'sent' ? outcome.request : undefined,
    )
  })

  it('goes dead with invalid_argument and Google error.message on 400, never including the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid conversion action' } }), {
        headers: { 'content-type': 'application/json' },
        status: 400,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({
      kind: 'dead',
      reason: 'invalid_argument',
      response: 'Invalid conversion action',
    })
  })

  it('goes dead with permission_denied on 403', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'dead', reason: 'permission_denied' })
  })

  it('goes dead with permission_denied on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'dead', reason: 'permission_denied' })
  })

  it('retries on 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'http_503', retryAfterMs: undefined })
  })

  it('retries on 429', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'http_429', retryAfterMs: undefined })
  })

  it('retries on 429, propagating a Retry-After of 120 seconds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { 'retry-after': '120' }, status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'http_429', retryAfterMs: 120_000 })
  })

  it('retries on 503, propagating a Retry-After of 120 seconds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { 'retry-after': '120' }, status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'http_503', retryAfterMs: 120_000 })
  })

  it('retries on a network failure during the POST', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'network_error' })
  })

  it('withholds not_configured when googleAds is disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({ googleAdsOverrides: { enabled: false } })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('withholds not_configured when operatingAccountId resolves to an empty string', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({ googleAdsOverrides: { operatingAccountId: () => '' } })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('goes dead with auth_error when the service account JSON is invalid', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({ googleAdsOverrides: { serviceAccountJson: 'not-json' } })
    expect(outcome).toStrictEqual({ kind: 'dead', reason: 'auth_error' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries with auth_network_error when token acquisition fails with no response (connection failure)', async () => {
    authorizeMock.mockRejectedValue(
      Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED', config: {} }),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'auth_network_error' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([429, 500, 503])(
    'retries with auth_unavailable when token acquisition fails with a %i gaxios-shaped response, never leaking config',
    async (status) => {
      authorizeMock.mockRejectedValue(
        Object.assign(new Error('backend error'), {
          config: { data: 'secret' },
          response: { data: 'unavailable', status },
        }),
      )
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const outcome = await deliver({})
      expect(outcome).toStrictEqual({ kind: 'retry', reason: 'auth_unavailable' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(JSON.stringify(outcome)).not.toMatch(/secret/)
    },
  )

  it.each([400, 401, 403])(
    'goes dead with auth_error when token acquisition fails with a %i gaxios-shaped response (for example invalid_grant), never leaking config',
    async (status) => {
      authorizeMock.mockRejectedValue(
        Object.assign(new Error('invalid_grant'), {
          config: { data: 'secret', headers: { Authorization: 'Bearer leaked-token' } },
          response: { data: { error: 'invalid_grant' }, status },
        }),
      )
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const outcome = await deliver({})
      expect(outcome).toStrictEqual({ kind: 'dead', reason: 'auth_error' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(JSON.stringify(outcome)).not.toMatch(/secret|leaked-token/)
    },
  )

  it('rethrows an AbortError from token acquisition for runDelivery to classify', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    authorizeMock.mockRejectedValue(abortError)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(deliver({})).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('goes dead with invalid_payload when googleAdsAction is none', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({ event: event({ googleAdsAction: 'none' }) })
    expect(outcome).toStrictEqual({ kind: 'dead', reason: 'invalid_payload' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  describe('eligibility pre-check', () => {
    it('withholds no_identifiers and makes no token or fetch call', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const outcome = await deliver({ event: event({ attribution: undefined }) })
      expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'no_identifiers' })
      expect(authorizeMock).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('withholds click_window_closed and makes no token or fetch call', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const clickCapturedAt = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000).toISOString()

      const outcome = await deliver({
        event: event({ attribution: { clickCapturedAt, gclid: 'gclid-1' } }),
      })
      expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'click_window_closed' })
      expect(authorizeMock).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('withholds user_data_window_closed and makes no token or fetch call', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const occurredAt = new Date(now.getTime() - 64 * 24 * 60 * 60 * 1000).toISOString()

      const outcome = await deliver({
        event: event({
          attribution: undefined,
          identifiers: { google: { phoneSha256: 'p'.repeat(64) } },
          occurredAt,
        }),
      })
      expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'user_data_window_closed' })
      expect(authorizeMock).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('withholds consent_denied and makes no token or fetch call', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const outcome = await deliver({
        event: event({
          attribution: undefined,
          consent: {
            adPersonalization: 'granted',
            adUserData: 'denied',
            analyticsStorage: 'granted',
          },
          identifiers: { google: { emailSha256: 'e'.repeat(64) } },
        }),
      })
      expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'consent_denied' })
      expect(authorizeMock).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('sends with userData omitted when ad user data consent is denied but a valid click id exists', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ requestId: 'req-1' }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const outcome = await deliver({
        event: event({
          consent: {
            adPersonalization: 'granted',
            adUserData: 'denied',
            analyticsStorage: 'granted',
          },
          identifiers: { google: { emailSha256: 'e'.repeat(64) } },
        }),
      })

      expect(outcome.kind).toBe('sent')
      if (outcome.kind === 'sent') {
        const built = outcome.request as { events?: Record<string, unknown>[] }
        expect(built.events?.[0]?.userData).toBeUndefined()
        expect(built.events?.[0]?.adIdentifiers).toStrictEqual({ gclid: 'gclid-1' })
      }
    })
  })
})

describe('googleAdsHandler (feed transport)', () => {
  const feedOptions = (overrides: Record<string, unknown> = {}) => ({
    conversionActions: { lead: 'lead-name', sale: 'sale-name' },
    feed: { password: 'pw', username: 'user' },
    transport: 'feed' as const,
    ...overrides,
  })

  it('is eligible with a gclid in the click window', async () => {
    const outcome = await googleAdsHandler.deliver({
      delivery: delivery(),
      event: event(),
      lookup,
      now,
      options: normalizeOptions({
        destinations: { googleAds: feedOptions() },
        secret: 'plugin-secret',
      }),
      payload: {} as never,
      signal: new AbortController().signal,
    })
    expect(outcome).toStrictEqual({ kind: 'eligible' })
  })

  it('withholds feed_requires_click_id for a user-data-only event', async () => {
    const outcome = await googleAdsHandler.deliver({
      delivery: delivery(),
      event: event({
        attribution: undefined,
        identifiers: { google: { emailSha256: 'e'.repeat(64) } },
      }),
      lookup,
      now,
      options: normalizeOptions({
        destinations: { googleAds: feedOptions() },
        secret: 'plugin-secret',
      }),
      payload: {} as never,
      signal: new AbortController().signal,
    })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'feed_requires_click_id' })
  })

  it('withholds feed_requires_click_id for a gbraid-only event when allowBraidsInFeed is not set', async () => {
    const outcome = await googleAdsHandler.deliver({
      delivery: delivery(),
      event: event({ attribution: { clickCapturedAt: now.toISOString(), gbraid: 'gbraid-1' } }),
      lookup,
      now,
      options: normalizeOptions({
        destinations: { googleAds: feedOptions() },
        secret: 'plugin-secret',
      }),
      payload: {} as never,
      signal: new AbortController().signal,
    })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'feed_requires_click_id' })
  })

  it('is eligible for a gbraid-only event when allowBraidsInFeed is set', async () => {
    const outcome = await googleAdsHandler.deliver({
      delivery: delivery(),
      event: event({ attribution: { clickCapturedAt: now.toISOString(), gbraid: 'gbraid-1' } }),
      lookup,
      now,
      options: normalizeOptions({
        destinations: { googleAds: feedOptions({ allowBraidsInFeed: true }) },
        secret: 'plugin-secret',
      }),
      payload: {} as never,
      signal: new AbortController().signal,
    })
    expect(outcome).toStrictEqual({ kind: 'eligible' })
  })

  it('withholds click_window_closed for a 91 day old click id with no user data', async () => {
    const clickCapturedAt = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000).toISOString()
    const outcome = await googleAdsHandler.deliver({
      delivery: delivery(),
      event: event({ attribution: { clickCapturedAt, gclid: 'gclid-1' } }),
      lookup,
      now,
      options: normalizeOptions({
        destinations: { googleAds: feedOptions() },
        secret: 'plugin-secret',
      }),
      payload: {} as never,
      signal: new AbortController().signal,
    })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'click_window_closed' })
  })
})

describe('googleAdsHandler with a host access token and endpoint', () => {
  const deliverWith = (accessToken: () => Promise<string> | string) =>
    googleAdsHandler.deliver({
      delivery: delivery(),
      event: event(),
      lookup,
      now,
      options: normalizeOptions({
        destinations: {
          googleAds: {
            accessToken,
            conversionActions: { lead: '111', sale: '555' },
            operatingAccountId: '1234567890',
            transport: 'dataManager',
          },
        },
        endpoints: { dataManager: 'http://127.0.0.1:3199' },
        secret: 'plugin-secret',
      }),
      payload: {} as never,
      signal: new AbortController().signal,
    })

  it('uses the token function without a service account and posts to endpoints.dataManager', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ requestId: 'r-1' }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliverWith(() => Promise.resolve('host-token'))

    expect(outcome.kind).toBe('sent')
    expect(authorizeMock).not.toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:3199/v1/events:ingest')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer host-token')
  })

  it('retries auth_unavailable when the token function throws, without posting', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliverWith(() => {
      throw new Error('token source down')
    })

    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'auth_unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('goes dead with auth_error when the token function returns an empty token', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliverWith(() => '')

    expect(outcome).toStrictEqual({ kind: 'dead', reason: 'auth_error' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
