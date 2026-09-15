import { describe, expect, it } from 'vitest'

import { captureFromRequest } from '../capture.js'
import { readAttributionCookie } from '../cookie.js'

const DAY_MS = 86_400_000
const now = new Date('2026-09-13T16:00:00Z')
const later = (days: number): Date => new Date(now.getTime() + days * DAY_MS)
const gclid = 'Cj0KCQjw-gclid_1234'

const pair = (setCookie: string | undefined): string => {
  expect(setCookie).toBeDefined()
  return setCookie!.split(';')[0]
}

const get = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(url, { headers })

describe('captureFromRequest', () => {
  it('captures slug-style campaign values and the landing path', async () => {
    const { setCookie, touches } = await captureFromRequest(
      get(
        'https://example.com/exhibitions/fall-show?utm_source=newsletter&utm_campaign=fall-exhibition-2026-email&utm_source_platform=email',
      ),
      {},
      now,
    )
    expect(touches?.last).toMatchObject({
      capturedAt: now.toISOString(),
      landingPath: '/exhibitions/fall-show',
      source: 'web',
      utmCampaign: 'fall-exhibition-2026-email',
      utmSource: 'newsletter',
      utmSourcePlatform: 'email',
    })
    expect(touches?.first).toEqual(touches?.last)
    expect(setCookie).toBe(
      `attr_touch=${pair(setCookie).slice('attr_touch='.length)}; Path=/; Max-Age=7776000; SameSite=Lax; Secure`,
    )
  })

  it('keeps the Google click id when a later organic visit arrives', async () => {
    const paid = await captureFromRequest(
      get(`https://example.com/?gclid=${gclid}&gad_source=1`),
      {},
      now,
    )
    const organic = await captureFromRequest(
      get('https://example.com/artists', {
        cookie: pair(paid.setCookie),
        referer: 'https://www.google.com/',
      }),
      {},
      later(5),
    )
    expect(organic.touches?.last).toMatchObject({
      clickCapturedAt: now.toISOString(),
      gclid,
      referrerHost: 'www.google.com',
    })
    expect(organic.touches?.last.gadSource).toBeUndefined()
    expect(organic.touches?.first.gclid).toBe(gclid)
  })

  it('treats www and apex hosts as the same site', async () => {
    expect(
      await captureFromRequest(
        get('https://example.com/a', { referer: 'https://www.example.com/' }),
      ),
    ).toEqual({})
    expect(
      await captureFromRequest(
        get('https://www.example.com/a', { referer: 'https://example.com/' }),
      ),
    ).toEqual({})
    expect(
      await captureFromRequest(
        get('https://www.example.co.uk/a', { referer: 'https://shop.example.co.uk/' }),
      ),
    ).toEqual({})
    const other = await captureFromRequest(
      get('https://www.example.co.uk/a', { referer: 'https://other.co.uk/' }),
      {},
      now,
    )
    expect(other.touches?.last.referrerHost).toBe('other.co.uk')
  })

  it('lets siteHosts replace the default internal hosts', async () => {
    const options = { siteHosts: ['.example.com', 'shop.partner.test'] }
    expect(
      await captureFromRequest(
        get('https://example.com/', { referer: 'https://shop.partner.test/' }),
        options,
      ),
    ).toEqual({})
    expect(
      await captureFromRequest(
        get('https://example.com/', { referer: 'https://a.b.example.com/' }),
        options,
      ),
    ).toEqual({})
    const external = await captureFromRequest(
      get('https://example.com/', { referer: 'https://www.partner.test/' }),
      options,
      now,
    )
    expect(external.touches?.last.referrerHost).toBe('www.partner.test')
  })

  it('ignores payment and sign-in returns as referrers', async () => {
    const paid = await captureFromRequest(get(`https://example.com/?gclid=${gclid}`), {}, now)
    for (const referer of [
      'https://checkout.stripe.com/c/pay/cs_test',
      'https://accounts.google.com/o/oauth2',
      'https://www.paypal.com/checkoutnow',
      'https://appleid.apple.com/auth',
      'https://hooks.stripe.com/redirect',
    ]) {
      expect(
        await captureFromRequest(
          get('https://example.com/order/complete', { cookie: pair(paid.setCookie), referer }),
          {},
          later(1),
        ),
      ).toEqual({})
    }
    expect(
      await captureFromRequest(
        get('https://example.com/', { referer: 'https://login.partner.test/' }),
        { ignoreReferrers: ['partner.test'] },
      ),
    ).toEqual({})
  })

  it('sets nothing for empty parameters on internal navigation', async () => {
    const first = await captureFromRequest(get('https://example.com/?utm_source=mail'), {}, now)
    expect(
      await captureFromRequest(
        get('https://example.com/b?utm_source=&gclid=', {
          cookie: pair(first.setCookie),
          referer: 'https://example.com/a',
        }),
        {},
        later(1),
      ),
    ).toEqual({})
    expect(
      await captureFromRequest(
        get('https://example.com/b?utm_source=', { referer: 'https://example.com/a' }),
        {},
        now,
      ),
    ).toEqual({})
  })

  it('captures a first direct visit but not a returning direct visit', async () => {
    const first = await captureFromRequest(get('https://example.com/welcome'), {}, now)
    expect(first.touches?.last).toMatchObject({ landingPath: '/welcome', source: 'web' })
    expect(
      await captureFromRequest(
        get('https://example.com/again', { cookie: pair(first.setCookie) }),
        {},
        later(1),
      ),
    ).toEqual({})
  })

  it('skips capture entirely when consent is denied', async () => {
    expect(
      await captureFromRequest(get(`https://example.com/?gclid=${gclid}&utm_source=ads`), {
        consent: () => 'denied',
      }),
    ).toEqual({})
    expect(
      await captureFromRequest(
        get(`https://example.com/?gclid=${gclid}`, { 'sec-gpc': '1' }),
        { consent: () => Promise.resolve('granted' as const) },
        now,
      ),
    ).toMatchObject({ touches: { last: { gclid } } })
  })

  it('drops ad identifiers but keeps campaign data under Sec-GPC by default', async () => {
    const { touches } = await captureFromRequest(
      get(`https://example.com/?gclid=${gclid}&fbclid=IwAR_fbclid_12345&utm_source=ads`, {
        cookie: '_fbp=fb.1.1757779200000.123456789',
        referer: 'https://news.test/',
        'sec-gpc': '1',
      }),
      {},
      now,
    )
    expect(touches?.last).toMatchObject({ referrerHost: 'news.test', utmSource: 'ads' })
    for (const key of ['gclid', 'fbclid', 'fbc', 'fbp', 'clickCapturedAt'] as const) {
      expect(touches?.last[key]).toBeUndefined()
    }
  })

  it('reads Meta browser cookies and builds fbc from fbclid when _fbc is absent', async () => {
    const fbclid = 'IwAR_fbclid_12345'
    const built = await captureFromRequest(
      get(`https://example.com/?fbclid=${fbclid}`, {
        cookie: '_fbp=fb.1.1757779200000.123456789',
      }),
      {},
      now,
    )
    expect(built.touches?.last).toMatchObject({
      fbc: `fb.1.${now.getTime()}.${fbclid}`,
      fbclid,
      fbp: 'fb.1.1757779200000.123456789',
    })
    const existing = `fb.1.1757779200000.${fbclid}`
    const kept = await captureFromRequest(
      get(`https://example.com/?fbclid=${fbclid}`, { cookie: `_fbc=${existing}` }),
      {},
      now,
    )
    expect(kept.touches?.last.fbc).toBe(existing)
  })

  it('uses forwarded host and protocol only when trusted', async () => {
    const request = (): Request =>
      get('https://10.0.0.5:3000/', {
        referer: 'https://www.example.com/',
        'x-forwarded-host': 'example.com',
        'x-forwarded-proto': 'http',
      })
    const untrusted = await captureFromRequest(request(), {}, now)
    expect(untrusted.touches?.last.referrerHost).toBe('www.example.com')
    expect(untrusted.setCookie).toContain('; Secure')
    expect(await captureFromRequest(request(), { trustForwardedHost: true }, now)).toEqual({})
    const trusted = await captureFromRequest(
      get('https://10.0.0.5:3000/?utm_source=mail', {
        'x-forwarded-host': 'example.com, proxy.internal',
        'x-forwarded-proto': 'http',
      }),
      { trustForwardedHost: true },
      now,
    )
    expect(trusted.setCookie).toBeDefined()
    expect(trusted.setCookie).not.toContain('Secure')
  })

  it('recalculates Max-Age from the latest click for a returning visitor', async () => {
    const first = await captureFromRequest(get(`https://example.com/?gclid=${gclid}`), {}, now)
    const returning = await captureFromRequest(
      get('https://example.com/?gclid=Cj0KCQjw-second_5678', { cookie: pair(first.setCookie) }),
      {},
      later(30),
    )
    expect(returning.setCookie).toContain('Max-Age=7776000;')
    expect(returning.touches?.last.clickCapturedAt).toBe(later(30).toISOString())
    expect(returning.touches?.first.firstSeenAt).toBe(now.toISOString())
  })

  it('skips non-GET methods, prefetches and RSC data requests', async () => {
    const url = `https://example.com/?gclid=${gclid}`
    expect(await captureFromRequest(new Request(url, { method: 'POST' }))).toEqual({})
    const prefetches: Record<string, string>[] = [
      { 'next-router-prefetch': '1' },
      { purpose: 'prefetch' },
      { 'sec-purpose': 'prefetch;prerender' },
      { rsc: '1' },
    ]
    for (const headers of prefetches) {
      expect(await captureFromRequest(get(url, headers))).toEqual({})
    }
    expect(
      (await captureFromRequest(new Request(url, { method: 'HEAD' }), {}, now)).setCookie,
    ).toBeDefined()
  })

  it('applies the configured cookie name, domain and byte budget', async () => {
    const { setCookie } = await captureFromRequest(
      get('http://example.com/?utm_source=mail'),
      { cookieDomain: '.example.com', cookieName: 'site_attr' },
      now,
    )
    expect(setCookie).toMatch(
      /^site_attr=[^;]+; Path=\/; Max-Age=7776000; SameSite=Lax; Domain=\.example\.com$/,
    )
    expect(
      await captureFromRequest(get('https://example.com/?utm_source=mail'), { maxBytes: 20 }, now),
    ).toEqual({})
  })

  it('rejects invalid options', async () => {
    await expect(
      captureFromRequest(get('https://example.com/'), { cookieName: 'bad name' }),
    ).rejects.toThrow(TypeError)
    await expect(
      captureFromRequest(get('https://example.com/'), { cookieDomain: 'bad domain;' }),
    ).rejects.toThrow(TypeError)
    await expect(captureFromRequest(get('https://example.com/'), { maxBytes: 0 })).rejects.toThrow(
      TypeError,
    )
  })
})

