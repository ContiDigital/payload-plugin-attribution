import { describe, expect, it } from 'vitest'

import { CLICK_ID_KEYS, sanitizeAttribution } from '../sanitize.js'

describe('sanitizeAttribution', () => {
  it.each([
    {
      expected: { utmCampaign: 'fall-exhibition-2026-email' },
      input: { utmCampaign: 'fall-exhibition-2026-email' },
    },
    {
      expected: { utmCampaign: 'miami_art_week_2026_search' },
      input: { utmCampaign: 'miami_art_week_2026_search' },
    },
    {
      expected: { landingPath: '/artists/jean-michel-basquiat' },
      input: { landingPath: '/artists/jean-michel-basquiat' },
    },
    {
      expected: { landingPath: '/artworks/rufino-tamayo-hombre-con-sombrero' },
      input: { landingPath: '/artworks/rufino-tamayo-hombre-con-sombrero?x=1#y' },
    },
    { expected: null, input: { utmTerm: 'a3f9c2e8b7d14f6a9e0c5b2d8f7a1e3c' } },
    { expected: null, input: { utmContent: 'eyJhbGciOiJIUzI1NiJ9abcdefGHIJKLmnop' } },
    { expected: null, input: { utmSource: 'jane@example.com' } },
    { expected: null, input: { landingPath: '/confirm/jane%40example.com' } },
    {
      expected: { ttclid: 'E.C.P.CqgBAb3xYzQ1234567890abcdef' },
      input: { ttclid: 'E.C.P.CqgBAb3xYzQ1234567890abcdef' },
    },
    {
      expected: { fbclid: `IwAR${'a'.repeat(240)}` },
      input: { fbclid: `IwAR${'a'.repeat(240)}` },
    },
    { expected: null, input: { gclid: 'short' } },
    {
      expected: { gaClientId: 'GA1.1.123456789.1700000000' },
      input: { gaClientId: 'GA1.1.123456789.1700000000' },
    },
    {
      expected: {
        gaSessionId: 'GS2.1.s1700000000$o3$g1$t1700000100',
        gaSessionStartedAt: '2023-11-14T22:13:20.000Z',
      },
      input: { gaSessionId: 'GS2.1.s1700000000$o3$g1$t1700000100' },
    },
    { expected: { consentAdUserData: 'unknown' }, input: { consentAdUserData: 'yes' } },
    {
      expected: { fbc: 'fb.1.1700000000000.IwAR123' },
      input: { fbc: 'fb.1.1700000000000.IwAR123' },
    },
    {
      expected: { fbp: 'fb.1.1700000000000.1234567890' },
      input: { fbp: 'fb.1.1700000000000.1234567890' },
    },
    { expected: { utmSourcePlatform: 'google' }, input: { utmSourcePlatform: 'google' } },
    { expected: null, input: { utmSourcePlatform: 'jane@example.com' } },
    { expected: { utmCreativeFormat: 'video' }, input: { utmCreativeFormat: 'video' } },
    { expected: null, input: { utmCreativeFormat: 'jane@example.com' } },
    {
      expected: { utmMarketingTactic: 'remarketing' },
      input: { utmMarketingTactic: 'remarketing' },
    },
    { expected: null, input: { utmMarketingTactic: 'jane@example.com' } },
    {
      expected: { gclid: 'ValidClickID123' },
      input: { gclid: 'ValidClickID123', unknownKey: 'drop-me' },
    },
    {
      expected: { gclid: 'ValidClickID123' },
      input: { gclid: 'ValidClickID123', source: 'injected' },
    },
    { expected: null, input: { fbclid: '<script>' } },
    {
      expected: { referrerHost: 'example.com' },
      input: { referrerHost: 'https://example.com/path?q=1' },
    },
    { expected: null, input: { referrerHost: 'not a valid host' } },
    { expected: null, input: { gaSessionId: '9'.repeat(21) } },
    { expected: null, input: { firstSeenAt: '2026-02-30T00:00:00Z' } },
    { expected: null, input: null },
    { expected: null, input: undefined },
    { expected: null, input: 1 },
    { expected: null, input: [] },
    { expected: null, input: 'x' },
    { expected: null, input: {} },
    { expected: null, input: new Date() },
    { expected: null, input: { __proto__: { gclid: 'x'.repeat(20) } } },
    {
      expected: null,
      input: { landingPath: '/reset-password/Xk9q2LmZt8Rw3Yp6Vn1Hb4Qe7Ks0JdAbCdEfGh12' },
    },
    { expected: null, input: { landingPath: '/pay/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig' } },
    { expected: null, input: { landingPath: '/u/john%2540example.com' } },
    { expected: null, input: { landingPath: '/u/john%252540example.com' } },
    { expected: null, input: { landingPath: '/u/%E0%A4%A/john%40example.com' } },
    { expected: null, input: { utmContent: 'bad%ZZ-john%40example.com' } },
    { expected: null, input: { utmContent: 'john%2540example.com' } },
    { expected: null, input: { utmContent: 'john%40example.com' } },
    { expected: null, input: { utmContent: 'Xk9_q2Lm-Zt8Rw3_Yp6Vn1_Hb4Qe7Ks0' } },
    {
      expected: { utmContent: 'fall-exhibition-2026-email-newsletter-footer-link' },
      input: { utmContent: 'fall-exhibition-2026-email-newsletter-footer-link' },
    },
    {
      expected: { landingPath: '/artists/jean-michel-basquiat-untitled-1982-skull' },
      input: { landingPath: '/artists/jean-michel-basquiat-untitled-1982-skull' },
    },
    {
      expected: { landingPath: '/orders/ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
      input: { landingPath: '/orders/ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    },
    { expected: { utmTerm: '100%' }, input: { utmTerm: '100%' } },
    { expected: { srsltid: 'AfmBOoqSrsltid12345' }, input: { srsltid: 'AfmBOoqSrsltid12345' } },
  ])('sanitizes $input to $expected', ({ expected, input }) => {
    expect(sanitizeAttribution(input)).toEqual(expected)
  })

  it('lists every click id once, including srsltid', () => {
    expect([...CLICK_ID_KEYS].sort()).toEqual([
      'dclid',
      'fbclid',
      'gbraid',
      'gclid',
      'liFatId',
      'msclkid',
      'srsltid',
      'ttclid',
      'twclid',
      'wbraid',
    ])
  })

  it('ignores prototype-inherited properties entirely, not just the allow-listed keys', () => {
    const hostile = Object.create({ gclid: 'x'.repeat(20) }) as Record<string, unknown>
    expect(sanitizeAttribution(hostile)).toBeNull()
  })

  it('rejects hostile getters and proxies without throwing', () => {
    expect(
      sanitizeAttribution(
        Object.defineProperty({}, 'gclid', {
          enumerable: true,
          get() {
            throw new Error('hostile')
          },
        }),
      ),
    ).toBeNull()
    expect(
      sanitizeAttribution(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error('hostile')
            },
          },
        ),
      ),
    ).toBeNull()
  })
})

