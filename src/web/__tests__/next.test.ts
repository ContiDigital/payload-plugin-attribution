import { NextRequest, NextResponse } from 'next/server.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureFromRequest } from '../capture.js'
import { attributionProxy } from '../next.js'

const campaignUrl = 'https://example.com/shows?utm_source=mail&utm_campaign=fall-show-2026'

const attributionCookies = (response: Response): string[] =>
  response.headers.getSetCookie().filter((cookie) => cookie.startsWith('attr_touch='))

afterEach(() => {
  vi.useRealTimers()
})

describe('attributionProxy', () => {
  it('keeps host redirect cookies byte-identical and appends one attribution cookie', async () => {
    const host = NextResponse.redirect('https://example.com/signed-out')
    host.headers.append('set-cookie', 'session=; Path=/; Max-Age=0')
    const res = await attributionProxy()(new NextRequest(campaignUrl), host)
    const cookies = res.headers.getSetCookie()
    expect(cookies[0]).toBe('session=; Path=/; Max-Age=0')
    expect(cookies).toHaveLength(2)
    expect(attributionCookies(res)).toHaveLength(1)
    expect(res.status).toBe(307)
  })

  it('keeps raw host cookies on NextResponse.next(), including same-named ones on other domains', async () => {
    const host = NextResponse.next()
    host.cookies.set('locale', 'en')
    const raw = [
      'session=abc+/def==; Path=/; HttpOnly',
      'clear=; Domain=example.com; Path=/; Max-Age=0',
      'clear=; Domain=shop.example.com; Path=/; Max-Age=0',
    ]
    for (const cookie of raw) {
      host.headers.append('set-cookie', cookie)
    }
    const before = host.headers.getSetCookie()
    const res = await attributionProxy()(new NextRequest(campaignUrl), host)
    const cookies = res.headers.getSetCookie()
    expect(cookies.slice(0, before.length)).toEqual(before)
    expect(cookies).toHaveLength(before.length + 1)
    for (const cookie of raw) {
      expect(cookies).toContain(cookie)
    }
    expect(cookies.some((cookie) => cookie.startsWith('locale=en'))).toBe(true)
    expect(attributionCookies(res)).toHaveLength(1)
    expect(res.headers.get('x-middleware-set-cookie') ?? '').not.toContain('attr_touch=')
  })

  it('keeps cookies on a plain Response, including percent-encoded values', async () => {
    const raw = ['token=a%2Fb%3D%3D; Path=/; Secure', 'theme=dark; Path=/']
    const headers = new Headers({ 'x-host': 'kept' })
    for (const cookie of raw) {
      headers.append('set-cookie', cookie)
    }
    const host = new Response('body text', { headers, status: 201 })
    const res = await attributionProxy()(new NextRequest(campaignUrl), host)
    const cookies = res.headers.getSetCookie()
    expect(cookies.slice(0, 2)).toEqual(raw)
    expect(cookies).toHaveLength(3)
    expect(attributionCookies(res)).toHaveLength(1)
    expect(res.status).toBe(201)
    expect(res.headers.get('x-host')).toBe('kept')
    expect(await res.text()).toBe('body text')
  })

  it('writes the same cookie bytes as captureFromRequest without double encoding', async () => {
    const at = new Date('2026-09-13T16:00:00Z')
    vi.useFakeTimers({ now: at, toFake: ['Date'] })
    const expected = await captureFromRequest(new Request(campaignUrl), {}, at)
    const res = await attributionProxy()(new NextRequest(campaignUrl))
    const [cookie] = attributionCookies(res)
    expect(cookie).toBeDefined()
    expect(cookie.split(';')[0]).toBe(expected.setCookie!.split(';')[0])
    expect(cookie).not.toContain('%25')
    expect(cookie).toContain('Path=/')
    expect(cookie).toBe(expected.setCookie)
    expect(cookie).toContain('Secure')
  })

  it('accepts an immutable Response.redirect() from the host', async () => {
    const redirect = Response.redirect('https://example.com/elsewhere', 302)
    const res = await attributionProxy()(new NextRequest(campaignUrl), redirect)
    expect(res).toBeInstanceOf(NextResponse)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://example.com/elsewhere')
    expect(attributionCookies(res)).toHaveLength(1)
  })

  it('preserves host redirects and headers on a NextResponse', async () => {
    const host = NextResponse.redirect('https://example.com/next')
    host.headers.set('x-host', 'preserved')
    const res = await attributionProxy()(new NextRequest(campaignUrl), host)
    expect(res).toBe(host)
    expect(res.status).toBe(307)
    expect(res.headers.get('x-host')).toBe('preserved')
    expect(attributionCookies(res)).toHaveLength(1)
  })

  it('sets no cookie on prefetch requests', async () => {
    const proxy = attributionProxy()
    const prefetches: Record<string, string>[] = [
      { 'next-router-prefetch': '1' },
      { purpose: 'prefetch' },
      { 'sec-purpose': 'prefetch;prerender' },
      { rsc: '1' },
    ]
    for (const headers of prefetches) {
      const res = await proxy(new NextRequest(campaignUrl, { headers }))
      expect(res.headers.getSetCookie()).toEqual([])
      expect(res.headers.get('cache-control')).toBeNull()
    }
  })

  it('marks responses that set the cookie private unless already private', async () => {
    const proxy = attributionProxy()
    const publicResponse = NextResponse.next({ headers: { 'cache-control': 'public, max-age=60' } })
    expect(
      (await proxy(new NextRequest(campaignUrl), publicResponse)).headers.get('cache-control'),
    ).toBe('private, no-store')
    const privateResponse = NextResponse.next({
      headers: { 'cache-control': 'private, max-age=5' },
    })
    expect(
      (await proxy(new NextRequest(campaignUrl), privateResponse)).headers.get('cache-control'),
    ).toBe('private, max-age=5')
    const scoped = NextResponse.next({
      headers: { 'cache-control': 'private="set-cookie", max-age=60' },
    })
    expect((await proxy(new NextRequest(campaignUrl), scoped)).headers.get('cache-control')).toBe(
      'private, no-store',
    )
  })

  it('passes cookie options through and validates them at construction', async () => {
    const res = await attributionProxy({ cookieDomain: 'example.com', cookieName: 'site_attr' })(
      new NextRequest('http://example.com/?utm_source=mail'),
    )
    const [cookie] = res.headers.getSetCookie()
    expect(cookie).toMatch(/^site_attr=/)
    expect(cookie).toContain('Domain=example.com')
    expect(cookie).not.toContain('Secure')
    expect(() => attributionProxy({ cookieName: 'bad name' })).toThrow(TypeError)
  })

  it('returns the host response without an attribution cookie when the consent hook throws', async () => {
    const host = NextResponse.redirect('https://example.com/welcome')
    host.headers.append('set-cookie', 'session=abc; Path=/')
    const proxy = attributionProxy({
      consent: () => {
        throw new SyntaxError('bad consent cookie')
      },
    })
    const res = await proxy(new NextRequest(campaignUrl), host)
    expect(res.status).toBe(307)
    expect(res.headers.getSetCookie()).toEqual(['session=abc; Path=/'])
    const rejected = await attributionProxy({ consent: () => Promise.reject(new Error('down')) })(
      new NextRequest(campaignUrl),
    )
    expect(attributionCookies(rejected)).toEqual([])
  })

  it('honours consent denial', async () => {
    const res = await attributionProxy({ consent: () => 'denied' })(new NextRequest(campaignUrl))
    expect(res.headers.getSetCookie()).toEqual([])
  })
})
