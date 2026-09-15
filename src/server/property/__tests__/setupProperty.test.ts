import type { Payload } from 'payload'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedOptions } from '../../../types/index.js'

import { PLUGIN_SLUG } from '../../../constants.js'
import { normalizeOptions } from '../../../plugin/normalizeOptions.js'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), request: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(options: unknown) {
      mocks.auth(options)
    }
    getClient() {
      return Promise.resolve({ request: mocks.request })
    }
  },
}))

const { setupGa4Property } = await import('../setupProperty.js')

const serviceAccountJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    client_email: 'svc@example-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
    ...overrides,
  })

const fakePayload = (options: NormalizedOptions): Payload =>
  ({ config: { custom: { [PLUGIN_SLUG]: { options } } } }) as unknown as Payload

const options = (propertyId = '123456789'): NormalizedOptions =>
  normalizeOptions({
    destinations: { ga4: { apiSecret: 'secret', measurementId: 'G-TEST', propertyId } },
    secret: 'plugin-secret',
  })

// Mirrors the real Admin API shape: GaxiosError-like rejection carrying response.status,
// response.data.error.message, and a credential-bearing config that must never leak out.
const adminRejection = (status: number, message: string): Error =>
  Object.assign(new Error(message), {
    config: { headers: { authorization: 'Bearer secret-token-marker' } },
    response: { data: { error: { message } }, status },
  })

const emptyList = (field: string) => ({ [field]: [] })

afterEach(() => {
  vi.clearAllMocks()
})