describe('readAttributionCookie', () => {
  it('returns the first valid decode among duplicate cookies', async () => {
    const { setCookie } = await captureFromRequest(
      get(`https://example.com/?gclid=${gclid}`),
      {},
      now,
    )
    const header = `attr_touch=not-json; other=1; ${pair(setCookie)}`
    expect(readAttributionCookie(header, { now })?.last.gclid).toBe(gclid)
    expect(readAttributionCookie(pair(setCookie), { cookieName: 'other', now })).toBeNull()
    expect(readAttributionCookie(null)).toBeNull()
    expect(readAttributionCookie(undefined)).toBeNull()
    expect(readAttributionCookie(pair(setCookie), { now: later(92) })).toBeNull()
  })

  it('trims names and values, strips quotes and ignores oversized headers', async () => {
    const { setCookie } = await captureFromRequest(
      get(`https://example.com/?gclid=${gclid}`),
      {},
      now,
    )
    const value = pair(setCookie).slice('attr_touch='.length)
    expect(readAttributionCookie(` attr_touch = ${value} `, { now })?.last.gclid).toBe(gclid)
    expect(readAttributionCookie(`attr_touch="${value}"`, { now })?.last.gclid).toBe(gclid)
    const padding = `pad=${'x'.repeat(16384)}`
    expect(readAttributionCookie(`${pair(setCookie)}; ${padding}`, { now })).toBeNull()
  })
})

