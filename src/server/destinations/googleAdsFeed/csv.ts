import { currencyDigits, toMajorUnits } from '../../../core/money.js'
import { CLICK_ID_PATTERN } from '../../../core/sanitize.js'

const CLICK_ID_HEADER = 'Google Click ID'

export const CONVERSION_HEADERS: readonly string[] = Object.freeze([
  CLICK_ID_HEADER,
  'Conversion Name',
  'Conversion Time',
  'Conversion Value',
  'Conversion Currency',
  'Order ID',
  'Ad User Data',
  'Ad Personalization',
])

export const ADJUSTMENT_HEADERS: readonly string[] = Object.freeze([
  'Order ID',
  'Conversion Name',
  'Adjustment Time',
  'Adjustment Type',
  'Adjusted Value',
  'Adjusted Value Currency',
])

const FORMULA_START = /^[=+\-@\t\r]/
const DECIMAL = /^-?\d+(?:\.\d+)?$/
const NEEDS_QUOTES = /[,"\r\n]/

// Spreadsheet applications evaluate cells that start with a formula character. Plain numbers,
// and click ids in the click id column, can legitimately start with a minus sign.
export const csvCell = (value: string, { clickId = false }: { clickId?: boolean } = {}): string => {
  const inert =
    !FORMULA_START.test(value) || DECIMAL.test(value) || (clickId && CLICK_ID_PATTERN.test(value))
  const text = inert ? value : `'${value}`
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function writeCsv(headers: readonly string[], rows: readonly string[][]): string {
  const clickIdColumn = headers.indexOf(CLICK_ID_HEADER)
  const lines = [
    headers.map((header) => csvCell(header)).join(','),
    ...rows.map((row) =>
      row.map((cell, column) => csvCell(cell, { clickId: column === clickIdColumn })).join(','),
    ),
  ]
  return ['Parameters:TimeZone=UTC', ...lines].join('\n') + '\n'
}

export const googleTime = (value: string): string =>
  `${new Date(value).toISOString().slice(0, 19).replace('T', ' ')}+0000`

export const formatMinorUnits = (minor: number, currency: string): string =>
  toMajorUnits(minor, currency).toFixed(currencyDigits(currency))
