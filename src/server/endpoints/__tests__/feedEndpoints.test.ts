import type { PayloadRequest } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { AttributionPluginOptions } from '../../../types/index.js'

import { normalizeOptions } from '../../../plugin/normalizeOptions.js'
import { feedEndpoints } from '../feedEndpoints.js'

const basic = (value: string): string => `Basic ${Buffer.from(value).toString('base64')}`
const goodAuth = basic('feed-user:feed-password')

const feed = { password: 'feed-password', username: 'feed-user' }
const names = { lead: 'Business lead', sale: 'Business sale' }

const call = async (
  input: AttributionPluginOptions['destinations'],
  file: 'adjustments' | 'conversions',
  authorization?: string,
  apiBasePath?: string,
) => {
  const options = normalizeOptions({ apiBasePath, destinations: input, secret: 'plugin-secret' })
  const endpoint = feedEndpoints(options).find((candidate) =>
    candidate.path.endsWith(`/google-ads/${file}.csv`),
  )
  if (!endpoint) {
    throw new Error(`no ${file} endpoint`)
  }
  const find = vi.fn(() => Promise.reject(new Error('the database must not be read')))
  const req = {
    headers: new Headers(authorization ? { authorization } : {}),
    payload: { find, logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } },
  } as unknown as PayloadRequest
  const response = await endpoint.handler(req)
  return { find, req, response }
}

describe('feedEndpoints', () => {
  it('registers GET conversions and adjustments files under apiBasePath', () => {
    const options = normalizeOptions({ apiBasePath: '/tracking', secret: 'plugin-secret' })
    expect(feedEndpoints(options).map(({ method, path }) => [method, path])).toEqual([
      ['get', '/tracking/google-ads/conversions.csv'],
      ['get', '/tracking/google-ads/adjustments.csv'],
    ])
  })

  it.each(['conversions', 'adjustments'] as const)(
    'answers 401 with a challenge for %s when Google Ads is not configured, even with credentials',
    async (file) => {
      const { find, response } = await call({}, file, goodAuth)
      expect(response.status).toBe(401)
      expect(response.headers.get('WWW-Authenticate')).toBe(
        'Basic realm="attribution", charset="UTF-8"',
      )
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(find).not.toHaveBeenCalled()
    },
  )

  it('answers 401 for a wrong password', async () => {
    const { response } = await call(
      { googleAds: { conversionActions: names, feed, transport: 'feed' } },
      'conversions',
      basic('feed-user:wrong'),
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic')
  })

  it('logs a failed authentication without the submitted credentials', async () => {
    const { req, response } = await call(
      { googleAds: { conversionActions: names, feed, transport: 'feed' } },
      'conversions',
      basic('feed-user:guessed-secret'),
    )
    expect(response.status).toBe(401)
    const logged = JSON.stringify(vi.mocked(req.payload.logger.warn).mock.calls)
    expect(logged).toContain('feed authentication failed')
    expect(logged).not.toContain('guessed-secret')
    expect(logged).not.toContain(Buffer.from('feed-user:guessed-secret').toString('base64'))
  })

  it('answers 503 with Retry-After when a credential setting throws', async () => {
    const { response } = await call(
      {
        googleAds: {
          conversionActions: names,
          feed: {
            password: () => {
              throw new Error('secret store unavailable')
            },
            username: 'feed-user',
          },
          transport: 'feed',
        },
      },
      'conversions',
      goodAuth,
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('300')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('checks authorization before disclosing that the conversions feed is off', async () => {
    const dataManager = {
      googleAds: {
        adjustments: { enabled: true },
        conversionActions: { lead: '111', sale: '222' },
        feed,
        operatingAccountId: '1234567890',
        serviceAccountJson: '{}',
        transport: 'dataManager' as const,
      },
    }
    expect((await call(dataManager, 'conversions')).response.status).toBe(401)
    const { find, response } = await call(dataManager, 'conversions', goodAuth)
    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(find).not.toHaveBeenCalled()
  })

  it('answers 404 for adjustments when adjustments are disabled', async () => {
    const input = { googleAds: { conversionActions: names, feed, transport: 'feed' as const } }
    expect((await call(input, 'adjustments', basic('feed-user:nope'))).response.status).toBe(401)
    expect((await call(input, 'adjustments', goodAuth)).response.status).toBe(404)
  })

  it('answers 404 when Google Ads is disabled', async () => {
    const input = {
      googleAds: { conversionActions: names, enabled: false, feed, transport: 'feed' as const },
    }
    expect((await call(input, 'conversions', goodAuth)).response.status).toBe(404)
  })
})
