import { describe, expect, it } from 'vitest'

import { requestContextFromHeaders } from '../requestContext.js'

describe('requestContextFromHeaders', () => {
  it('reads the user agent and ignores forwarded addresses without trustProxy', () => {
    const headers = new Headers({ 'user-agent': 'Vitest/1.0', 'x-forwarded-for': '203.0.113.7' })
    expect(requestContextFromHeaders(headers)).toEqual({ userAgent: 'Vitest/1.0' })
  })

  it.each([
    ['a single address', '203.0.113.7', '203.0.113.7'],
    ['the address appended by the nearest proxy', ' 203.0.113.7 , 10.0.0.1', '10.0.0.1'],
    ['the proxy address over a spoofed client entry', '1.2.3.4, 198.51.100.4', '198.51.100.4'],
    ['an IPv6 address', '203.0.113.7, 2001:db8::2', '2001:db8::2'],
  ])('takes the rightmost forwarded entry: %s', (_label, forwarded, expected) => {
    const headers = new Headers({ 'x-forwarded-for': forwarded })
    expect(requestContextFromHeaders(headers, { trustProxy: true })).toEqual({
      ipAddress: expected,
    })
  })

  it('reads a configured header and accepts IPv6', () => {
    const headers = new Headers({ 'cf-connecting-ip': '2001:db8::1', 'x-forwarded-for': '1.1.1.1' })
    expect(
      requestContextFromHeaders(headers, { ipHeader: 'cf-connecting-ip', trustProxy: true }),
    ).toEqual({ ipAddress: '2001:db8::1' })
  })

  it.each([
    [{ 'x-forwarded-for': 'unknown' }],
    [{ 'x-forwarded-for': '203.0.113.7, unknown' }],
    [{ 'x-forwarded-for': '203.0.113.7,' }],
    [{ 'x-forwarded-for': '' }],
    [{ 'user-agent': 'x'.repeat(1025) }],
    [{}],
  ])('drops invalid values %#', (init) => {
    expect(requestContextFromHeaders(new Headers(init), { trustProxy: true })).toEqual({})
  })
})
