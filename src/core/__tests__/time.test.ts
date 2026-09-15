import { describe, expect, it } from 'vitest'

import { ageMs, CLOCK_SKEW_TOLERANCE_MS, parseIso } from '../time.js'

describe('ageMs', () => {
  it('is five minutes of tolerance', () => {
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(300_000)
  })

  it.each([
    ['a positive age unchanged', 1_000, 61_000, 60_000],
    ['zero for a zero age', 5_000, 5_000, 0],
    ['zero within the skew tolerance', 200_000, 100_000, 0],
    ['zero at exactly the skew tolerance', 400_000, 100_000, 0],
    ['the negative age beyond the tolerance', 400_001, 100_000, -300_001],
    ['NaN for an unparsable start', Number.NaN, 100_000, Number.NaN],
  ])('returns %s', (_label, fromMs, toMs, expected) => {
    expect(ageMs(fromMs, toMs)).toBe(expected)
  })
})

describe('parseIso', () => {
  it.each([
    ['2026-09-14T12:00:00.000Z', Date.parse('2026-09-14T12:00:00.000Z')],
    ['not a date', undefined],
    [undefined, undefined],
  ])('parses %p', (value, expected) => {
    expect(parseIso(value)).toBe(expected)
  })
})