describe('ad identifier hygiene', () => {
  const fbclid = 'IwAR_fbclid_12345'
  const fbp = 'fb.1.1757779200000.123456789'
  const validFbc = `fb.1.1757779200000.${fbclid}`
  const adKeys = [
    'gclid',
    'gbraid',
    'wbraid',
    'dclid',
    'srsltid',
    'fbclid',
    'msclkid',
    'ttclid',
    'twclid',
    'liFatId',
    'fbc',
    'fbp',
    'clickCapturedAt',
  ] as const

  it('strips carried ad identifiers from both touches under Sec-GPC', async () => {
    const paid = await captureFromRequest(
      get(`https://example.com/?gclid=${gclid}&fbclid=${fbclid}&srsltid=AfmBOoqSrsltid12345`, {
        cookie: `_fbc=${validFbc}; _fbp=${fbp}`,
      }),
      {},
      now,
    )
    expect(paid.touches?.first.gclid).toBe(gclid)
    expect(paid.touches?.first.srsltid).toBe('AfmBOoqSrsltid12345')
    const gpc = await captureFromRequest(
      get('https://example.com/?utm_source=x', {
        cookie: `${pair(paid.setCookie)}; _fbc=${validFbc}; _fbp=${fbp}`,
        'sec-gpc': '1',
      }),
      {},
      later(1),
    )
    const written = readAttributionCookie(pair(gpc.setCookie), { now: later(1) })
    expect(written?.last.utmSource).toBe('x')
    for (const touch of [written?.first, written?.last]) {
      for (const key of adKeys) {
        expect(touch?.[key]).toBeUndefined()
      }
    }
  })

  it('skips invalid Meta cookies and uses the first valid duplicate', async () => {
    const { touches } = await captureFromRequest(
      get('https://example.com/?utm_source=x', {
        cookie: `_fbc=garbage; _fbp=nope; _fbc=${validFbc}; _fbp=${fbp}`,
      }),
      {},
      now,
    )
    expect(touches?.last).toMatchObject({ fbc: validFbc, fbp })
  })

  it('builds fbc from the URL fbclid when _fbc is invalid', async () => {
    const { touches } = await captureFromRequest(
      get(`https://example.com/?fbclid=${fbclid}`, { cookie: '_fbc=garbage' }),
      {},
      now,
    )
    expect(touches?.last.fbc).toBe(`fb.1.${now.getTime()}.${fbclid}`)
  })

  it('keeps a valid _fbc without a URL fbclid and replaces one for a different click', async () => {
    const kept = await captureFromRequest(
      get('https://example.com/?utm_source=x', { cookie: `_fbc=${validFbc}` }),
      {},
      now,
    )
    expect(kept.touches?.last.fbc).toBe(validFbc)
    const newClick = 'IwAR_newclick_67890'
    const replaced = await captureFromRequest(
      get(`https://example.com/?fbclid=${newClick}`, { cookie: `_fbc=${validFbc}` }),
      {},
      now,
    )
    expect(replaced.touches?.last.fbc).toBe(`fb.1.${now.getTime()}.${newClick}`)
  })
})

