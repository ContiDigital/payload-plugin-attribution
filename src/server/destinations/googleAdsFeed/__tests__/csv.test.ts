import { describe, expect, it } from 'vitest'

import {
  ADJUSTMENT_HEADERS,
  CONVERSION_HEADERS,
  csvCell,
  formatMinorUnits,
  googleTime,
  writeCsv,
} from '../csv.js'

describe('writeCsv', () => {
  it('writes the time zone parameter and the conversion headers with LF line endings', () => {
    expect(writeCsv(CONVERSION_HEADERS, [])).toBe(
      'Parameters:TimeZone=UTC\nGoogle Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Order ID,Ad User Data,Ad Personalization\n',
    )
  })

  it('writes the adjustment headers', () => {
    expect(writeCsv(ADJUSTMENT_HEADERS, [])).toBe(
      'Parameters:TimeZone=UTC\nOrder ID,Conversion Name,Adjustment Time,Adjustment Type,Adjusted Value,Adjusted Value Currency\n',
    )
  })

  it('neutralises a formula in a conversion name and quotes it', () => {
    expect(writeCsv(['Conversion Name'], [['=HYPERLINK("x")']])).toBe(
      'Parameters:TimeZone=UTC\nConversion Name\n"\'=HYPERLINK(""x"")"\n',
    )
  })
})

describe('csvCell', () => {
  it.each([
    ['plain', 'plain'],
    ['a,"b"\nc', '"a,""b""\nc"'],
    ['=1+2', "'=1+2"],
    ['+1', "'+1"],
    ['-', "'-"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', '"\'\rcmd"'],
    ['-12.50', '-12.50'],
    ['-abcdefghij12345', "'-abcdefghij12345"],
    ['', ''],
  ])('writes %j as %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected)
  })

  it('exempts a click-id-shaped value only in the click id column', () => {
    expect(csvCell('-abcdefghij12345', { clickId: true })).toBe('-abcdefghij12345')
    expect(csvCell('=HYPERLINK(1)', { clickId: true })).toBe("'=HYPERLINK(1)")
  })

  it('prefixes a click-id-shaped conversion name and order id but not the click id', () => {
    const value = '-abcdefghij12345'
    expect(writeCsv(CONVERSION_HEADERS, [[value, value, 't', '', 'USD', value, '', '']])).toBe(
      'Parameters:TimeZone=UTC\n' +
        `${CONVERSION_HEADERS.join(',')}\n` +
        `${value},'${value},t,,USD,'${value},,\n`,
    )
    expect(writeCsv(ADJUSTMENT_HEADERS, [[value, value, 't', 'RETRACT', '', '']])).toBe(
      'Parameters:TimeZone=UTC\n' +
        `${ADJUSTMENT_HEADERS.join(',')}\n` +
        `'${value},'${value},t,RETRACT,,\n`,
    )
  })
})

describe('googleTime', () => {
  it('formats an ISO instant in UTC with an explicit offset', () => {
    expect(googleTime('2026-09-13T08:00:00.123Z')).toBe('2026-09-13 08:00:00+0000')
  })
})

describe('formatMinorUnits', () => {
  it.each([
    [12345, 'USD', '123.45'],
    [5, 'USD', '0.05'],
    [1000, 'JPY', '1000'],
    [12345, 'BHD', '12.345'],
  ])('formats %d %s as %s', (minor, currency, expected) => {
    expect(formatMinorUnits(minor, currency)).toBe(expected)
  })
})
