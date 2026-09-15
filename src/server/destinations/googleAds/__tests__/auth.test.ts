import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authorizeMock = vi.fn()
const jwtConstructorMock = vi.fn()

class FakeGaxiosError extends Error {}

vi.mock('google-auth-library', () => ({
  gaxios: { GaxiosError: FakeGaxiosError },
  JWT: vi.fn().mockImplementation(function (options: unknown) {
    jwtConstructorMock(options)
    return { authorize: authorizeMock }
  }),
}))

const { dataManagerAccessToken, GoogleAdsAuthNetworkError, GoogleAdsAuthUnavailableError } =
  await import('../auth.js')

const CACHE = Symbol.for('payload-plugin-attribution.googleAdsTokenCache')
const INFLIGHT = Symbol.for('payload-plugin-attribution.googleAdsTokenInflight')

const clearState = (): void => {
  const store = globalThis as { [CACHE]?: Map<string, unknown>; [INFLIGHT]?: Map<string, unknown> }
  store[CACHE]?.clear()
  store[INFLIGHT]?.clear()
}

const serviceAccountJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    client_email: 'svc@example-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
    ...overrides,
  })

describe('dataManagerAccessToken', () => {
  beforeEach(() => {
    clearState()
    authorizeMock.mockReset()
    jwtConstructorMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('requests a token with the Data Manager scope and returns it', async () => {
    authorizeMock.mockResolvedValue({
      access_token: 'token-1',
      expiry_date: Date.now() + 3_600_000,
    })

    const token = await dataManagerAccessToken(serviceAccountJson(), new AbortController().signal)

    expect(token).toBe('token-1')
    expect(jwtConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'svc@example-project.iam.gserviceaccount.com',
        scopes: ['https://www.googleapis.com/auth/datamanager'],
      }),
    )
  })

  it('caches the token per credentials and does not call authorize again', async () => {
    authorizeMock.mockResolvedValue({
      access_token: 'token-1',
      expiry_date: Date.now() + 3_600_000,
    })

    const signal = new AbortController().signal
    const first = await dataManagerAccessToken(serviceAccountJson(), signal)
    const second = await dataManagerAccessToken(serviceAccountJson(), signal)

    expect(first).toBe('token-1')
    expect(second).toBe('token-1')
    expect(authorizeMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes the token once within 60 seconds of expiry', async () => {
    authorizeMock
      .mockResolvedValueOnce({ access_token: 'token-1', expiry_date: Date.now() + 30_000 })
      .mockResolvedValueOnce({ access_token: 'token-2', expiry_date: Date.now() + 3_600_000 })

    const signal = new AbortController().signal
    const first = await dataManagerAccessToken(serviceAccountJson(), signal)
    const second = await dataManagerAccessToken(serviceAccountJson(), signal)

    expect(first).toBe('token-1')
    expect(second).toBe('token-2')
    expect(authorizeMock).toHaveBeenCalledTimes(2)
  })

  it('caches separately per client_email', async () => {
    authorizeMock
      .mockResolvedValueOnce({ access_token: 'token-a', expiry_date: Date.now() + 3_600_000 })
      .mockResolvedValueOnce({ access_token: 'token-b', expiry_date: Date.now() + 3_600_000 })

    const signal = new AbortController().signal
    const a = await dataManagerAccessToken(
      serviceAccountJson({ client_email: 'a@example.com' }),
      signal,
    )
    const b = await dataManagerAccessToken(
      serviceAccountJson({ client_email: 'b@example.com' }),
      signal,
    )

    expect(a).toBe('token-a')
    expect(b).toBe('token-b')
    expect(authorizeMock).toHaveBeenCalledTimes(2)
  })

  it('caches separately per private_key, so a rotated or malformed key is never masked by a cached token', async () => {
    authorizeMock
      .mockResolvedValueOnce({ access_token: 'token-old-key', expiry_date: Date.now() + 3_600_000 })
      .mockResolvedValueOnce({ access_token: 'token-new-key', expiry_date: Date.now() + 3_600_000 })

    const signal = new AbortController().signal
    const withOldKey = await dataManagerAccessToken(
      serviceAccountJson({ private_key: 'old-key' }),
      signal,
    )
    const withNewKey = await dataManagerAccessToken(
      serviceAccountJson({ private_key: 'new-key' }),
      signal,
    )

    expect(withOldKey).toBe('token-old-key')
    expect(withNewKey).toBe('token-new-key')
    expect(authorizeMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache when expiry_date is missing, minting fresh on every call', async () => {
    authorizeMock.mockResolvedValue({ access_token: 'token-no-expiry' })

    const signal = new AbortController().signal
    const first = await dataManagerAccessToken(serviceAccountJson(), signal)
    const second = await dataManagerAccessToken(serviceAccountJson(), signal)

    expect(first).toBe('token-no-expiry')
    expect(second).toBe('token-no-expiry')
    expect(authorizeMock).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent mints for the same credentials into a single authorize() call', async () => {
    let resolveAuthorize: ((value: unknown) => void) | undefined
    authorizeMock.mockReturnValue(
      new Promise((resolve) => {
        resolveAuthorize = resolve
      }),
    )

    const first = dataManagerAccessToken(serviceAccountJson(), new AbortController().signal)
    const second = dataManagerAccessToken(serviceAccountJson(), new AbortController().signal)
    resolveAuthorize?.({ access_token: 'token-shared', expiry_date: Date.now() + 3_600_000 })

    await expect(first).resolves.toBe('token-shared')
    await expect(second).resolves.toBe('token-shared')
    expect(authorizeMock).toHaveBeenCalledTimes(1)
    expect(jwtConstructorMock).toHaveBeenCalledTimes(1)
  })

  it('rejects with a sanitized error, never exposing the private key, on truncated JSON containing a key marker', async () => {
    const truncated =
      '{"client_email":"svc@example.com","private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEv'
    const promise = dataManagerAccessToken(truncated, new AbortController().signal)
    await expect(promise).rejects.toThrow()
    await expect(promise).rejects.not.toThrow(/BEGIN PRIVATE KEY/)
    expect(authorizeMock).not.toHaveBeenCalled()
  })

  it('rejects with a sanitized error when the JSON is missing required fields', async () => {
    await expect(
      dataManagerAccessToken(
        JSON.stringify({ client_email: 'a@example.com' }),
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    expect(authorizeMock).not.toHaveBeenCalled()
  })

  it.each([400, 401, 403])(
    'rejects a %i gaxios-shaped response with a plain sanitized error, never exposing config',
    async (status) => {
      const rejection = Object.assign(new Error('invalid_grant'), {
        config: { data: 'secret', headers: { Authorization: 'Bearer leaked' } },
        response: { data: { error: 'invalid_grant' }, status },
      })
      authorizeMock.mockRejectedValue(rejection)

      const promise = dataManagerAccessToken(serviceAccountJson(), new AbortController().signal)
      await expect(promise).rejects.toThrow()
      await expect(promise).rejects.not.toBeInstanceOf(GoogleAdsAuthNetworkError)
      await expect(promise).rejects.not.toBeInstanceOf(GoogleAdsAuthUnavailableError)
      await expect(promise).rejects.not.toThrow(/leaked|secret/)
    },
  )

  it.each([429, 500, 503])(
    'throws GoogleAdsAuthUnavailableError on a %i gaxios-shaped response, without leaking config',
    async (status) => {
      const rejection = Object.assign(new Error('backend error'), {
        config: { data: 'secret' },
        response: { data: 'unavailable', status },
      })
      authorizeMock.mockRejectedValue(rejection)

      const promise = dataManagerAccessToken(serviceAccountJson(), new AbortController().signal)
      await expect(promise).rejects.toBeInstanceOf(GoogleAdsAuthUnavailableError)
      await expect(promise).rejects.not.toThrow(/secret/)
    },
  )

  it.each([
    [
      'ECONNREFUSED',
      Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED', config: {} }),
    ],
    ['ETIMEDOUT', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', config: {} })],
    ['ENOTFOUND', Object.assign(new Error('not found'), { code: 'ENOTFOUND', config: {} })],
    ['EAI_AGAIN', Object.assign(new Error('dns retry'), { code: 'EAI_AGAIN', config: {} })],
  ])(
    'throws GoogleAdsAuthNetworkError for a gaxios-shaped error with no response (%s)',
    async (_label, rejection) => {
      authorizeMock.mockRejectedValue(rejection)

      await expect(
        dataManagerAccessToken(serviceAccountJson(), new AbortController().signal),
      ).rejects.toBeInstanceOf(GoogleAdsAuthNetworkError)
    },
  )

  it('throws GoogleAdsAuthNetworkError when the error is an instance of GaxiosError, even without an explicit config', async () => {
    authorizeMock.mockRejectedValue(new FakeGaxiosError('socket hang up'))

    await expect(
      dataManagerAccessToken(serviceAccountJson(), new AbortController().signal),
    ).rejects.toBeInstanceOf(GoogleAdsAuthNetworkError)
  })

  it('does not classify a plain non-gaxios error with no response as a network failure', async () => {
    authorizeMock.mockRejectedValue(new Error('connect failed'))

    const promise = dataManagerAccessToken(serviceAccountJson(), new AbortController().signal)
    await expect(promise).rejects.toThrow()
    await expect(promise).rejects.not.toBeInstanceOf(GoogleAdsAuthNetworkError)
    await expect(promise).rejects.not.toBeInstanceOf(GoogleAdsAuthUnavailableError)
  })

  it('classifies a malformed private key (ERR_OSSL_UNSUPPORTED, no response or config) as a rejection, not a retryable network failure', async () => {
    authorizeMock.mockRejectedValue(
      Object.assign(new Error('error:0909006C:PEM routines:get_name:no start line'), {
        code: 'ERR_OSSL_UNSUPPORTED',
      }),
    )

    const promise = dataManagerAccessToken(serviceAccountJson(), new AbortController().signal)
    await expect(promise).rejects.toThrow()
    await expect(promise).rejects.not.toBeInstanceOf(GoogleAdsAuthNetworkError)
    await expect(promise).rejects.not.toBeInstanceOf(GoogleAdsAuthUnavailableError)
  })

  it('classifies a missing access_token in the authorize() result as a rejection, not a retryable network failure', async () => {
    authorizeMock.mockResolvedValue({ expiry_date: Date.now() + 3_600_000 })

    const promise = dataManagerAccessToken(serviceAccountJson(), new AbortController().signal)
    await expect(promise).rejects.toThrow()
    await expect(promise).rejects.not.toBeInstanceOf(GoogleAdsAuthNetworkError)
    await expect(promise).rejects.not.toBeInstanceOf(GoogleAdsAuthUnavailableError)
  })

  it('rejects with the abort reason without wrapping it, when the signal aborts before authorize resolves', async () => {
    let resolveAuthorize: ((value: unknown) => void) | undefined
    authorizeMock.mockReturnValue(
      new Promise((resolve) => {
        resolveAuthorize = resolve
      }),
    )
    const controller = new AbortController()

    const promise = dataManagerAccessToken(serviceAccountJson(), controller.signal)
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    resolveAuthorize?.({ access_token: 'unused', expiry_date: Date.now() + 3_600_000 })
    // Let the still-pending shared mint settle and clean itself up before the next test runs.
    await Promise.resolve()
    await Promise.resolve()
  })
})