describe('shared hosting suffixes', () => {
  it('does not treat other tenants of a shared hosting domain as internal', async () => {
    for (const [host, tenant] of [
      ['myapp.vercel.app', 'other.vercel.app'],
      ['alice.github.io', 'bob.github.io'],
    ] as const) {
      const { touches } = await captureFromRequest(
        get(`https://${host}/`, { referer: `https://${tenant}/` }),
        {},
        now,
      )
      expect(touches?.last.referrerHost).toBe(tenant)
      expect(
        await captureFromRequest(
          get(`https://${host}/a`, { referer: `https://${host}/` }),
          {},
          now,
        ),
      ).toEqual({})
    }
  })
})

describe('internal click decoration', () => {
  it('never writes for an internal visit once a cookie exists, and never re-anchors the same click', async () => {
    const paid = await captureFromRequest(
      get(`https://example.com/?gclid=${gclid}&utm_source=google&utm_medium=cpc`, {
        referer: 'https://www.google.com/',
      }),
      {},
      now,
    )
    const cookie = pair(paid.setCookie)
    for (const days of [2, 89]) {
      expect(
        await captureFromRequest(
          get(`https://example.com/checkout?gclid=${gclid}&utm_source=site`, {
            cookie,
            referer: 'https://example.com/cart',
          }),
          {},
          later(days),
        ),
      ).toEqual({})
    }
    expect(readAttributionCookie(cookie, { now: later(2) })?.last).toEqual(paid.touches?.last)
    const bookmarked = await captureFromRequest(
      get(`https://example.com/checkout?gclid=${gclid}`, { cookie }),
      {},
      later(89),
    )
    expect(bookmarked.touches?.last).toMatchObject({
      clickCapturedAt: now.toISOString(),
      gclid,
    })
  })

  it('still captures a first visit with no cookie from an internal referrer', async () => {
    const { touches } = await captureFromRequest(
      get(`https://example.com/checkout?gclid=${gclid}`, { referer: 'https://example.com/cart' }),
      {},
      now,
    )
    expect(touches?.last).toMatchObject({ clickCapturedAt: now.toISOString(), gclid })
  })
})

