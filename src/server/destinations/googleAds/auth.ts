import { gaxios, JWT } from 'google-auth-library'
import { createHash } from 'node:crypto'

import { isAbortError } from '../../utilities/errors.js'

const DATA_MANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager'
const EXPIRY_SAFETY_MS = 60_000

type CacheEntry = { accessToken: string; expiresAt: number }

// Kept on globalThis so a second module instance (bundler duplication, dev reloads) shares state.
const CACHE = Symbol.for('payload-plugin-attribution.googleAdsTokenCache')
const INFLIGHT = Symbol.for('payload-plugin-attribution.googleAdsTokenInflight')

const cache = (): Map<string, CacheEntry> => {
  const store = globalThis as { [CACHE]?: Map<string, CacheEntry> }
  store[CACHE] ??= new Map()
  return store[CACHE]
}

// One mint in flight per key: concurrent callers for the same credentials share the single
// underlying authorize() call instead of each minting (and each counting against quota).
const inflight = (): Map<string, Promise<string>> => {
  const store = globalThis as { [INFLIGHT]?: Map<string, Promise<string>> }
  store[INFLIGHT] ??= new Map()
  return store[INFLIGHT]
}

type ServiceAccountCredentials = { client_email: string; private_key: string }

function parseServiceAccountJson(json: string): ServiceAccountCredentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new TypeError('payload-plugin-attribution: invalid Google Ads service account JSON')
  }
  const record = parsed as { client_email?: unknown; private_key?: unknown } | null
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.client_email !== 'string' ||
    typeof record.private_key !== 'string'
  ) {
    throw new TypeError(
      'payload-plugin-attribution: Google Ads service account JSON requires client_email and private_key',
    )
  }
  return { client_email: record.client_email, private_key: record.private_key }
}

// Hashed so a rotated or malformed key never reuses a cache entry minted under the same
// client_email with a different (possibly now-invalid) private key.
function cacheKey(credentials: ServiceAccountCredentials): string {
  return createHash('sha256')
    .update(credentials.client_email)
    .update(credentials.private_key)
    .digest('hex')
}

/** A gaxios-style HTTP token-endpoint rejection (429 or 5xx): the token service is unavailable, retry later. */
export class GoogleAdsAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A connection-level failure reaching the token endpoint (no HTTP response at all): retry later. */
export class GoogleAdsAuthNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

// gaxios (google-auth-library's HTTP client) always attaches `config` to the errors it throws,
// and `response` only when the token endpoint actually answered. A malformed private key
// (JWT signing throws ERR_OSSL_UNSUPPORTED) or a locally-raised "no access token" error carries
// neither, and must not be mistaken for a retryable network failure or it would retry forever.
function isGaxiosShaped(error: unknown): boolean {
  if (error instanceof gaxios.GaxiosError) {
    return true
  }
  if (!error || typeof error !== 'object' || !('config' in error)) {
    return false
  }
  const config = (error as { config?: unknown }).config
  return typeof config === 'object' && config !== null
}

// None of these classifications ever read `.config` or the response body, which can carry the
// private key or a token.
function classifyAuthFailure(error: unknown): 'network' | 'rejected' | 'unavailable' {
  const response =
    error && typeof error === 'object' && 'response' in error
      ? (error as { response?: unknown }).response
      : undefined
  if (response && typeof response === 'object') {
    const status = (response as { status?: unknown }).status
    if (typeof status === 'number' && (status === 429 || status >= 500)) {
      return 'unavailable'
    }
    return 'rejected'
  }
  return isGaxiosShaped(error) ? 'network' : 'rejected'
}

// google-auth-library's JWT.authorize() takes no AbortSignal; race it against the signal so a
// cancelled delivery does not hang waiting on a token that is no longer needed. Each caller races
// independently: aborting one caller's delivery never cancels the shared in-flight mint for others.
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function mintToken(credentials: ServiceAccountCredentials, key: string): Promise<string> {
  const pending = inflight()
  const existing = pending.get(key)
  if (existing) {
    return existing
  }

  const promise = (async (): Promise<string> => {
    const client = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: [DATA_MANAGER_SCOPE],
    })
    const result = await client.authorize()
    if (!result.access_token) {
      throw new Error(
        'payload-plugin-attribution: Google Ads authentication returned no access token',
      )
    }
    // A cache entry with no known expiry can never be safely reused; mint fresh every time instead.
    if (typeof result.expiry_date === 'number') {
      cache().set(key, { accessToken: result.access_token, expiresAt: result.expiry_date })
    }
    return result.access_token
  })()

  pending.set(key, promise)
  // Both branches swallow the outcome (cleanup only): the caller's own await/withAbort is what
  // surfaces success or failure, so this derived promise must never itself go unhandled.
  promise.then(
    () => pending.delete(key),
    () => pending.delete(key),
  )
  return promise
}

/** Resolves the host token function: a throw is treated as a temporary outage, an empty token as rejected credentials. */
export async function hostAccessToken(
  accessToken: () => Promise<string> | string,
  signal: AbortSignal,
): Promise<string> {
  let token: unknown
  try {
    token = await withAbort(Promise.resolve().then(accessToken), signal)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new GoogleAdsAuthUnavailableError(
      'payload-plugin-attribution: Google Ads access token function failed',
    )
  }
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error(
      'payload-plugin-attribution: Google Ads access token function returned no token',
    )
  }
  return token
}

export async function dataManagerAccessToken(
  serviceAccountJson: string,
  signal: AbortSignal,
): Promise<string> {
  const credentials = parseServiceAccountJson(serviceAccountJson)
  const key = cacheKey(credentials)
  const store = cache()
  const now = Date.now()
  const cached = store.get(key)
  if (cached && cached.expiresAt - EXPIRY_SAFETY_MS > now) {
    return cached.accessToken
  }

  try {
    return await withAbort(mintToken(credentials, key), signal)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    // Never propagate the raw error: gaxios errors retain credential-bearing request config
    // (and possibly the response body), so only a fixed, data-free message ever leaves here.
    switch (classifyAuthFailure(error)) {
      case 'network': {
        throw new GoogleAdsAuthNetworkError(
          'payload-plugin-attribution: Google Ads authentication network request failed',
        )
      }
      case 'rejected': {
        throw new Error('payload-plugin-attribution: Google Ads authentication failed')
      }
      case 'unavailable': {
        throw new GoogleAdsAuthUnavailableError(
          'payload-plugin-attribution: Google Ads token service unavailable',
        )
      }
    }
  }
}
