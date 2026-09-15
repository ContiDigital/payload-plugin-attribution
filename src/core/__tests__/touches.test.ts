import { describe, expect, it } from 'vitest'

import type { Attribution } from '../sanitize.js'

import { CLICK_ID_KEYS } from '../sanitize.js'
import {
  CLICK_WINDOW_DAYS,
  cookieMaxAgeSeconds,
  decodeTouches,
  DEFAULT_COOKIE_NAME,
  encodeTouches,
  FREE_TEXT_DROP_ORDER,
  mergeTouch,
  type Touches,
} from '../touches.js'

const DAY_MS = 86_400_000
const dayN = (n: number): Date => new Date(Date.UTC(2026, 0, 1 + n))

describe('touches constants', () => {
  it('exposes the default cookie name and click id keys', () => {
    expect(DEFAULT_COOKIE_NAME).toBe('attr_touch')
    expect(CLICK_ID_KEYS).toEqual([
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
    ])
    expect(CLICK_WINDOW_DAYS).toBe(90)
  })
})

describe('mergeTouch', () => {
  it('1. sets first and last equal with clickCapturedAt from a fresh paid click', () => {
    const t0 = dayN(0)
    const result = mergeTouch(null, { capturedAt: t0.toISOString(), gclid: 'G'.repeat(20) }, t0)
    expect(result.first).toEqual(result.last)
    expect(result.last.clickCapturedAt).toBe(t0.toISOString())
    expect(result.last.gclid).toBe('G'.repeat(20))
  })

  it('2. carries a paid click through a later organic referral within the window', () => {
    const t0 = dayN(0)
    const t2 = dayN(2)
    const first = mergeTouch(null, { capturedAt: t0.toISOString(), gclid: 'G'.repeat(20) }, t0)
    const second = mergeTouch(
      first,
      { capturedAt: t2.toISOString(), referrerHost: 'google.com' },
      t2,
    )
    expect(second.last.referrerHost).toBe('google.com')
    expect(second.last.gclid).toBe('G'.repeat(20))
    expect(second.last.clickCapturedAt).toBe(t0.toISOString())
  })

  it('3. does not carry the click id once the 90 day window has elapsed', () => {
    const t0 = dayN(0)
    const t91 = dayN(91)
    const first = mergeTouch(null, { capturedAt: t0.toISOString(), gclid: 'G'.repeat(20) }, t0)
    const second = mergeTouch(
      first,
      { capturedAt: t91.toISOString(), referrerHost: 'google.com' },
      t91,
    )
    expect(second.last.gclid).toBeUndefined()
    expect(second.last.referrerHost).toBe('google.com')
  })

  it('4. a new click id on day 5 replaces the carried one and resets clickCapturedAt', () => {
    const t0 = dayN(0)
    const t5 = dayN(5)
    const first = mergeTouch(null, { capturedAt: t0.toISOString(), gclid: 'G'.repeat(20) }, t0)
    const second = mergeTouch(first, { capturedAt: t5.toISOString(), gclid: 'H'.repeat(20) }, t5)
    expect(second.last.gclid).toBe('H'.repeat(20))
    expect(second.last.clickCapturedAt).toBe(t5.toISOString())
  })

  it('strips a stray clickCapturedAt that arrives without any click id', () => {
    const t0 = dayN(0)
    const t2 = dayN(2)
    const first = mergeTouch(null, { capturedAt: t0.toISOString(), referrerHost: 'bing.com' }, t0)
    expect(first.last.clickCapturedAt).toBeUndefined()
    const second = mergeTouch(
      first,
      {
        capturedAt: t2.toISOString(),
        // No click id key, but a bogus clickCapturedAt smuggled in anyway.
        clickCapturedAt: t2.toISOString(),
        referrerHost: 'bing.com',
      },
      t2,
    )
    expect(second.last.clickCapturedAt).toBeUndefined()
  })

  it('never re-anchors clickCapturedAt when the same click id arrives again', () => {
    const gclid = 'G'.repeat(20)
    const t0 = dayN(0)
    const paid = mergeTouch(null, { capturedAt: t0.toISOString(), gclid, utmSource: 'google' }, t0)
    for (const day of [2, 89]) {
      const at = dayN(day)
      const again = mergeTouch(paid, { capturedAt: at.toISOString(), gclid }, at)
      expect(again.last.gclid).toBe(gclid)
      expect(again.last.clickCapturedAt).toBe(t0.toISOString())
    }
    const other = mergeTouch(
      paid,
      { capturedAt: dayN(3).toISOString(), gclid: 'H'.repeat(20) },
      dayN(3),
    )
    expect(other.last.clickCapturedAt).toBe(dayN(3).toISOString())
  })

  it('carries srsltid through a later organic visit like other click ids', () => {
    const t0 = dayN(0)
    const srsltid = 'AfmBOoqSrsltid12345'
    const first = mergeTouch(null, { capturedAt: t0.toISOString(), srsltid }, t0)
    expect(first.last.clickCapturedAt).toBe(t0.toISOString())
    const organic = mergeTouch(first, { referrerHost: 'google.com' }, dayN(2))
    expect(organic.last.srsltid).toBe(srsltid)
    expect(organic.last.clickCapturedAt).toBe(t0.toISOString())
  })

  it('5. first never changes after creation', () => {
    const t0 = dayN(0)
    const t2 = dayN(2)
    const t40 = dayN(40)
    const first = mergeTouch(null, { capturedAt: t0.toISOString(), gclid: 'G'.repeat(20) }, t0)
    const second = mergeTouch(
      first,
      { capturedAt: t2.toISOString(), referrerHost: 'google.com' },
      t2,
    )
    const third = mergeTouch(
      second,
      { capturedAt: t40.toISOString(), referrerHost: 'bing.com' },
      t40,
    )
    expect(second.first).toEqual(first.first)
    expect(third.first).toEqual(first.first)
  })
})

