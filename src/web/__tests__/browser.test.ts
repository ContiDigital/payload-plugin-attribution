// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { encodeTouches } from '../../core/touches.js'
import {
  attributionForSubmit,
  captureAttribution,
  consentDefaults,
  createEventId,
  trackClient,
} from '../browser.js'

const now = new Date('2026-09-13T16:00:00Z')

const cookieHeaderFor = (extra: Record<string, unknown> = {}): string => {
  const touch = {
    capturedAt: now.toISOString(),
    firstSeenAt: now.toISOString(),
    source: 'web' as const,
    utmSource: 'newsletter',
    ...extra,
  }
  return `attr_touch=${encodeTouches({ first: touch, last: touch })}`
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('captureAttribution', () => {
  it('returns GA identity from a stubbed gtag even when the cookie is missing', async () => {
    vi.stubGlobal('document', { cookie: '' })
    const gtag = vi.fn((...args: unknown[]) => {
      if (args[0] === 'get') {
        const field = args[2]
        const callback = args[3] as (value: unknown) => void
        callback(field === 'client_id' ? '123.456' : field === 'session_id' ? '1789300000' : 2)
      }
    })
    vi.stubGlobal('window', { gtag })
    const result = await captureAttribution({ measurementId: 'G-TEST' })
    expect(result.last.gaClientId).toBe('123.456')
    expect(result.last.gaSessionNumber).toBe(2)
    expect(result.first).toBeUndefined()
  })

  it('merges GA identity over the cookie last touch, keeping the cookie first touch', async () => {
    vi.stubGlobal('document', { cookie: cookieHeaderFor() })
    const gtag = vi.fn((...args: unknown[]) => {
      if (args[0] === 'get') {
        const field = args[2]
        const callback = args[3] as (value: unknown) => void
        callback(field === 'client_id' ? '123.456' : field === 'session_id' ? '1789300000' : 2)
      }
    })
    vi.stubGlobal('window', { gtag })
    const result = await captureAttribution({ measurementId: 'G-TEST' })
    expect(result.first).toMatchObject({ utmSource: 'newsletter' })
    expect(result.last).toMatchObject({ gaClientId: '123.456', utmSource: 'newsletter' })
  })

  it('resolves within timeoutMs even when gtag never calls back', async () => {
    vi.useFakeTimers({ now })
    vi.stubGlobal('document', { cookie: '' })
    vi.stubGlobal('window', { gtag: vi.fn() })
    const pending = captureAttribution({ measurementId: 'G-TEST', timeoutMs: 500 })
    await vi.advanceTimersByTimeAsync(500)
    const result = await pending
    expect(result.last).toEqual({})
  })

  it('returns cookie data only when gtag throws', async () => {
    vi.stubGlobal('document', { cookie: cookieHeaderFor() })
    vi.stubGlobal('window', {
      gtag: () => {
        throw new Error('boom')
      },
    })
    const result = await captureAttribution({ measurementId: 'G-TEST' })
    expect(result.last).toEqual({
      capturedAt: now.toISOString(),
      firstSeenAt: now.toISOString(),
      source: 'web',
      utmSource: 'newsletter',
    })
  })

  it('is SSR-safe and returns an empty last touch without throwing', async () => {
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('document', undefined)
    await expect(captureAttribution({ measurementId: 'G-TEST' })).resolves.toEqual({ last: {} })
  })

  it('reads _fbp and _fbc from document.cookie', async () => {
    const fbp = 'fb.1.1699999999999.abc123'
    const fbc = 'fb.1.1699999999999.xyz789'
    vi.stubGlobal('document', { cookie: `${cookieHeaderFor()}; _fbp=${fbp}; _fbc=${fbc}` })
    vi.stubGlobal('window', {})
    const result = await captureAttribution()
    expect(result.last.fbp).toBe(fbp)
    expect(result.last.fbc).toBe(fbc)
  })

  it('discards an invalid _fbp/_fbc cookie value', async () => {
    vi.stubGlobal('document', { cookie: `${cookieHeaderFor()}; _fbp=not-valid` })
    vi.stubGlobal('window', {})
    const result = await captureAttribution()
    expect(result.last.fbp).toBeUndefined()
  })

  it('merges consent from options.consent() using the short key names', async () => {
    vi.stubGlobal('document', { cookie: cookieHeaderFor() })
    vi.stubGlobal('window', {})
    const result = await captureAttribution({
      consent: () => ({ adUserData: 'denied', analyticsStorage: 'granted' }),
    })
    expect(result.last.consentAdUserData).toBe('denied')
    expect(result.last.consentAnalyticsStorage).toBe('granted')
    expect(result.last.consentAdPersonalization).toBeUndefined()
  })

  it('respects a custom cookieName', async () => {
    const touch = {
      capturedAt: now.toISOString(),
      firstSeenAt: now.toISOString(),
      source: 'web' as const,
    }
    vi.stubGlobal('document', {
      cookie: `site_attr=${encodeTouches({ first: touch, last: touch })}`,
    })
    vi.stubGlobal('window', {})
    const result = await captureAttribution({ cookieName: 'site_attr' })
    expect(result.first).toMatchObject({ source: 'web' })
  })
})

describe('ad identifier consent', () => {
  const adCookie = (): string =>
    `${cookieHeaderFor({
      clickCapturedAt: now.toISOString(),
      gclid: 'Cj0KCQjw-gclid_1234',
      srsltid: 'AfmBOoqSrsltid12345',
    })}; _fbp=fb.1.1699999999999.abc123; _fbc=fb.1.1699999999999.xyz789`
  const adKeys = ['gclid', 'srsltid', 'fbc', 'fbp', 'clickCapturedAt'] as const
  const identityGtag = () =>
    vi.fn((...args: unknown[]) => {
      if (args[0] === 'get') {
        ;(args[3] as (value: unknown) => void)(args[2] === 'client_id' ? '123.456' : 2)
      }
    })

  it('omits click ids, fbc and fbp under GPC and marks ad consent denied without a callback', async () => {
    vi.stubGlobal('document', { cookie: adCookie() })
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { globalPrivacyControl: true })
    const { first, last } = await captureAttribution()
    for (const key of adKeys) {
      expect(first?.[key]).toBeUndefined()
      expect(last[key]).toBeUndefined()
    }
    const submitted = await attributionForSubmit()
    expect(submitted).toMatchObject({
      consentAdPersonalization: 'denied',
      consentAdUserData: 'denied',
      utmSource: 'newsletter',
    })
    expect(submitted.gclid).toBeUndefined()
  })

  it('keeps ad identifiers under GPC only when the host explicitly grants adUserData', async () => {
    vi.stubGlobal('document', { cookie: adCookie() })
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { globalPrivacyControl: true })
    const granted = await attributionForSubmit({ consent: () => ({ adUserData: 'granted' }) })
    expect(granted).toMatchObject({ consentAdUserData: 'granted', gclid: 'Cj0KCQjw-gclid_1234' })
    expect(granted.fbp).toBe('fb.1.1699999999999.abc123')
    expect(granted.consentAdPersonalization).toBeUndefined()
    const silent = await attributionForSubmit({ consent: () => ({ analyticsStorage: 'granted' }) })
    for (const key of adKeys) {
      expect(silent[key]).toBeUndefined()
    }
    expect(silent.consentAdUserData).toBeUndefined()
  })

  it('omits ad identifiers when the consent callback denies adUserData', async () => {
    vi.stubGlobal('document', { cookie: adCookie() })
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { globalPrivacyControl: false })
    const denied = await attributionForSubmit({ consent: () => ({ adUserData: 'denied' }) })
    for (const key of adKeys) {
      expect(denied[key]).toBeUndefined()
    }
    const unknown = await attributionForSubmit({ consent: () => ({ adUserData: 'unknown' }) })
    expect(unknown.gclid).toBe('Cj0KCQjw-gclid_1234')
    expect(unknown.srsltid).toBe('AfmBOoqSrsltid12345')
    expect((await attributionForSubmit()).fbc).toBe('fb.1.1699999999999.xyz789')
  })

  it('skips GA identity when analyticsStorage is denied', async () => {
    vi.stubGlobal('document', { cookie: '' })
    const gtag = identityGtag()
    vi.stubGlobal('window', { gtag })
    const result = await attributionForSubmit({
      consent: () => ({ analyticsStorage: 'denied' }),
      measurementId: 'G-TEST',
    })
    expect(gtag).not.toHaveBeenCalled()
    expect(result.gaClientId).toBeUndefined()
    expect(result.consentAnalyticsStorage).toBe('denied')
    const allowed = await attributionForSubmit({
      consent: () => ({ analyticsStorage: 'granted' }),
      measurementId: 'G-TEST',
    })
    expect(allowed.gaClientId).toBe('123.456')
  })
})