describe('landing path and campaign privacy', () => {
  it('drops landingPath under excludePaths and decodes nested escapes in campaign values', async () => {
    const { touches } = await captureFromRequest(
      get(
        'https://example.com/reset-password/abc?utm_source=mail&utm_content=john%2540example.com',
      ),
      { excludePaths: ['/reset-password', '/pay/'] },
      now,
    )
    expect(touches?.last.utmSource).toBe('mail')
    expect(touches?.last.landingPath).toBeUndefined()
    expect(touches?.last.utmContent).toBeUndefined()
    const kept = await captureFromRequest(
      get('https://example.com/payments?utm_source=mail'),
      { excludePaths: ['/pay/'] },
      now,
    )
    expect(kept.touches?.last.landingPath).toBe('/payments')
    await expect(
      captureFromRequest(get('https://example.com/'), { excludePaths: ['reset'] }),
    ).rejects.toThrow(TypeError)
  })
})

describe('payment and sign-in referrers', () => {
  it('ignores subdomains of the built-in payment and sign-in domains', async () => {
    const paid = await captureFromRequest(get(`https://example.com/?gclid=${gclid}`), {}, now)
    for (const referer of [
      'https://invoice.stripe.com/i/acct',
      'https://connect.stripe.com/setup',
      'https://sandbox.paypal.com/checkoutnow',
      'https://www.sandbox.paypal.com/checkoutnow',
      'https://pay.google.com/gp/p/ui/pay',
      'https://login.microsoftonline.com/common/oauth2',
    ]) {
      expect(
        await captureFromRequest(
          get('https://example.com/order/complete', { cookie: pair(paid.setCookie), referer }),
          {},
          later(1),
        ),
      ).toEqual({})
    }
  })
})

describe('registrable domains', () => {
  it('treats sibling registrations under country second-level domains as external', async () => {
    for (const [host, referrer] of [
      ['example.com.ar', 'other.com.ar'],
      ['www.example.co.il', 'evil.co.il'],
      ['shop.example.ne.jp', 'other.ne.jp'],
    ] as const) {
      const { touches } = await captureFromRequest(
        get(`https://${host}/`, { referer: `https://${referrer}/` }),
        {},
        now,
      )
      expect(touches?.last.referrerHost).toBe(referrer)
    }
  })

  it('treats any subdomain of the same registrable domain as internal', async () => {
    for (const [host, referrer] of [
      ['a.b.example.com', 'www.example.com'],
      ['www.example.co.uk', 'example.co.uk'],
      ['example.co.uk', 'shop.example.co.uk'],
      ['localhost', 'localhost'],
      ['127.0.0.1', '127.0.0.1'],
    ] as const) {
      expect(
        await captureFromRequest(
          get(`https://${host}/`, { referer: `https://${referrer}/` }),
          {},
          now,
        ),
      ).toEqual({})
    }
    const ip = await captureFromRequest(
      get('https://10.0.0.1/', { referer: 'https://0.0.1/' }),
      {},
      now,
    )
    expect(ip.touches?.last.referrerHost).toBeDefined()
  })
})