describe('setupGa4Property', () => {
  beforeEach(() => {
    mocks.request.mockReset()
    mocks.auth.mockReset()
  })

  it('rejects when propertyId is missing or not numeric', async () => {
    await expect(
      setupGa4Property({
        payload: fakePayload(
          normalizeOptions({
            destinations: { ga4: { apiSecret: 'secret', measurementId: 'G-TEST' } },
            secret: 'plugin-secret',
          }),
        ),
        plan: {},
        serviceAccountJson: serviceAccountJson(),
      }),
    ).rejects.toThrow('numeric GA4 propertyId')
  })

  it('rejects malformed service account JSON without echoing its contents', async () => {
    await expect(
      setupGa4Property({
        payload: fakePayload(options()),
        plan: {},
        serviceAccountJson: 'private-key-marker',
      }),
    ).rejects.toThrow('invalid service account JSON')
  })

  it('uses the read-only scope and only issues GET requests by default', async () => {
    mocks.request.mockResolvedValue({ data: {} })

    const result = await setupGa4Property({
      payload: fakePayload(options()),
      plan: { keyEvents: ['purchase'] },
      serviceAccountJson: serviceAccountJson(),
    })

    expect(result.apply).toBe(false)
    expect(result.missingKeyEvents).toEqual([
      { countingMethod: 'ONCE_PER_EVENT', eventName: 'purchase' },
    ])
    expect(mocks.auth.mock.calls[0]?.[0].scopes).toEqual([
      'https://www.googleapis.com/auth/analytics.readonly',
    ])
    expect(
      mocks.request.mock.calls.every(
        ([request]) => (request as { method: string }).method === 'GET',
      ),
    ).toBe(true)
  })

  it('uses the edit scope when apply is true', async () => {
    mocks.request.mockResolvedValue({ data: {} })

    await setupGa4Property({
      apply: true,
      payload: fakePayload(options()),
      plan: {},
      serviceAccountJson: serviceAccountJson(),
    })

    expect(mocks.auth.mock.calls[0]?.[0].scopes).toEqual([
      'https://www.googleapis.com/auth/analytics.edit',
    ])
  })

  it('creates missing key events with countingMethod so apply succeeds against a fake Admin API that rejects bodies without it', async () => {
    mocks.request.mockImplementation((request: { data?: Record<string, unknown>; url: string }) => {
      if (request.url.includes('customDimensions')) {
        return Promise.resolve({ data: emptyList('customDimensions') })
      }
      if (request.url.includes('keyEvents') && request.data) {
        if (!request.data.countingMethod) {
          return Promise.reject(adminRejection(400, 'countingMethod is required'))
        }
        return Promise.resolve({ data: {} })
      }
      return Promise.resolve({ data: emptyList('keyEvents') })
    })

    const result = await setupGa4Property({
      apply: true,
      payload: fakePayload(options()),
      plan: { keyEvents: ['purchase'] },
      serviceAccountJson: serviceAccountJson(),
    })

    expect(result.missingKeyEvents).toEqual([
      { countingMethod: 'ONCE_PER_EVENT', eventName: 'purchase' },
    ])
    const keyEventWrites = mocks.request.mock.calls
      .map(([request]) => request as { data?: Record<string, unknown>; url: string })
      .filter((request) => request.url.includes('keyEvents') && request.data)
    expect(keyEventWrites).toHaveLength(1)
    expect(keyEventWrites[0]?.data).toEqual({
      countingMethod: 'ONCE_PER_EVENT',
      eventName: 'purchase',
    })
  })

  it('honors an explicit ONCE_PER_SESSION counting method', async () => {
    mocks.request.mockImplementation((request: { data?: Record<string, unknown>; url: string }) => {
      if (request.url.includes('customDimensions')) {
        return Promise.resolve({ data: emptyList('customDimensions') })
      }
      if (request.data) {
        return Promise.resolve({ data: {} })
      }
      return Promise.resolve({ data: emptyList('keyEvents') })
    })

    await setupGa4Property({
      apply: true,
      payload: fakePayload(options()),
      plan: { keyEvents: [{ countingMethod: 'ONCE_PER_SESSION', eventName: 'sign_up' }] },
      serviceAccountJson: serviceAccountJson(),
    })

    const keyEventWrite = mocks.request.mock.calls
      .map(([request]) => request as { data?: Record<string, unknown>; url: string })
      .find((request) => request.data && 'eventName' in request.data)
    expect(keyEventWrite?.data).toEqual({
      countingMethod: 'ONCE_PER_SESSION',
      eventName: 'sign_up',
    })
  })

  it('creates only missing dimensions when applied, leaving existing ones alone', async () => {
    mocks.request.mockImplementation((request: { data?: Record<string, unknown>; url: string }) => {
      if (request.url.includes('customDimensions') && !request.data) {
        return Promise.resolve({
          data: { customDimensions: [{ parameterName: 'sales_channel', scope: 'EVENT' }] },
        })
      }
      if (request.url.includes('keyEvents') && !request.data) {
        return Promise.resolve({ data: emptyList('keyEvents') })
      }
      return Promise.resolve({ data: {} })
    })

    await setupGa4Property({
      apply: true,
      payload: fakePayload(options()),
      plan: { eventDimensions: ['sales_channel', 'payment_stage'] },
      serviceAccountJson: serviceAccountJson(),
    })

    const writes = mocks.request.mock.calls
      .map(([request]) => request as { data?: Record<string, unknown>; url: string })
      .filter((request) => Boolean(request.data))
    expect(writes).toHaveLength(1)
    expect(writes[0]?.data).toMatchObject({ parameterName: 'payment_stage', scope: 'EVENT' })
  })

  it('surfaces the Admin API status and Google error message, never request config or credentials', async () => {
    mocks.request.mockRejectedValue(adminRejection(403, 'The caller does not have permission'))

    const error = await setupGa4Property({
      payload: fakePayload(options()),
      plan: {},
      serviceAccountJson: serviceAccountJson(),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    const message = String((error as Error).message)
    expect(message).toContain('403')
    expect(message).toContain('The caller does not have permission')
    expect(message).not.toContain('secret-token-marker')
    expect(error).not.toHaveProperty('config')
    expect(error).not.toHaveProperty('response')
  })

  it('surfaces a status-only message when the Admin API gives no Google error message', async () => {
    mocks.request.mockRejectedValue(
      Object.assign(new Error('network reset'), {
        config: { headers: { authorization: 'Bearer secret-token-marker' } },
      }),
    )

    await expect(
      setupGa4Property({
        payload: fakePayload(options()),
        plan: {},
        serviceAccountJson: serviceAccountJson(),
      }),
    ).rejects.toThrow('GA4 Admin API request failed')
  })

  it('rejects an invalid dimension name before any Admin API request', async () => {
    await expect(
      setupGa4Property({
        payload: fakePayload(options()),
        plan: { eventDimensions: ['bad name with spaces'] },
        serviceAccountJson: serviceAccountJson(),
      }),
    ).rejects.toThrow(TypeError)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('rejects an invalid key event name before any Admin API request', async () => {
    await expect(
      setupGa4Property({
        payload: fakePayload(options()),
        plan: { keyEvents: ['bad name with spaces'] },
        serviceAccountJson: serviceAccountJson(),
      }),
    ).rejects.toThrow(TypeError)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('rejects when the plan alone requests more event dimensions than GA4 allows, before any request', async () => {
    const names = Array.from({ length: 51 }, (_, i) => `dimension_${i}`)

    await expect(
      setupGa4Property({
        payload: fakePayload(options()),
        plan: { eventDimensions: names },
        serviceAccountJson: serviceAccountJson(),
      }),
    ).rejects.toThrow(RangeError)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('rejects when the event dimension limit would be exceeded once existing dimensions are counted', async () => {
    mocks.request.mockImplementation((request: { data?: Record<string, unknown>; url: string }) => {
      if (request.url.includes('keyEvents')) {
        return Promise.resolve({ data: emptyList('keyEvents') })
      }
      // 49 already exist; the plan's 2 new names push the EVENT scope over the 50 limit, which
      // is only knowable after listing what already exists.
      const existing = Array.from({ length: 49 }, (_, i) => ({
        parameterName: `existing_${i}`,
        scope: 'EVENT',
      }))
      return Promise.resolve({ data: { customDimensions: existing } })
    })

    await expect(
      setupGa4Property({
        payload: fakePayload(options()),
        plan: { eventDimensions: ['new_one', 'new_two'] },
        serviceAccountJson: serviceAccountJson(),
      }),
    ).rejects.toThrow(RangeError)
    expect(mocks.request).toHaveBeenCalled()
  })

  it('identifies the specific key event when its create fails during apply', async () => {
    mocks.request.mockImplementation((request: { data?: Record<string, unknown>; url: string }) => {
      if (request.data) {
        return Promise.reject(adminRejection(400, 'quota exceeded'))
      }
      return Promise.resolve({
        data: request.url.includes('keyEvents')
          ? emptyList('keyEvents')
          : emptyList('customDimensions'),
      })
    })

    const error = await setupGa4Property({
      apply: true,
      payload: fakePayload(options()),
      plan: { keyEvents: ['purchase'] },
      serviceAccountJson: serviceAccountJson(),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    const message = String((error as Error).message)
    expect(message).toContain('creating key event "purchase" failed (400): quota exceeded')
    expect(message).not.toContain('secret-token-marker')
    expect(error).not.toHaveProperty('config')
    expect(error).not.toHaveProperty('response')
  })

  it('identifies the specific dimension when its create fails during apply', async () => {
    mocks.request.mockImplementation((request: { data?: Record<string, unknown>; url: string }) => {
      if (request.data) {
        return Promise.reject(adminRejection(400, 'quota exceeded'))
      }
      return Promise.resolve({
        data: request.url.includes('keyEvents')
          ? emptyList('keyEvents')
          : emptyList('customDimensions'),
      })
    })

    const error = await setupGa4Property({
      apply: true,
      payload: fakePayload(options()),
      plan: { eventDimensions: ['payment_stage'] },
      serviceAccountJson: serviceAccountJson(),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    const message = String((error as Error).message)
    expect(message).toContain('creating dimension "payment_stage" failed (400): quota exceeded')
    expect(message).not.toContain('secret-token-marker')
  })

  it('guards against a repeated pagination token', async () => {
    mocks.request.mockImplementation((request: { url: string }) => {
      if (request.url.includes('customDimensions')) {
        return Promise.resolve({ data: { customDimensions: [], nextPageToken: 'same-token' } })
      }
      return Promise.resolve({ data: emptyList('keyEvents') })
    })

    await expect(
      setupGa4Property({
        payload: fakePayload(options()),
        plan: {},
        serviceAccountJson: serviceAccountJson(),
      }),
    ).rejects.toThrow('repeated')
  })

  it('merges paginated dimension pages before computing what is missing', async () => {
    let call = 0
    mocks.request.mockImplementation((request: { url: string }) => {
      if (request.url.includes('customDimensions')) {
        call += 1
        if (call === 1) {
          return Promise.resolve({
            data: {
              customDimensions: [{ parameterName: 'sales_channel', scope: 'EVENT' }],
              nextPageToken: 'page-2',
            },
          })
        }
        return Promise.resolve({
          data: { customDimensions: [{ parameterName: 'payment_stage', scope: 'EVENT' }] },
        })
      }
      return Promise.resolve({ data: emptyList('keyEvents') })
    })

    const result = await setupGa4Property({
      payload: fakePayload(options()),
      plan: { eventDimensions: ['sales_channel', 'payment_stage', 'new_dimension'] },
      serviceAccountJson: serviceAccountJson(),
    })

    expect(result.missingDimensions).toEqual([
      { displayName: 'new dimension', parameterName: 'new_dimension', scope: 'EVENT' },
    ])
  })

  it('includes the manual steps checklist', async () => {
    mocks.request.mockResolvedValue({ data: {} })

    const result = await setupGa4Property({
      payload: fakePayload(options()),
      plan: {},
      serviceAccountJson: serviceAccountJson(),
    })

    expect(result.manualSteps.length).toBeGreaterThan(0)
  })

  describe('with a host access token', () => {
    const mockOptions = (): NormalizedOptions =>
      normalizeOptions({
        destinations: {
          ga4: { apiSecret: 'secret', measurementId: 'G-TEST', propertyId: '123456789' },
        },
        endpoints: { ga4Admin: 'http://127.0.0.1:3199/v1beta' },
        secret: 'plugin-secret',
      })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('lists through fetch at endpoints.ga4Admin with the bearer token and never uses GoogleAuth', async () => {
      const fetchMock = vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url.includes('customDimensions')
                ? { customDimensions: [{ parameterName: 'sales_channel', scope: 'EVENT' }] }
                : { keyEvents: [] },
            ),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          ),
        ),
      )
      vi.stubGlobal('fetch', fetchMock)

      const result = await setupGa4Property({
        accessToken: () => 'host-token',
        payload: fakePayload(mockOptions()),
        plan: { eventDimensions: ['sales_channel', 'lead_source'], keyEvents: ['generate_lead'] },
      })

      expect(mocks.auth).not.toHaveBeenCalled()
      expect(result.missingDimensions).toEqual([
        { displayName: 'lead source', parameterName: 'lead_source', scope: 'EVENT' },
      ])
      expect(result.missingKeyEvents).toEqual([
        { countingMethod: 'ONCE_PER_EVENT', eventName: 'generate_lead' },
      ])
      const urls = fetchMock.mock.calls.map(([url]) => url)
      expect(urls.sort()).toEqual([
        'http://127.0.0.1:3199/v1beta/properties/123456789/customDimensions?pageSize=200',
        'http://127.0.0.1:3199/v1beta/properties/123456789/keyEvents?pageSize=200',
      ])
      for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
        expect(call[1].method).toBe('GET')
        expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer host-token')
      }
    })

    it('surfaces the Admin API status and message from a fetch rejection without the token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify({ error: { message: 'Caller lacks permission' } }), {
              headers: { 'content-type': 'application/json' },
              status: 403,
            }),
          ),
        ),
      )

      const failure = setupGa4Property({
        accessToken: () => 'secret-token-marker',
        payload: fakePayload(mockOptions()),
        plan: {},
      })

      await expect(failure).rejects.toThrow(
        'GA4 Admin API request failed (403): Caller lacks permission',
      )
      await expect(failure).rejects.not.toThrow('secret-token-marker')
    })

    it('requires either a service account or a token function', async () => {
      await expect(
        setupGa4Property({ payload: fakePayload(mockOptions()), plan: {} }),
      ).rejects.toThrow('requires serviceAccountJson or accessToken')
    })
  })
})
