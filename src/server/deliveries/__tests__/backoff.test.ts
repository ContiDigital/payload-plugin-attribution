import { afterEach, describe, expect, it, vi } from 'vitest'

import { nextBackoffMs } from '../backoff.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

afterEach(() => {
  vi.restoreAllMocks()
})

describe('nextBackoffMs', () => {
  it.each<[number, number, number]>([
    [1, 0, 24_000],
    [1, 0.5, 30_000],
    [2, 0.5, 60_000],
    [6, 0.5, 960_000],
    [7, 0.5, 30 * MINUTE],
    [10, 0, 24 * MINUTE],
    [10, 0.5, 30 * MINUTE],
    [0, 0.5, 30_000],
  ])('attempt %i with random %f waits %i ms', (attempt, random, expected) => {
    vi.spyOn(Math, 'random').mockReturnValue(random)
    expect(nextBackoffMs(attempt)).toBe(expected)
  })

  it('keeps attempt 1 between 24 and 36 seconds', () => {
    for (let sample = 0; sample < 500; sample++) {
      const wait = nextBackoffMs(1)
      expect(wait).toBeGreaterThanOrEqual(24_000)
      expect(wait).toBeLessThanOrEqual(36_000)
    }
  })

  it('caps attempt 10 at 30 minutes plus or minus 20 percent', () => {
    for (let sample = 0; sample < 500; sample++) {
      const wait = nextBackoffMs(10)
      expect(wait).toBeGreaterThanOrEqual(24 * MINUTE)
      expect(wait).toBeLessThanOrEqual(36 * MINUTE)
    }
  })

  it('honours retryAfterMs exactly', () => {
    expect(nextBackoffMs(1, 120_000)).toBe(120_000)
    expect(nextBackoffMs(9, 5_000)).toBe(5_000)
  })

  it('caps retryAfterMs at six hours', () => {
    expect(nextBackoffMs(1, 10 * HOUR)).toBe(6 * HOUR)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'ignores an unusable retryAfterMs of %f',
    (retryAfterMs) => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      expect(nextBackoffMs(1, retryAfterMs)).toBe(30_000)
    },
  )
})
