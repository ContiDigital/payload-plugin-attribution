import { describe, expect, it } from 'vitest'

import type { ConversionDraft, OriginalConversion } from '../../../types/index.js'

import { resolveAdsTreatment } from '../resolveAdsTreatment.js'

const draft = (fields: Partial<ConversionDraft>): ConversionDraft => ({
  name: 'generate_lead',
  eventKey: 'lead:test',
  occurredAt: '2026-09-13T12:00:00.000Z',
  ...fields,
})

describe('resolveAdsTreatment', () => {
  it('yields none/none when the draft opts out of Google Ads entirely', () => {
    expect(resolveAdsTreatment(draft({}), null)).toEqual({ action: 'none', kind: 'none' })
  })

  it('yields none/none when action is explicitly none regardless of kind', () => {
    expect(
      resolveAdsTreatment(draft({ googleAds: { action: 'none', kind: 'conversion' } }), {
        name: 'generate_lead',
        eventKey: 'lead:other',
        occurredAt: '2026-09-01T00:00:00.000Z',
      }),
    ).toEqual({ action: 'none', kind: 'none' })
  })

  it('auto kind resolves to conversion when there is no original', () => {
    expect(resolveAdsTreatment(draft({ googleAds: { action: 'lead' } }), null)).toEqual({
      action: 'lead',
      kind: 'conversion',
    })
  })

  it('auto kind is treated the same as an explicit auto kind', () => {
    expect(
      resolveAdsTreatment(draft({ googleAds: { action: 'lead', kind: 'auto' } }), null),
    ).toEqual({ action: 'lead', kind: 'conversion' })
  })

  it('auto kind resolves to restatement for a purchase with a different-key original', () => {
    const original: OriginalConversion = {
      name: 'deposit_paid',
      eventKey: 'deposit:1',
      occurredAt: '2026-08-01T00:00:00.000Z',
    }
    expect(
      resolveAdsTreatment(
        draft({ name: 'purchase', googleAds: { action: 'sale', kind: 'auto' } }),
        original,
      ),
    ).toEqual({ action: 'sale', kind: 'restatement' })
  })

  it('auto kind resolves to none for a non-purchase with a different-key original', () => {
    const original: OriginalConversion = {
      name: 'generate_lead',
      eventKey: 'lead:other',
      occurredAt: '2026-08-01T00:00:00.000Z',
    }
    expect(
      resolveAdsTreatment(draft({ googleAds: { action: 'lead', kind: 'auto' } }), original),
    ).toEqual({ action: 'lead', kind: 'none' })
  })

  it('auto kind resolves to conversion when the original shares the same eventKey', () => {
    const original: OriginalConversion = {
      name: 'generate_lead',
      eventKey: 'lead:test',
      occurredAt: '2026-08-01T00:00:00.000Z',
    }
    expect(
      resolveAdsTreatment(draft({ googleAds: { action: 'lead', kind: 'auto' } }), original),
    ).toEqual({ action: 'lead', kind: 'conversion' })
  })

  it('explicit conversion becomes restatement for a purchase with a different-key original', () => {
    const original: OriginalConversion = {
      name: 'deposit_paid',
      eventKey: 'deposit:1',
      occurredAt: '2026-08-01T00:00:00.000Z',
    }
    expect(
      resolveAdsTreatment(
        draft({ name: 'purchase', googleAds: { action: 'sale', kind: 'conversion' } }),
        original,
      ),
    ).toEqual({ action: 'sale', kind: 'restatement' })
  })

  it('explicit conversion becomes none for a non-purchase with a different-key original', () => {
    const original: OriginalConversion = {
      name: 'generate_lead',
      eventKey: 'lead:other',
      occurredAt: '2026-08-01T00:00:00.000Z',
    }
    expect(
      resolveAdsTreatment(draft({ googleAds: { action: 'lead', kind: 'conversion' } }), original),
    ).toEqual({ action: 'lead', kind: 'none' })
  })

  it('explicit conversion stays conversion when the original shares the same eventKey', () => {
    const original: OriginalConversion = {
      name: 'generate_lead',
      eventKey: 'lead:test',
      occurredAt: '2026-08-01T00:00:00.000Z',
    }
    expect(
      resolveAdsTreatment(draft({ googleAds: { action: 'lead', kind: 'conversion' } }), original),
    ).toEqual({ action: 'lead', kind: 'conversion' })
  })

  it('explicit conversion stays conversion when there is no original', () => {
    expect(
      resolveAdsTreatment(draft({ googleAds: { action: 'lead', kind: 'conversion' } }), null),
    ).toEqual({ action: 'lead', kind: 'conversion' })
  })

  it.each(['restatement', 'retraction', 'none'] as const)(
    'explicit %s passes through regardless of the original',
    (kind) => {
      const original: OriginalConversion = {
        name: 'generate_lead',
        eventKey: 'lead:other',
        occurredAt: '2026-08-01T00:00:00.000Z',
      }
      expect(resolveAdsTreatment(draft({ googleAds: { action: 'lead', kind } }), original)).toEqual(
        { action: 'lead', kind },
      )
    },
  )
})