describe('attributionForSubmit', () => {
  it('returns the sanitized merged last touch and never throws', async () => {
    vi.stubGlobal('document', { cookie: cookieHeaderFor() })
    vi.stubGlobal('window', {
      gtag: () => {
        throw new Error('boom')
      },
    })
    const result = await attributionForSubmit({ measurementId: 'G-TEST' })
    expect(result.utmSource).toBe('newsletter')
  })

  it('is SSR-safe', async () => {
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('document', undefined)
    await expect(attributionForSubmit()).resolves.toEqual({})
  })
})

describe('consentDefaults', () => {
  it('pushes an arguments-like consent default entry to window.dataLayer before gtag is defined', () => {
    const dataLayer: unknown[] = []
    vi.stubGlobal('window', { dataLayer })
    consentDefaults({
      adPersonalization: 'denied',
      adStorage: 'denied',
      adUserData: 'denied',
      analyticsStorage: 'denied',
    })
    expect(dataLayer).toHaveLength(1)
    const [entry] = dataLayer as [ArrayLike<unknown>]
    expect(Array.isArray(entry)).toBe(false)
    expect(Array.from(entry)).toEqual([
      'consent',
      'default',
      {
        ad_personalization: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        analytics_storage: 'denied',
        wait_for_update: 500,
      },
    ])
  })

  it('creates window.dataLayer when missing and honours region, waitForUpdateMs, redaction and passthrough', () => {
    vi.stubGlobal('window', {})
    consentDefaults({
      adPersonalization: 'denied',
      adsDataRedaction: true,
      adStorage: 'granted',
      adUserData: 'denied',
      analyticsStorage: 'granted',
      region: ['US-CA'],
      urlPassthrough: false,
      waitForUpdateMs: 2000,
    })
    const dataLayer = (window as unknown as { dataLayer: unknown[] }).dataLayer
    expect(dataLayer).toHaveLength(3)
    expect(Array.from(dataLayer[0] as ArrayLike<unknown>)).toEqual([
      'consent',
      'default',
      {
        ad_personalization: 'denied',
        ad_storage: 'granted',
        ad_user_data: 'denied',
        analytics_storage: 'granted',
        region: ['US-CA'],
        wait_for_update: 2000,
      },
    ])
    expect(Array.from(dataLayer[1] as ArrayLike<unknown>)).toEqual([
      'set',
      'ads_data_redaction',
      true,
    ])
    expect(Array.from(dataLayer[2] as ArrayLike<unknown>)).toEqual([
      'set',
      'url_passthrough',
      false,
    ])
  })

  it('does nothing when window is undefined', () => {
    vi.stubGlobal('window', undefined)
    expect(() =>
      consentDefaults({
        adPersonalization: 'denied',
        adStorage: 'denied',
        adUserData: 'denied',
        analyticsStorage: 'denied',
      }),
    ).not.toThrow()
  })
})

