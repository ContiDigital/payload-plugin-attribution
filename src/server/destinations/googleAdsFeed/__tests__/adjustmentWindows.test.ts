import { describe, expect, it } from 'vitest'

import { adjustmentWindow } from '../adjustmentWindows.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const delivered = '2026-09-01T00:00:00.000Z'
const after = (ms: number): Date => new Date(Date.parse(delivered) + ms)

describe('adjustmentWindow', () => {
  it('waits until 24 hours after the original was delivered, closing at 54 days', () => {
    expect(adjustmentWindow(delivered, after(23 * HOUR))).toEqual({
      deadlineAt: '2026-10-25T00:00:00.000Z',
      state: 'wait',
      until: '2026-09-02T00:00:00.000Z',
    })
  })

  it.each([
    ['exactly 24 hours', 24 * HOUR],
    ['25 hours', 25 * HOUR],
    ['exactly 54 days', 54 * DAY],
  ])('is open at %s', (_label, ms) => {
    expect(adjustmentWindow(delivered, after(ms))).toEqual({ state: 'open' })
  })

  it.each([
    ['one millisecond past 54 days', 54 * DAY + 1],
    ['55 days', 55 * DAY],
  ])('is closed at %s', (_label, ms) => {
    expect(adjustmentWindow(delivered, after(ms))).toEqual({ state: 'closed' })
  })

  it('is closed when the delivery time cannot be read', () => {
    expect(adjustmentWindow('not a date', after(DAY))).toEqual({ state: 'closed' })
  })
})