describe('click ids from other networks', () => {
  it('keeps a carried gclid through organic srsltid and fbclid visits and replaces only its own key', async () => {
    const paid = await captureFromRequest(get(`https://example.com/?gclid=${gclid}`), {}, now)
    const shopping = await captureFromRequest(
      get('https://example.com/p?srsltid=AfmBOoqAAAAAAAAAAAAAAAAA', {
        cookie: pair(paid.setCookie),
        referer: 'https://www.google.com/',
      }),
      {},
      later(3),
    )
    expect(shopping.touches?.last).toMatchObject({ gclid, srsltid: 'AfmBOoqAAAAAAAAAAAAAAAAA' })
    expect(shopping.touches?.clickTimes?.gclid).toBe(now.toISOString())
    const facebook = await captureFromRequest(
      get('https://example.com/p?fbclid=IwAR0aaaaaaaaaaaaaaaaa', {
        cookie: pair(shopping.setCookie),
        referer: 'https://l.facebook.com/',
      }),
      {},
      later(4),
    )
    expect(facebook.touches?.last).toMatchObject({ fbclid: 'IwAR0aaaaaaaaaaaaaaaaa', gclid })
    const second = 'Cj0KCQjw-second_5678'
    const again = await captureFromRequest(
      get(`https://example.com/?gclid=${second}`, { cookie: pair(facebook.setCookie) }),
      {},
      later(6),
    )
    expect(again.touches?.last).toMatchObject({ fbclid: 'IwAR0aaaaaaaaaaaaaaaaa', gclid: second })
    expect(again.touches?.clickTimes).toMatchObject({
      fbclid: later(4).toISOString(),
      gclid: later(6).toISOString(),
    })
  })
})

describe('reset tokens in landing paths', () => {
  it('never writes a webmail reset token into the cookie', async () => {
    const token = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b'
    const { setCookie, touches } = await captureFromRequest(
      get(`https://shop.example.com/reset-password/${token}`, {
        referer: 'https://mail.google.com/',
      }),
      {},
      now,
    )
    expect(touches?.last.referrerHost).toBe('mail.google.com')
    expect(setCookie).toBeDefined()
    expect(setCookie).not.toContain(token)
  })
})

describe('cookie option validation', () => {
  it('rejects a __Host- cookie with a domain and a name that cannot fit with maxBytes', async () => {
    await expect(
      captureFromRequest(get('https://example.com/'), {
        cookieDomain: 'example.com',
        cookieName: '__Host-attr',
      }),
    ).rejects.toThrow(TypeError)
    await expect(
      captureFromRequest(get('https://example.com/'), {
        cookieName: 'a'.repeat(80),
        maxBytes: 4096,
      }),
    ).rejects.toThrow(TypeError)
    const { setCookie } = await captureFromRequest(
      get('https://example.com/?utm_source=mail'),
      { cookieName: '__Host-attr' },
      now,
    )
    expect(setCookie).toMatch(/^__Host-attr=.*; Path=\/;.*Secure$/)
  })
})

