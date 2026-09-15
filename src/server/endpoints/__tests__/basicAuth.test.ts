import { describe, expect, it } from 'vitest'

import { feedAuthorized } from '../basicAuth.js'

const basic = (value: string): string => `Basic ${Buffer.from(value).toString('base64')}`

describe('feedAuthorized', () => {
  it('accepts matching credentials, including a password containing a colon', () => {
    expect(feedAuthorized(basic('user:pass:word'), 'user', 'pass:word')).toBe(true)
  })

  it('accepts a lower case scheme', () => {
    expect(feedAuthorized(basic('user:pass').replace('Basic', 'basic'), 'user', 'pass')).toBe(true)
  })

  it.each([
    ['a wrong password', basic('user:wrong'), 'user', 'pass'],
    ['a wrong user', basic('other:pass'), 'user', 'pass'],
    ['no header', null, 'user', 'pass'],
    ['a bearer token', 'Bearer dXNlcjpwYXNz', 'user', 'pass'],
    ['a malformed value', 'Basic !!!', 'user', 'pass'],
    ['an oversized header', `Basic ${'A'.repeat(5000)}`, 'user', 'pass'],
    ['no configured credentials', basic(':'), '', ''],
    ['no configured password', basic('user:'), 'user', ''],
    ['no configured username', basic(':pass'), '', 'pass'],
  ])('rejects %s', (_label, header, username, password) => {
    expect(feedAuthorized(header, username, password)).toBe(false)
  })
})