describe('decodeTouches', () => {
  it('6. tolerates a capturedAt a few seconds in the future under the default skew', () => {
    const now = dayN(10)
    const future = new Date(now.getTime() + 5_000).toISOString()
    const touches: Touches = {
      first: { capturedAt: future, firstSeenAt: future },
      last: { capturedAt: future },
    }
    const encoded = encodeURIComponent(JSON.stringify(touches))
    expect(decodeTouches(encoded, now)).not.toBeNull()
  })

  it.each([
    ['malformed percent-encoding', '%'],
    ['invalid JSON', encodeURIComponent('{not json')],
    ['a top-level array', encodeURIComponent(JSON.stringify([]))],
    [
      'a first touch that fails sanitize',
      encodeURIComponent(JSON.stringify({ first: { gclid: 'short' }, last: {} })),
    ],
  ])('7. returns null for %s', (_label, value) => {
    expect(decodeTouches(value, dayN(0))).toBeNull()
  })

  it('drops consent and GA identity keys, which the proxy never writes', () => {
    const now = dayN(10)
    const iso = now.toISOString()
    const forged = {
      capturedAt: iso,
      consentAdUserData: 'granted',
      consentAnalyticsStorage: 'granted',
      gaClientId: '123.456',
      gaSessionId: '1757779200',
      gaSessionNumber: 2,
      utmSource: 'mail',
    }
    const decoded = decodeTouches(
      encodeURIComponent(JSON.stringify({ first: { ...forged, firstSeenAt: iso }, last: forged })),
      now,
    )
    for (const touch of [decoded?.first, decoded?.last]) {
      expect(touch).toMatchObject({ utmSource: 'mail' })
      for (const key of [
        'consentAdUserData',
        'consentAnalyticsStorage',
        'gaClientId',
        'gaSessionId',
        'gaSessionNumber',
        'gaSessionStartedAt',
      ] as const) {
        expect(touch?.[key], key).toBeUndefined()
      }
    }
  })

  it('7b. returns null for undefined input', () => {
    expect(decodeTouches(undefined, dayN(0))).toBeNull()
  })

  it('round-trips a value produced by encodeTouches', () => {
    const t0 = dayN(0)
    const merged = mergeTouch(null, { capturedAt: t0.toISOString(), gclid: 'G'.repeat(20) }, t0)
    const encoded = encodeTouches(merged)
    expect(encoded).not.toBeNull()
    const decoded = decodeTouches(encoded ?? undefined, t0)
    expect(decoded?.last.gclid).toBe('G'.repeat(20))
  })
})