describe('denied consent scrubs an existing cookie', () => {
  const adKeys = [
    'gclid',
    'gbraid',
    'wbraid',
    'dclid',
    'srsltid',
    'fbclid',
    'msclkid',
    'ttclid',
    'twclid',
    'liFatId',
    'fbc',
    'fbp',
    'clickCapturedAt',
  ] as const
  const expectScrubbed = (setCookie: string | undefined, at: Date): void => {
    const written = readAttributionCookie(pair(setCookie), { now: at })
    expect(written).not.toBeNull()
    expect(written?.clickTimes).toBeUndefined()
    for (const touch of [written?.first, written?.last]) {
      for (const key of adKeys) {
        expect(touch?.[key]).toBeUndefined()
      }
    }
    expect(written?.first.utmSource).toBe('google')
  }

  const paidCookie = async (): Promise<string> =>
    pair(
      (
        await captureFromRequest(
          get(`https://example.com/?gclid=${gclid}&fbclid=IwAR_fbclid_12345&utm_source=google`, {
            cookie: '_fbp=fb.1.1757779200000.123456789',
          }),
          {},
          now,
        )
      ).setCookie,
    )

  it.each([
    ['an internal referrer', { referer: 'https://example.com/cart' }],
    ['no referrer', {}],
    ['an external referrer', { referer: 'https://news.test/' }],
  ] as const)(
    'rewrites the cookie without ad ids under Sec-GPC with %s',
    async (_label, headers) => {
      const cookie = await paidCookie()
      const result = await captureFromRequest(
        get('https://example.com/next', { ...headers, cookie, 'sec-gpc': '1' }),
        {},
        later(1),
      )
      expectScrubbed(result.setCookie, later(1))
    },
  )

  it.each([
    ['an internal referrer', { referer: 'https://example.com/cart' }],
    ['no referrer', {}],
    ['tracking parameters', {}],
  ] as const)(
    'rewrites the cookie without ad ids when the consent hook denies with %s',
    async (label, headers) => {
      const cookie = await paidCookie()
      const url =
        label === 'tracking parameters'
          ? `https://example.com/?gclid=Cj0KCQjw-other_99999&utm_source=x`
          : 'https://example.com/next'
      const result = await captureFromRequest(
        get(url, { ...headers, cookie }),
        { consent: () => 'denied' },
        later(1),
      )
      expectScrubbed(result.setCookie, later(1))
      expect(result.touches?.last.utmSource).not.toBe('x')
    },
  )

  it.each([
    [
      'throws',
      () => {
        throw new SyntaxError('bad consent cookie')
      },
    ],
    ['rejects', () => Promise.reject(new Error('consent service down'))],
  ] as const)('treats a consent hook that %s as denied', async (_label, consent) => {
    const cookie = await paidCookie()
    const scrubbed = await captureFromRequest(
      get(`https://example.com/?gclid=Cj0KCQjw-other_99999&utm_source=x`, { cookie }),
      { consent },
      later(1),
    )
    expectScrubbed(scrubbed.setCookie, later(1))
    expect(
      await captureFromRequest(
        get(`https://example.com/?gclid=${gclid}&utm_source=ads`),
        { consent },
        now,
      ),
    ).toEqual({})
  })

  it('writes nothing when a denied request has no ad ids to scrub', async () => {
    const plain = await captureFromRequest(get('https://example.com/?utm_source=mail'), {}, now)
    expect(
      await captureFromRequest(
        get('https://example.com/next', { cookie: pair(plain.setCookie), 'sec-gpc': '1' }),
        {},
        later(1),
      ),
    ).toEqual({})
    expect(
      await captureFromRequest(
        get('https://example.com/next', { cookie: pair(plain.setCookie) }),
        { consent: () => 'denied' },
        later(1),
      ),
    ).toEqual({})
  })
})

describe('excludePaths segment matching', () => {
  const options = { excludePaths: ['/account'] }
  const landing = async (path: string): Promise<string | undefined> =>
    (await captureFromRequest(get(`https://example.com${path}?utm_source=mail`), options, now))
      .touches?.last.landingPath

  it('matches whole decoded segments, also after a leading locale segment', async () => {
    expect(await landing('/account')).toBeUndefined()
    expect(await landing('/account/orders')).toBeUndefined()
    expect(await landing('/%61ccount/orders')).toBeUndefined()
    expect(await landing('/Account/orders')).toBeUndefined()
    expect(await landing('/en/account/orders')).toBeUndefined()
    expect(await landing('/pt-br/account')).toBeUndefined()
    expect(await landing('/accountless')).toBe('/accountless')
    expect(await landing('/shop/account')).toBe('/shop/account')
    expect(
      (
        await captureFromRequest(
          get('https://example.com/pay/x?utm_source=mail'),
          { excludePaths: ['/pay/'] },
          now,
        )
      ).touches?.last.landingPath,
    ).toBeUndefined()
  })
})