describe('token-like landing paths and referrers', () => {
  const hex40 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b'
  it.each([
    `/reset-password/${hex40}`,
    `/admin/reset/${hex40}`,
    `/en/reset-password/${hex40}`,
    `/reset-password/%39f86d081884c7d659a2feaa0c55ad015a3bf4f1b`,
    `/files/${hex40}`,
    '/files/9f86d081884c7d65',
    '/auth/magic/0123456789abcdef0123456789abcdef',
    '/d/k3j4h5g6f7d8s9a0q1w2e3r4t5y6u7i8o9p0',
    '/s/Xk9_q2Lm-Zt8Rw3_Yp6Vn1_Hb4Qe7Ks0',
    '/verify/abc',
    '/fr-ca/verify-email/abc',
    '/unsubscribe/list-42',
    '/invite/friends',
    '/token/anything',
    '/magic-link/xyz',
    '/%72eset-password/abc',
    '/de/%2572eset-password/abc',
    '/orders/550e8400-e29b-41d4-a716-446655440000',
  ])('rejects the landing path %s', (landingPath) => {
    expect(sanitizeAttribution({ landingPath })).toBeNull()
  })

  it.each([
    '/products/nike-air-max-90-premium-white',
    '/products/Nike-Air-Max-90-Premium-White',
    '/orders/12345678901234567890',
    '/reset-password',
    '/en/products/token-ring',
  ])('keeps the landing path %s', (landingPath) => {
    expect(sanitizeAttribution({ landingPath })).toEqual({ landingPath })
  })

  it.each(['Brand_Search_US_2026_Q3_Exact_Match', 'US-Search-NonBrand-2026-Retargeting'])(
    'keeps the mixed-case slug campaign %s',
    (utmCampaign) => {
      expect(sanitizeAttribution({ utmCampaign })).toEqual({ utmCampaign })
    },
  )

  it.each(['eyJhbGciOiJIUzI1NiJ9xYz123AbC456dEf', 'Xk9q2LmZt8Rw3Yp6Vn1Hb4Qe7Ks0JdAbCdEfGh12'])(
    'rejects the opaque campaign value %s',
    (utmCampaign) => {
      expect(sanitizeAttribution({ utmCampaign })).toBeNull()
    },
  )

  it('rejects a referrer host with a token-like label and keeps ordinary hosts', () => {
    expect(sanitizeAttribution({ referrerHost: `${hex40}.example.com` })).toBeNull()
    expect(sanitizeAttribution({ referrerHost: 'd111111abcdef8.cloudfront.net' })).toEqual({
      referrerHost: 'd111111abcdef8.cloudfront.net',
    })
  })
})

describe('separated base64url tokens', () => {
  it.each(['/s/Ab3dEf9hIjKl2-kLm4nOpQr6qR', '/s/Ab3dEf9hIjKl2_kLm4nOpQr6qR'])(
    'rejects the landing path %s',
    (landingPath) => {
      expect(sanitizeAttribution({ landingPath })).toBeNull()
    },
  )

  it('rejects a referrer host label holding a separated token', () => {
    expect(
      sanitizeAttribution({ referrerHost: 'Ab3dEf9hIjKl2-kLm4nOpQr6qR.example.com' }),
    ).toBeNull()
  })

  it.each([
    '/products/Nike-Air-Max-90-Premium-White',
    '/c/brand_search_us_2026_q3_exact_match',
    '/c/Brand_Search_US_2026_Q3_Exact_Match',
  ])('keeps the landing path %s', (landingPath) => {
    expect(sanitizeAttribution({ landingPath })).toEqual({ landingPath })
  })

  it.each(['brand_search_us_2026_q3_exact_match', 'Brand_Search_US_2026_Q3_Exact_Match'])(
    'keeps the campaign %s',
    (utmCampaign) => {
      expect(sanitizeAttribution({ utmCampaign })).toEqual({ utmCampaign })
    },
  )
})