describe('cookieMaxAgeSeconds', () => {
  it('8. anchors to a same-day click and returns exactly 90 days in seconds', () => {
    const t0 = dayN(0)
    const t89 = dayN(89)
    const first = mergeTouch(
      null,
      { capturedAt: t0.toISOString(), firstSeenAt: t0.toISOString(), referrerHost: 'bing.com' },
      t0,
    )
    const clicked = mergeTouch(first, { capturedAt: t89.toISOString(), gclid: 'G'.repeat(20) }, t89)
    expect(cookieMaxAgeSeconds(clicked, t89)).toBe(90 * 86400)
  })

  it('returns 0 once the anchor is more than 90 days old', () => {
    const t0 = dayN(0)
    const t200 = dayN(200)
    const first = mergeTouch(null, { capturedAt: t0.toISOString() }, t0)
    expect(cookieMaxAgeSeconds(first, t200)).toBe(0)
  })

  it('caps a far-future anchor at 400 days in seconds', () => {
    const t0 = dayN(0)
    const farFuture = new Date(t0.getTime() + 500 * DAY_MS)
    const touches: Touches = {
      first: { capturedAt: farFuture.toISOString() },
      last: { capturedAt: farFuture.toISOString() },
    }
    expect(cookieMaxAgeSeconds(touches, t0)).toBe(400 * 86400)
  })
})