describe('consentDefaults with a host dataLayer that is not an array', () => {
  it('leaves it alone instead of throwing', () => {
    const dataLayer = { push: 'not a function' }
    vi.stubGlobal('window', { dataLayer })
    expect(() =>
      consentDefaults({
        adPersonalization: 'denied',
        adStorage: 'denied',
        adUserData: 'denied',
        analyticsStorage: 'denied',
      }),
    ).not.toThrow()
    expect((window as unknown as { dataLayer: unknown }).dataLayer).toBe(dataLayer)
  })
})

describe('trackClient', () => {
  it('returns null for a reserved event name', () => {
    vi.stubGlobal('window', { gtag: vi.fn() })
    expect(trackClient('ad_click')).toBeNull()
  })

  it('returns null for an invalid event name', () => {
    vi.stubGlobal('window', { gtag: vi.fn() })
    expect(trackClient('123-bad')).toBeNull()
  })

  it('returns null when no gtag is present', () => {
    vi.stubGlobal('window', {})
    expect(trackClient('generate_lead')).toBeNull()
  })

  it('fires gtag with the event id and returns it', () => {
    const gtag = vi.fn()
    vi.stubGlobal('window', { gtag })
    const eventId = trackClient('generate_lead', { value: 10 })
    expect(eventId).toMatch(/^[a-f0-9-]{36}$/)
    expect(gtag).toHaveBeenCalledWith('event', 'generate_lead', { event_id: eventId, value: 10 })
  })

  it('refuses a parameter value that looks like an email address', () => {
    const gtag = vi.fn()
    vi.stubGlobal('window', { gtag })
    expect(trackClient('generate_lead', { note: 'jane@example.com' })).toBeNull()
    expect(gtag).not.toHaveBeenCalled()
  })

  it('reuses a caller-supplied event id for Meta deduplication', () => {
    const gtag = vi.fn()
    vi.stubGlobal('window', { gtag })
    const eventId = trackClient('generate_lead', {}, { eventId: 'shared-id-1' })
    expect(eventId).toBe('shared-id-1')
    expect(gtag).toHaveBeenCalledWith('event', 'generate_lead', { event_id: 'shared-id-1' })
  })

  it('still fires when event id generation fails', () => {
    const gtag = vi.fn()
    vi.stubGlobal('window', { gtag })
    vi.stubGlobal(
      'crypto',
      new Proxy(
        {},
        {
          get() {
            throw new Error('hostile crypto')
          },
        },
      ),
    )
    expect(() => trackClient('generate_lead')).not.toThrow()
    expect(trackClient('generate_lead')).toMatch(/^[a-f0-9-]{36}$/)
  })

  it('returns null instead of throwing when gtag itself throws', () => {
    vi.stubGlobal('window', {
      gtag: () => {
        throw new Error('boom')
      },
    })
    expect(trackClient('generate_lead')).toBeNull()
  })
})

describe('createEventId', () => {
  it('uses crypto.randomUUID when available', () => {
    expect(createEventId()).toMatch(/^[a-f0-9-]{36}$/)
  })

  it('falls back to crypto.getRandomValues when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    })
    const id = createEventId()
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  })

  it('works without crypto at all', () => {
    vi.stubGlobal('crypto', undefined)
    expect(createEventId()).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    )
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('unavailable')
      },
    })
    expect(createEventId()).toMatch(/^[a-f0-9-]{36}$/)
  })

  it('falls back when randomUUID throws on a non-secure origin', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
      randomUUID: () => {
        throw new DOMException('randomUUID requires a secure context')
      },
    })
    expect(createEventId()).toMatch(/^[a-f0-9-]{36}$/)
  })
})
