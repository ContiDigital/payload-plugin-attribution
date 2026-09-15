import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ConversionEventDoc,
  DeliveryDoc,
  DeliveryLookup,
  NormalizedOptions,
} from '../../../../types/index.js'

import { normalizeOptions } from '../../../../plugin/normalizeOptions.js'
import { metaHandler } from '../send.js'

const now = new Date('2026-09-14T12:00:00.000Z')

const event = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 1,
  name: 'purchase',
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: now.toISOString(),
  currency: 'USD',
  eventKey: 'purchase:order-1',
  eventSource: 'PHONE',
  identifiers: { meta: { ph: 'p'.repeat(64) } },
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
  destination: 'meta',
  event: 1,
  key: 'meta:1:1',
  revision: 1,
  sequence: 1,
  status: 'sending',
  updatedAt: now.toISOString(),
  ...overrides,
})

const lookup: DeliveryLookup = { originalConversion: vi.fn(), retracted: vi.fn() }

const buildOptions = (metaOverrides: Record<string, unknown> = {}): NormalizedOptions =>
  normalizeOptions({
    destinations: {
      meta: {
        accessToken: 'access-token-1',
        events: { purchase: 'Purchase' },
        pixelId: '123456789',
        ...metaOverrides,
      },
    },
    secret: 'plugin-secret',
  })

const deliver = (args: {
  event?: ConversionEventDoc
  metaOverrides?: Record<string, unknown>
  signal?: AbortSignal
}) =>
  metaHandler.deliver({
    delivery: delivery(),
    event: args.event ?? event(),
    lookup,
    now,
    options: buildOptions(args.metaOverrides),
    payload: {} as never,
    signal: args.signal ?? new AbortController().signal,
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('metaHandler', () => {
  it('sends on a 2xx response with events_received >= 1, carrying eventsReceived and fbtraceId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-1', messages: [] }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const outcome = await deliver({ signal: controller.signal })

    const expectedBody = {
      data: [
        {
          action_source: 'phone_call',
          custom_data: { currency: 'USD', order_id: 'order-1', value: 10 },
          event_id: 'purchase:order-1',
          event_name: 'Purchase',
          event_time: Math.floor(now.getTime() / 1000),
          user_data: { ph: 'p'.repeat(64) },
        },
      ],
    }
    expect(outcome).toStrictEqual({
      kind: 'sent',
      request: expectedBody,
      response: { eventsReceived: 1, fbtraceId: 'trace-1' },
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://graph.facebook.com/v26.0/123456789/events')
    expect(JSON.parse(init.body as string)).toStrictEqual(expectedBody)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer access-token-1')
    expect(init.signal).toBe(controller.signal)
  })

  it.each([
    ['a pixelId containing a slash', 'pixel/../1', 'pixel%2F..%2F1'],
    ['a pixelId containing a space', 'pixel 1', 'pixel%201'],
  ])('encodes %s in the request path', async (_label, pixelId, encoded) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events_received: 1 }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await deliver({ metaOverrides: { pixelId: () => pixelId } })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://graph.facebook.com/v26.0/${encoded}/events`)
  })

  it('goes dead with invalid_response on a 2xx reporting events_received 0', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events_received: 0, fbtrace_id: 'trace-0' }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(await deliver({})).toStrictEqual({
      kind: 'dead',
      reason: 'invalid_response',
      response: { events_received: 0, fbtrace_id: 'trace-0' },
    })
  })

  it('retries with meta_transient on a transient error (is_transient true, code 2) on a 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 2, is_transient: true, message: 'Service unavailable' } }),
        {
          headers: { 'content-type': 'application/json' },
          status: 400,
        },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(await deliver({})).toStrictEqual({
      kind: 'retry',
      reason: 'meta_transient',
      response: { error: { code: 2, is_transient: true, message: 'Service unavailable' } },
      retryAfterMs: undefined,
    })
  })

  it('retries with meta_transient on a retryable error code without is_transient on a 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 613, message: 'Calls limit' } }), {
        headers: { 'content-type': 'application/json' },
        status: 400,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(await deliver({})).toStrictEqual({
      kind: 'retry',
      reason: 'meta_transient',
      response: { error: { code: 613, message: 'Calls limit' } },
      retryAfterMs: undefined,
    })
  })

  it('keeps http_503 as the reason when a 5xx also carries is_transient', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 2, is_transient: true } }), {
        headers: { 'content-type': 'application/json' },
        status: 503,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(await deliver({})).toStrictEqual({
      kind: 'retry',
      reason: 'http_503',
      response: { error: { code: 2, is_transient: true } },
      retryAfterMs: undefined,
    })
  })

  it('goes dead with auth_error on error code 190 (expired token)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { type: 'OAuthException', code: 190, message: 'Invalid OAuth access token' },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 401,
        },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({
      kind: 'dead',
      reason: 'auth_error',
      response: {
        error: { type: 'OAuthException', code: 190, message: 'Invalid OAuth access token' },
      },
    })
  })

  it('goes dead with invalid_request on error code 100 (not a retry or auth code)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 100, fbtrace_id: 'trace-2', message: 'Invalid parameter' },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 400,
        },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({
      kind: 'dead',
      reason: 'invalid_request',
      response: { fbtraceId: 'trace-2', message: 'Invalid parameter' },
    })
  })

  it('retries on a bare HTTP 500 with no parseable error body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'http_500', retryAfterMs: undefined })
  })

  it('retries on 429, propagating Retry-After', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { 'retry-after': '30' }, status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'http_429', retryAfterMs: 30_000 })
  })

  it('retries on a network failure during the POST', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({})
    expect(outcome).toStrictEqual({ kind: 'retry', reason: 'network_error' })
  })

  it('withholds not_configured when meta is disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({ metaOverrides: { enabled: false } })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('withholds not_configured when pixelId resolves to an empty string', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({ metaOverrides: { pixelId: () => '' } })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('withholds consent_denied and makes no fetch call, even though the destination consent policy already gates planning', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({
      event: event({
        consent: {
          adPersonalization: 'granted',
          adUserData: 'denied',
          analyticsStorage: 'granted',
        },
      }),
    })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'consent_denied' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('withholds event_not_mapped when the event name is no longer in the meta mapping', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({ event: event({ name: 'unmapped_event' }) })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'event_not_mapped' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('withholds the eligibility reason and makes no fetch call when ineligible', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await deliver({ event: event({ identifiers: undefined }) })
    expect(outcome).toStrictEqual({ kind: 'withheld', reason: 'no_user_data' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rethrows an AbortError from the fetch call for runDelivery to classify', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    const fetchMock = vi.fn().mockRejectedValue(abortError)
    vi.stubGlobal('fetch', fetchMock)

    await expect(deliver({})).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('sends the test_event_code when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events_received: 1 }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await deliver({ metaOverrides: { testEventCode: 'TEST999' } })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string).test_event_code).toBe('TEST999')
  })

  it('posts to endpoints.meta instead of the Graph API when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events_received: 1 }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await metaHandler.deliver({
      delivery: delivery(),
      event: event(),
      lookup,
      now,
      options: normalizeOptions({
        destinations: {
          meta: { accessToken: 'access-token-1', events: { purchase: 'Purchase' }, pixelId: '123' },
        },
        endpoints: { meta: 'http://localhost:3199/graph' },
        secret: 'plugin-secret',
      }),
      payload: {} as never,
      signal: new AbortController().signal,
    })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('http://localhost:3199/graph/v26.0/123/events')
  })
})