describe('encodeTouches', () => {
  it('9. drops free text fields in priority order, never dropping click ids, fbc, fbp or gaClientId', () => {
    const t0 = dayN(0).toISOString()
    const longText = 'x'.repeat(150)
    const first: Attribution = { capturedAt: t0, firstSeenAt: t0, gclid: 'G'.repeat(20) }
    const last: Attribution = {
      capturedAt: t0,
      fbc: `fb.1.1700000000000.${'a'.repeat(50)}`,
      fbclid: 'F'.repeat(20),
      fbp: 'fb.1.1700000000000.1234567890',
      firstSeenAt: t0,
      gaClientId: 'GA1.1.123456789.1700000000',
      gclid: 'G'.repeat(20),
      landingPath: `/${'a'.repeat(280)}`,
      referrerHost: `${'a'.repeat(90)}.example.com`,
      utmCampaign: longText,
      utmContent: longText,
      utmTerm: longText,
    }
    const touches: Touches = { first, last }

    expect(encodeTouches(touches, 100_000)).not.toBeNull()

    const minimalLast: Attribution = {
      capturedAt: last.capturedAt,
      fbc: last.fbc,
      fbclid: last.fbclid,
      fbp: last.fbp,
      firstSeenAt: last.firstSeenAt,
      gaClientId: last.gaClientId,
      gclid: last.gclid,
    }
    const minimalSize = encodeURIComponent(JSON.stringify({ first, last: minimalLast })).length
    const budget = minimalSize + 40

    const encoded = encodeTouches(touches, budget)
    expect(encoded).not.toBeNull()
    expect(encoded!.length).toBeLessThanOrEqual(budget)

    const decoded = JSON.parse(decodeURIComponent(encoded!)) as Touches
    expect(decoded.last.gclid).toBe(last.gclid)
    expect(decoded.last.fbclid).toBe(last.fbclid)
    expect(decoded.last.fbc).toBe(last.fbc)
    expect(decoded.last.fbp).toBe(last.fbp)
    expect(decoded.last.gaClientId).toBe(last.gaClientId)
    expect(decoded.last.utmContent).toBeUndefined()
    expect(decoded.last.utmTerm).toBeUndefined()
    expect(decoded.last.utmCampaign).toBeUndefined()
    expect(decoded.last.landingPath).toBeUndefined()
    expect(decoded.last.referrerHost).toBeUndefined()
  })

  it('returns null when even the minimal touch without click data cannot fit maxBytes', () => {
    const t0 = dayN(0).toISOString()
    const touch: Attribution = { capturedAt: t0, firstSeenAt: t0, gclid: 'G'.repeat(400) }
    const touches: Touches = { first: touch, last: touch }
    expect(encodeTouches(touches, 10)).toBeNull()
  })

  it('drops click data rather than returning null when it alone does not fit', () => {
    const t0 = dayN(0).toISOString()
    const base: Attribution = { capturedAt: t0, firstSeenAt: t0 }
    const touch: Attribution = { ...base, clickCapturedAt: t0, gclid: 'G'.repeat(400) }
    const budget = encodeURIComponent(JSON.stringify({ first: base, last: base })).length
    const encoded = encodeTouches({ first: touch, last: touch }, budget)
    expect(encoded).not.toBeNull()
    expect(JSON.parse(decodeURIComponent(encoded!))).toEqual({ first: base, last: base })
  })

  it('keeps every host cookie budget with five 500 character click ids', () => {
    const t0 = dayN(0).toISOString()
    const id = (letter: string): string => letter.repeat(500)
    const touch: Attribution = {
      capturedAt: t0,
      clickCapturedAt: t0,
      fbc: `fb.1.1700000000000.${id('f')}`,
      fbclid: id('F'),
      fbp: 'fb.1.1700000000000.1234567890',
      firstSeenAt: t0,
      gbraid: id('B'),
      gclid: id('G'),
      msclkid: id('M'),
      wbraid: id('W'),
    }
    const encoded = encodeTouches({ first: touch, last: touch })
    expect(encoded).not.toBeNull()
    expect(encoded!.length).toBeLessThanOrEqual(3800)
    const decoded = JSON.parse(decodeURIComponent(encoded!)) as Touches
    for (const key of ['fbc', 'fbp', 'msclkid', 'fbclid'] as const) {
      expect(decoded.last[key]).toBeUndefined()
    }
    expect(decoded.last.gclid).toBe(touch.gclid)
    expect(decoded.last.clickCapturedAt).toBe(t0)

    const onlyGclid: Attribution = {
      capturedAt: t0,
      clickCapturedAt: t0,
      firstSeenAt: t0,
      gclid: touch.gclid,
    }
    const budget = encodeURIComponent(JSON.stringify({ first: onlyGclid, last: onlyGclid })).length
    const tight = encodeTouches({ first: touch, last: touch }, budget)
    expect(JSON.parse(decodeURIComponent(tight!))).toEqual({ first: onlyGclid, last: onlyGclid })
  })

  it('drops click data in order, keeping gclid as the very last resort', () => {
    const t0 = dayN(0).toISOString()
    const id = (key: string): string => `${key}_0123456789`
    const base: Attribution = { capturedAt: t0, firstSeenAt: t0 }
    const last: Attribution = {
      ...base,
      clickCapturedAt: t0,
      dclid: id('dclid'),
      fbc: `fb.1.1700000000000.${id('fbc')}`,
      fbclid: id('fbclid'),
      fbp: 'fb.1.1700000000000.1234567890',
      gbraid: id('gbraid'),
      gclid: id('gclid'),
      liFatId: id('liFatId'),
      msclkid: id('msclkid'),
      srsltid: id('srsltid'),
      ttclid: id('ttclid'),
      twclid: id('twclid'),
      wbraid: id('wbraid'),
    }
    const keep = (...keys: ('fbclid' | 'gbraid' | 'gclid' | 'wbraid')[]): Attribution => ({
      ...base,
      clickCapturedAt: t0,
      ...Object.fromEntries(keys.map((key) => [key, last[key]])),
    })
    for (const expectedLast of [
      keep('gclid', 'gbraid', 'wbraid', 'fbclid'),
      keep('gclid', 'gbraid', 'wbraid'),
      keep('gclid', 'gbraid'),
      keep('gclid'),
    ]) {
      const budget = encodeURIComponent(JSON.stringify({ first: base, last: expectedLast })).length
      const encoded = encodeTouches({ first: base, last }, budget)
      expect(JSON.parse(decodeURIComponent(encoded!))).toEqual({ first: base, last: expectedLast })
    }
    const minimal = encodeURIComponent(JSON.stringify({ first: base, last: keep('gclid') })).length
    expect(
      JSON.parse(decodeURIComponent(encodeTouches({ first: base, last }, minimal - 1)!)),
    ).toEqual({ first: base, last: base })
  })

  it('truncates landingPath only at a whole percent escape', () => {
    const t0 = dayN(0).toISOString()
    for (const [path, expected] of [
      [`/${'a'.repeat(297)}%2Fbbbbbbbbbb`, `/${'a'.repeat(297)}`],
      [`/${'a'.repeat(298)}%2Fbbbbbbbbbb`, `/${'a'.repeat(298)}`],
      [`/${'a'.repeat(296)}%2Fbbbbbbbbbb`, `/${'a'.repeat(296)}%2F`],
      [`/${'a'.repeat(294)}%E2%82%ACbbbbbbbbbb`, `/${'a'.repeat(294)}`],
    ] as const) {
      const touch: Attribution = { capturedAt: t0, firstSeenAt: t0, landingPath: path }
      const encoded = encodeTouches({ first: touch, last: touch })
      const decoded = JSON.parse(decodeURIComponent(encoded!)) as Touches
      expect(decoded.last.landingPath).toBe(expected)
      expect(() => decodeURIComponent(decoded.last.landingPath!)).not.toThrow()
    }
  })

  it('caps free text at 150 and landing path at 300 before dropping fields', () => {
    const t0 = dayN(0).toISOString()
    const touch: Attribution = {
      capturedAt: t0,
      firstSeenAt: t0,
      landingPath: `/${'z'.repeat(400)}`,
      utmCampaign: 'y'.repeat(200),
    }
    const touches: Touches = { first: touch, last: touch }
    const encoded = encodeTouches(touches)
    expect(encoded).not.toBeNull()
    const decoded = JSON.parse(decodeURIComponent(encoded!)) as Touches
    expect(decoded.last.utmCampaign).toHaveLength(150)
    expect(decoded.last.landingPath).toHaveLength(300)
  })

  it('defaults maxBytes to 3800', () => {
    const t0 = dayN(0).toISOString()
    const touch: Attribution = { capturedAt: t0, firstSeenAt: t0, gclid: 'G'.repeat(20) }
    const touches: Touches = { first: touch, last: touch }
    const encoded = encodeTouches(touches)
    expect(encoded).not.toBeNull()
    expect(encoded!.length).toBeLessThanOrEqual(3800)
  })

  it('shrinks all the way to the minimal touch when every free-text field is maxed out', () => {
    const t0 = dayN(0).toISOString()
    const longText = 'x'.repeat(150)
    const last: Attribution = {
      capturedAt: t0,
      fbc: `fb.1.1700000000000.${'a'.repeat(50)}`,
      fbclid: 'F'.repeat(20),
      fbp: 'fb.1.1700000000000.1234567890',
      firstSeenAt: t0,
      gaClientId: 'GA1.1.123456789.1700000000',
      gclid: 'G'.repeat(20),
      referrerHost: `${'a'.repeat(90)}.example.com`,
      utmCampaign: longText,
      utmContent: longText,
      utmCreativeFormat: longText,
      utmId: longText,
      utmMarketingTactic: longText,
      utmMedium: longText,
      utmSource: longText,
      utmSourcePlatform: longText,
      utmTerm: longText,
    }
    const first: Attribution = { capturedAt: t0, firstSeenAt: t0, gclid: 'G'.repeat(20) }
    const touches: Touches = { first, last }

    const minimalLast: Attribution = {
      capturedAt: last.capturedAt,
      fbc: last.fbc,
      fbclid: last.fbclid,
      fbp: last.fbp,
      firstSeenAt: last.firstSeenAt,
      gaClientId: last.gaClientId,
      gclid: last.gclid,
    }
    const minimalSize = encodeURIComponent(JSON.stringify({ first, last: minimalLast })).length
    const budget = minimalSize + 10

    const encoded = encodeTouches(touches, budget)
    expect(encoded).not.toBeNull()
    expect(encoded!.length).toBeLessThanOrEqual(budget)

    const decoded = JSON.parse(decodeURIComponent(encoded!)) as Touches
    expect(decoded.last.gclid).toBe(last.gclid)
    expect(decoded.last.fbclid).toBe(last.fbclid)
    expect(decoded.last.fbc).toBe(last.fbc)
    expect(decoded.last.fbp).toBe(last.fbp)
    expect(decoded.last.gaClientId).toBe(last.gaClientId)
    for (const key of [
      'utmContent',
      'utmTerm',
      'utmCampaign',
      'referrerHost',
      'utmId',
      'utmMarketingTactic',
      'utmCreativeFormat',
      'utmSourcePlatform',
      'utmMedium',
      'utmSource',
    ] as const) {
      expect(decoded.last[key]).toBeUndefined()
    }
  })

  it('never splits a surrogate pair at the free-text cap boundary', () => {
    const t0 = dayN(0).toISOString()
    const emoji = '\u{1F600}'
    const touch: Attribution = {
      capturedAt: t0,
      firstSeenAt: t0,
      // 149 ascii chars + a 2 code unit emoji = 151 code units, one over the 150 cap,
      // so a naive slice(0, 150) would keep the emoji's lone high surrogate.
      utmCampaign: `${'x'.repeat(149)}${emoji}`,
    }
    const touches: Touches = { first: touch, last: touch }
    const encoded = encodeTouches(touches)
    expect(encoded).not.toBeNull()
    const decoded = JSON.parse(decodeURIComponent(encoded!)) as Touches
    const value = decoded.last.utmCampaign ?? ''
    expect(value).toBe('x'.repeat(149))
    const lastCode = value.charCodeAt(value.length - 1)
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false)
  })
})

