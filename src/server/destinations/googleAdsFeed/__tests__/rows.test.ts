import { describe, expect, it } from 'vitest'

import type { ConversionEventDoc } from '../../../../types/index.js'

import { ADJUSTMENT_HEADERS, CONVERSION_HEADERS, writeCsv } from '../csv.js'
import { adjustmentRow, conversionRow } from '../rows.js'

const now = new Date('2026-09-14T12:00:00.000Z')
const names = { lead: 'Business lead', sale: 'Business sale' }

const event = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 1,
  name: 'purchase',
  attribution: { clickCapturedAt: '2026-09-12T08:00:00.000Z', gclid: 'abcdefghij12345' },
  consent: { adPersonalization: 'denied', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: now.toISOString(),
  currency: 'USD',
  eventKey: 'purchase:order-1',
  googleAdsAction: 'sale',
  googleAdsKind: 'conversion',
  occurredAt: '2026-09-13T08:00:00.000Z',
  revision: 1,
  transactionId: 'order-1',
  updatedAt: now.toISOString(),
  valueCents: 12345,
  ...overrides,
})

const adjustment = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc =>
  event({
    name: 'refund',
    adjustedValueCents: 10000,
    eventKey: 'refund:order-1',
    googleAdsKind: 'restatement',
    occurredAt: '2026-09-14T09:30:00.000Z',
    ...overrides,
  })

describe('conversionRow', () => {
  it('writes an exact conversion file', () => {
    const row = conversionRow(event(), names, { now })
    expect(row).not.toBeNull()
    expect(writeCsv(CONVERSION_HEADERS, [row ?? []])).toBe(
      'Parameters:TimeZone=UTC\n' +
        'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Order ID,Ad User Data,Ad Personalization\n' +
        'abcdefghij12345,Business sale,2026-09-13 08:00:00+0000,123.45,USD,order-1,Granted,Denied\n',
    )
  })

  it('leaves a missing value and undecided consent blank', () => {
    expect(
      conversionRow(
        event({
          consent: {
            adPersonalization: 'unknown',
            adUserData: 'unknown',
            analyticsStorage: 'unknown',
          },
          googleAdsAction: 'lead',
          valueCents: null,
        }),
        names,
        { now },
      ),
    ).toEqual([
      'abcdefghij12345',
      'Business lead',
      '2026-09-13 08:00:00+0000',
      '',
      'USD',
      'order-1',
      '',
      '',
    ])
  })

  it('formats the value with the currency minor unit digits', () => {
    expect(
      conversionRow(event({ currency: 'JPY', valueCents: 1000 }), names, { now })?.slice(3, 5),
    ).toEqual(['1000', 'JPY'])
  })

  it('omits a braid-only conversion unless braids are allowed', () => {
    const braid = event({
      attribution: { clickCapturedAt: '2026-09-12T08:00:00.000Z', gbraid: 'gbraid0123456789' },
    })
    expect(conversionRow(braid, names, { now })).toBeNull()
    expect(conversionRow(braid, names, { allowBraids: false, now })).toBeNull()
    expect(
      writeCsv(CONVERSION_HEADERS, [conversionRow(braid, names, { allowBraids: true, now }) ?? []]),
    ).toBe(
      'Parameters:TimeZone=UTC\n' +
        'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Order ID,Ad User Data,Ad Personalization\n' +
        'gbraid0123456789,Business sale,2026-09-13 08:00:00+0000,123.45,USD,order-1,Granted,Denied\n',
    )
  })

  it('prefers the gclid over a braid', () => {
    expect(
      conversionRow(
        event({
          attribution: {
            clickCapturedAt: '2026-09-12T08:00:00.000Z',
            gbraid: 'gbraid0123456789',
            gclid: 'abcdefghij12345',
          },
        }),
        names,
        { allowBraids: true, now },
      )?.[0],
    ).toBe('abcdefghij12345')
  })

  it.each([
    ['an adjustment kind', { googleAdsKind: 'restatement' as const }],
    ['no Google Ads action', { googleAdsAction: 'none' as const }],
    ['no transaction id', { transactionId: null }],
    ['no click id', { attribution: {} }],
    [
      'a click older than 90 days',
      { attribution: { clickCapturedAt: '2026-06-01T08:00:00.000Z', gclid: 'abcdefghij12345' } },
    ],
  ])('returns null for %s', (_label, overrides) => {
    expect(conversionRow(event(overrides), names, { now })).toBeNull()
  })
})

describe('adjustmentRow', () => {
  it('writes an exact restatement file', () => {
    expect(writeCsv(ADJUSTMENT_HEADERS, [adjustmentRow(adjustment(), names) ?? []])).toBe(
      'Parameters:TimeZone=UTC\n' +
        'Order ID,Conversion Name,Adjustment Time,Adjustment Type,Adjusted Value,Adjusted Value Currency\n' +
        'order-1,Business sale,2026-09-14 09:30:00+0000,RESTATE,100.00,USD\n',
    )
  })

  it('writes an exact retraction file with no adjusted value', () => {
    expect(
      writeCsv(ADJUSTMENT_HEADERS, [
        adjustmentRow(adjustment({ googleAdsKind: 'retraction' }), names) ?? [],
      ]),
    ).toBe(
      'Parameters:TimeZone=UTC\n' +
        'Order ID,Conversion Name,Adjustment Time,Adjustment Type,Adjusted Value,Adjusted Value Currency\n' +
        'order-1,Business sale,2026-09-14 09:30:00+0000,RETRACT,,\n',
    )
  })

  it('never restates to zero when neither value was recorded', () => {
    expect(
      adjustmentRow(adjustment({ adjustedValueCents: null, valueCents: null }), names),
    ).toBeNull()
    expect(
      adjustmentRow(
        adjustment({ adjustedValueCents: null, googleAdsKind: 'retraction', valueCents: null }),
        names,
      )?.slice(3),
    ).toEqual(['RETRACT', '', ''])
  })

  it.each([
    ['no Google Ads action', { googleAdsAction: 'none' as const }],
    ['no transaction id', { transactionId: null }],
    ['a conversion kind', { googleAdsKind: 'conversion' as const }],
  ])('returns null for %s', (_label, overrides) => {
    expect(adjustmentRow(adjustment(overrides), names)).toBeNull()
  })

  it('restates to the event value when no adjusted value was recorded', () => {
    expect(adjustmentRow(adjustment({ adjustedValueCents: null }), names)?.slice(3)).toEqual([
      'RESTATE',
      '123.45',
      'USD',
    ])
  })

  it('restates a lead in the currency minor unit digits', () => {
    expect(
      adjustmentRow(
        adjustment({ adjustedValueCents: 2500, currency: 'JPY', googleAdsAction: 'lead' }),
        names,
      ),
    ).toEqual(['order-1', 'Business lead', '2026-09-14 09:30:00+0000', 'RESTATE', '2500', 'JPY'])
  })
})
