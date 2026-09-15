import { describe, expect, it } from 'vitest'

import { retryAfterMs } from '../retryAfter.js'

const now = new Date('2026-09-14T12:00:00.000Z')

const headersWith = (value: string): Headers => new Headers({ 'retry-after': value })

describe('retryAfterMs', () => {
  it('returns undefined when there is no Retry-After header', () => {
    expect(retryAfterMs(new Headers(), now)).toBeUndefined()
  })

  it('parses a delay in seconds', () => {
    expect(retryAfterMs(headersWith('120'), now)).toBe(120_000)
  })

  it('parses zero seconds', () => {
    expect(retryAfterMs(headersWith('0'), now)).toBe(0)
  })

  it('parses a future HTTP date', () => {
    const future = new Date(now.getTime() + 30_000).toUTCString()
    const result = retryAfterMs(headersWith(future), now)
    expect(result).toBeGreaterThan(29_000)
    expect(result).toBeLessThanOrEqual(30_000)
  })

  it('returns undefined for a negative number', () => {
    expect(retryAfterMs(headersWith('-5'), now)).toBeUndefined()
  })

  it('returns undefined for a non-numeric, non-date string', () => {
    expect(retryAfterMs(headersWith('abc'), now)).toBeUndefined()
  })

  it('returns undefined for a past HTTP date', () => {
    const past = new Date(now.getTime() - 60_000).toUTCString()
    expect(retryAfterMs(headersWith(past), now)).toBeUndefined()
  })
})
