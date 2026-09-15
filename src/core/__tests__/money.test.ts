import { describe, expect, it } from 'vitest'

import { currencyDigits, isMinorUnits, toMajorUnits } from '../money.js'

describe('currencyDigits', () => {
  it.each([
    ['USD', 2],
    ['EUR', 2],
    ['JPY', 0],
    ['KRW', 0],
    ['VND', 0],
    ['CLP', 0],
    ['ISK', 0],
    ['UGX', 0],
    ['PYG', 0],
    ['XOF', 0],
    ['XAF', 0],
    ['XPF', 0],
    ['KMF', 0],
    ['GNF', 0],
    ['DJF', 0],
    ['BIF', 0],
    ['RWF', 0],
    ['VUV', 0],
    ['KWD', 3],
    ['BHD', 3],
    ['IQD', 3],
    ['JOD', 3],
    ['OMR', 3],
    ['TND', 3],
    ['LYD', 3],
    ['IRR', 2],
    ['RSD', 2],
    ['LAK', 2],
    ['ALL', 2],
    ['MGA', 2],
    ['YER', 2],
    ['LBP', 2],
    ['MMK', 2],
    ['SOS', 2],
    ['SYP', 2],
    ['KPW', 2],
    ['SLE', 2],
    ['SLL', 2],
  ])('returns %s minor unit digits as %i', (currency, digits) => {
    expect(currencyDigits(currency)).toBe(digits)
  })

  it.each([['XXXX'], ['usd'], ['XXX'], ['ABC'], ['XAU'], ['']])(
    'throws for an invalid or inactive currency code %p',
    (currency) => {
      expect(() => currencyDigits(currency)).toThrow(TypeError)
      expect(() => currencyDigits(currency)).toThrow(
        'payload-plugin-attribution: invalid currency code',
      )
    },
  )
})

describe('toMajorUnits', () => {
  it.each([
    [12345, 'USD', 123.45],
    [500, 'JPY', 500],
    [12345, 'KWD', 12.345],
    [12345, 'IQD', 12.345],
    [12345, 'RSD', 123.45],
  ])('converts %i minor units of %s to %f major units', (minor, currency, major) => {
    expect(toMajorUnits(minor, currency)).toBe(major)
  })

  it.each([['XXXX'], ['usd'], ['XXX']])('throws for an invalid currency code %p', (currency) => {
    expect(() => toMajorUnits(1000, currency)).toThrow(TypeError)
  })
})

describe('isMinorUnits', () => {
  it.each([
    [0, true],
    [12345, true],
    [-1, false],
    [1.5, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    ['12345', false],
    [undefined, false],
    [null, false],
  ])('treats %p as isMinorUnits: %p', (value, expected) => {
    expect(isMinorUnits(value)).toBe(expected)
  })
})