describe('FREE_TEXT_DROP_ORDER', () => {
  it('covers every free-text field exactly once, so it cannot drift from what capField caps', () => {
    const expected = new Set([
      'landingPath',
      'referrerHost',
      'utmCampaign',
      'utmContent',
      'utmCreativeFormat',
      'utmId',
      'utmMarketingTactic',
      'utmMedium',
      'utmSource',
      'utmSourcePlatform',
      'utmTerm',
    ])
    expect(FREE_TEXT_DROP_ORDER.length).toBe(expected.size)
    expect(new Set(FREE_TEXT_DROP_ORDER)).toEqual(expected)
  })
})

describe('per-key click carry', () => {
  const idFor = (key: string, suffix = ''): string => `${key}_Click0123456789${suffix}`
  const pairs = CLICK_ID_KEYS.flatMap((a) =>
    CLICK_ID_KEYS.filter((b) => b !== a).map((b) => [a, b] as const),
  )

  it.each(pairs)('a carried %s survives a later %s click with its own click time', (a, b) => {
    const t0 = dayN(0)
    const t3 = dayN(3)
    const clickA = mergeTouch(null, { [a]: idFor(a), capturedAt: t0.toISOString() }, t0)
    const clickB = mergeTouch(clickA, { [b]: idFor(b), capturedAt: t3.toISOString() }, t3)
    expect(clickB.last[a]).toBe(idFor(a))
    expect(clickB.last[b]).toBe(idFor(b))
    expect(clickB.clickTimes?.[a]).toBe(t0.toISOString())
    expect(clickB.clickTimes?.[b]).toBe(t3.toISOString())

    const decoded = decodeTouches(encodeTouches(clickB) ?? undefined, t3)
    expect(decoded?.last[a]).toBe(idFor(a))
    expect(decoded?.clickTimes?.[a]).toBe(t0.toISOString())

    // Each key expires 90 days after its own click, not after the latest click of any kind.
    const t91 = dayN(91)
    const organic = mergeTouch(
      clickB,
      { capturedAt: t91.toISOString(), referrerHost: 'x.test' },
      t91,
    )
    expect(organic.last[a]).toBeUndefined()
    expect(organic.last[b]).toBe(idFor(b))
    expect(decodeTouches(encodeTouches(clickB) ?? undefined, dayN(92))?.last[a]).toBeUndefined()

    const replaced = mergeTouch(
      clickB,
      { [a]: idFor(a, 'x'), capturedAt: dayN(5).toISOString() },
      dayN(5),
    )
    expect(replaced.last[a]).toBe(idFor(a, 'x'))
    expect(replaced.clickTimes?.[a]).toBe(dayN(5).toISOString())
    expect(replaced.last[b]).toBe(idFor(b))
    expect(replaced.clickTimes?.[b]).toBe(t3.toISOString())
  })

  it('anchors clickCapturedAt on the Google click id when one is carried', () => {
    const gclid = mergeTouch(
      null,
      { capturedAt: dayN(0).toISOString(), gclid: 'G'.repeat(20) },
      dayN(0),
    )
    const fb = mergeTouch(
      gclid,
      { capturedAt: dayN(4).toISOString(), fbclid: 'F'.repeat(20) },
      dayN(4),
    )
    expect(fb.last.clickCapturedAt).toBe(dayN(0).toISOString())
    const onlyFb = mergeTouch(
      null,
      { capturedAt: dayN(4).toISOString(), fbclid: 'F'.repeat(20) },
      dayN(4),
    )
    expect(onlyFb.last.clickCapturedAt).toBe(dayN(4).toISOString())
  })

  it('carries fbc with a carried fbclid and drops it when that fbclid expires', () => {
    const fbclid = 'F'.repeat(20)
    const fbc = `fb.1.1767225600000.${fbclid}`
    const clicked = mergeTouch(null, { capturedAt: dayN(0).toISOString(), fbc, fbclid }, dayN(0))
    const google = mergeTouch(
      clicked,
      { capturedAt: dayN(2).toISOString(), gclid: 'G'.repeat(20) },
      dayN(2),
    )
    expect(google.last).toMatchObject({ fbc, fbclid, gclid: 'G'.repeat(20) })
    const decoded = decodeTouches(encodeTouches(google) ?? undefined, dayN(92))
    expect(decoded?.last.gclid).toBe('G'.repeat(20))
    expect(decoded?.last.fbclid).toBeUndefined()
    expect(decoded?.last.fbc).toBeUndefined()
  })
})
