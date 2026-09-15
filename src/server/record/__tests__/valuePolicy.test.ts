import { describe, expect, it } from 'vitest'

import type { ConversionDraft } from '../../../types/index.js'

import { buildItems, priceBand, resolveValueCents } from '../valuePolicy.js'

const draft = (fields: Partial<ConversionDraft>): ConversionDraft => ({
  name: 'generate_lead',
  eventKey: 'lead:test',
  occurredAt: '2026-09-13T12:00:00.000Z',
  ...fields,
})

describe('resolveValueCents', () => {
  it('gives zero for a retraction on a non-refund event', () => {
    expect(resolveValueCents(draft({ name: 'generate_lead' }), 'retraction', {})).toBe(0)
  })

  it('keeps the draft value for a retraction on a refund event', () => {
    expect(resolveValueCents(draft({ name: 'refund', valueCents: 500 }), 'retraction', {})).toBe(
      500,
    )
  })

  it('prefers an explicit draft valueCents over any policy', () => {
    expect(resolveValueCents(draft({ valueCents: 999 }), 'conversion', {})).toBe(999)
  })

  it('derives a lead value from the list price and the default 5 percent policy', () => {
    expect(
      resolveValueCents(draft({ name: 'generate_lead', listPriceCents: 250000 }), 'conversion', {}),
    ).toBe(12500)
  })

  it('derives a lead value from the list price and a configured policy percent', () => {
    expect(
      resolveValueCents(draft({ name: 'generate_lead', listPriceCents: 250000 }), 'conversion', {
        leadValuePercent: 10,
      }),
    ).toBe(25000)
  })

  it('falls back to the configured flat lead value when there is no list price', () => {
    expect(
      resolveValueCents(draft({ name: 'generate_lead' }), 'conversion', {
        formLeadValueCents: 1500,
      }),
    ).toBe(1500)
  })

  it('falls back to zero when there is no list price and no configured flat lead value', () => {
    expect(resolveValueCents(draft({ name: 'generate_lead' }), 'conversion', {})).toBe(0)
  })

  it('is undefined for events with no value and no lead policy applicable', () => {
    expect(resolveValueCents(draft({ name: 'purchase' }), 'conversion', {})).toBeUndefined()
  })
})

describe('item and money helpers', () => {
  it('enforces helper money and band bounds', () => {
    expect(() => buildItems([{ id: 'item', name: 'Item', unitPriceCents: -1 }])).toThrow(
      'integer cents',
    )
    expect(() => buildItems([{ id: '', name: '', unitPriceCents: 0 }])).toThrow('Invalid items')
    expect(
      buildItems([{ id: 'item', name: 'Item', discountCents: 100, unitPriceCents: 1000 }])[0],
    ).toMatchObject({ discount: 1, price: 10, quantity: 1 })
    expect(() => priceBand(0, [100, 50])).toThrow()
    expect(() => priceBand(-1)).toThrow()
    expect(priceBand(500001)).toBe('5000+')
    expect(priceBand(0, [])).toBe('0+')
  })
})
