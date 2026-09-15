import { describe, expect, it } from 'vitest'

import type { ConversionEventDoc, NormalizedOptions } from '../../../types/index.js'

import { normalizeOptions } from '../../../plugin/normalizeOptions.js'
import { planDeliveries } from '../planDeliveries.js'

const options = (
  overrides: {
    adjustments?: boolean
    consent?: 'ignore' | 'require-granted' | 'withhold-denied'
    ga4?: false
    googleAds?: false
    meta?: false
    metaResendRevisions?: boolean
    resendRevisions?: boolean
  } = {},
): NormalizedOptions =>
  normalizeOptions({
    destinations: {
      ga4: {
        apiSecret: 'secret',
        consentPolicy: overrides.consent,
        enabled: overrides.ga4,
        measurementId: 'G-TEST',
        resendRevisions: overrides.resendRevisions,
      },
      googleAds: {
        adjustments: { enabled: overrides.adjustments },
        consentPolicy: overrides.consent,
        conversionActions: { lead: '1', sale: '2' },
        enabled: overrides.googleAds,
        feed: { password: 'p', username: 'u' },
        operatingAccountId: '123',
        serviceAccountJson: '{}',
        transport: 'dataManager',
      },
      meta: {
        accessToken: 'token',
        consentPolicy: overrides.consent,
        enabled: overrides.meta,
        pixelId: '42',
        resendRevisions: overrides.metaResendRevisions,
      },
    },
    secret: 'plugin-secret',
  })

const event = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 1,
  name: 'purchase',
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: '2026-09-14T00:00:00.000Z',
  eventKey: 'order-1',
  googleAdsAction: 'sale',
  googleAdsKind: 'conversion',
  occurredAt: '2026-09-14T00:00:00.000Z',
  revision: 1,
  updatedAt: '2026-09-14T00:00:00.000Z',
  ...overrides,
})

const destinations = (plan: ReturnType<typeof planDeliveries>) =>
  Object.fromEntries(plan.map(({ destination, ...rest }) => [destination, rest]))

describe('planDeliveries', () => {
  it('plans every enabled destination for a first-revision conversion', () => {
    expect(planDeliveries(event(), options())).toEqual([
      { destination: 'ga4', status: 'pending' },
      { destination: 'googleAds', status: 'pending' },
      { destination: 'meta', status: 'pending' },
    ])
  })

  it('plans nothing when the plugin is disabled or no destination is configured', () => {
    expect(planDeliveries(event(), normalizeOptions({ disabled: true, secret: '' }))).toEqual([])
    expect(planDeliveries(event(), normalizeOptions({ secret: 'x' }))).toEqual([])
  })

  it.each([
    ['ga4', { ga4: false } as const],
    ['googleAds', { googleAds: false } as const],
    ['meta', { meta: false } as const],
  ])('skips disabled %s', (destination, overrides) => {
    const plan = planDeliveries(event(), options(overrides))
    expect(plan.map((row) => row.destination)).not.toContain(destination)
  })

  it('skips destinations the draft opted out of', () => {
    const plan = planDeliveries(event(), options({ adjustments: true }), {
      ga4: false,
      googleAds: false,
      meta: true,
    })
    expect(plan).toEqual([{ destination: 'meta', status: 'pending' }])
  })

  describe('ga4', () => {
    it('withholds later revisions unless resendRevisions is set', () => {
      expect(destinations(planDeliveries(event({ revision: 2 }), options())).ga4).toEqual({
        reason: 'revision_not_resent',
        status: 'withheld',
      })
      expect(
        destinations(planDeliveries(event({ revision: 2 }), options({ resendRevisions: true })))
          .ga4,
      ).toEqual({ status: 'pending' })
    })
  })

  describe('googleAds and googleAdsAdjustment', () => {
    it.each([
      ['sale', 'conversion', false, ['googleAds']],
      ['sale', 'conversion', true, ['googleAds']],
      ['none', 'none', true, []],
      ['sale', 'none', true, []],
      [null, null, true, []],
      ['sale', 'restatement', false, []],
      ['sale', 'restatement', true, ['googleAdsAdjustment']],
      ['lead', 'retraction', true, ['googleAdsAdjustment']],
      ['lead', 'retraction', false, []],
    ] as const)('action %s kind %s adjustments %s', (action, kind, adjustments, expected) => {
      const plan = planDeliveries(
        event({ googleAdsAction: action, googleAdsKind: kind }),
        options({ adjustments }),
      )
      expect(
        plan
          .map((row) => row.destination)
          .filter((name) => name === 'googleAds' || name === 'googleAdsAdjustment'),
      ).toEqual(expected)
    })

    it('does not plan an adjustment when the draft opts out of it', () => {
      const plan = planDeliveries(
        event({ googleAdsKind: 'restatement' }),
        options({ adjustments: true }),
        { googleAdsAdjustment: false },
      )
      expect(plan.map((row) => row.destination)).toEqual(['ga4', 'meta'])
    })
  })

  describe('meta', () => {
    it('plans only mapped event names', () => {
      expect(
        planDeliveries(event({ name: 'view_item' }), options()).map((row) => row.destination),
      ).toEqual(['ga4', 'googleAds'])
    })

    it('withholds later revisions unless meta.resendRevisions is set', () => {
      expect(planDeliveries(event({ revision: 2 }), options())).toStrictEqual([
        { destination: 'ga4', reason: 'revision_not_resent', status: 'withheld' },
        { destination: 'googleAds', status: 'pending' },
        { destination: 'meta', reason: 'revision_not_resent', status: 'withheld' },
      ])
      expect(
        destinations(planDeliveries(event({ revision: 2 }), options({ metaResendRevisions: true })))
          .meta,
      ).toStrictEqual({ status: 'pending' })
    })

    it('never plans a retraction', () => {
      expect(
        planDeliveries(event({ googleAdsKind: 'retraction' }), options({ adjustments: true })).map(
          (row) => row.destination,
        ),
      ).toEqual(['ga4', 'googleAdsAdjustment'])
    })
  })

  describe('consent', () => {
    it('applies each destination policy and still plans withheld rows', () => {
      const denied = event({
        consent: { adPersonalization: 'denied', adUserData: 'denied', analyticsStorage: 'granted' },
      })
      expect(planDeliveries(denied, options())).toEqual([
        { destination: 'ga4', status: 'pending' },
        { destination: 'googleAds', reason: 'consent_denied', status: 'withheld' },
        { destination: 'meta', reason: 'consent_denied', status: 'withheld' },
      ])
    })

    it('withholds ga4 when analytics storage is denied, whatever its policy', () => {
      const analyticsDenied = event({
        consent: {
          adPersonalization: 'granted',
          adUserData: 'granted',
          analyticsStorage: 'denied',
        },
      })
      for (const consent of ['ignore', 'withhold-denied', 'require-granted'] as const) {
        expect(planDeliveries(analyticsDenied, options({ consent }))).toEqual([
          { destination: 'ga4', reason: 'consent_denied', status: 'withheld' },
          { destination: 'googleAds', status: 'pending' },
          { destination: 'meta', status: 'pending' },
        ])
      }
      const analyticsUnknown = event({
        consent: {
          adPersonalization: 'granted',
          adUserData: 'granted',
          analyticsStorage: 'unknown',
        },
      })
      expect(destinations(planDeliveries(analyticsUnknown, options())).ga4).toEqual({
        status: 'pending',
      })
    })

    it('require-granted withholds unknown consent', () => {
      const unknown = event({
        consent: {
          adPersonalization: 'unknown',
          adUserData: 'unknown',
          analyticsStorage: 'unknown',
        },
      })
      expect(planDeliveries(unknown, options({ consent: 'require-granted' }))).toEqual([
        { destination: 'ga4', reason: 'consent_missing', status: 'withheld' },
        { destination: 'googleAds', reason: 'consent_missing', status: 'withheld' },
        { destination: 'meta', reason: 'consent_missing', status: 'withheld' },
      ])
    })

    it('reports the revision reason before consent for ga4', () => {
      const plan = planDeliveries(
        event({
          consent: {
            adPersonalization: 'denied',
            adUserData: 'denied',
            analyticsStorage: 'denied',
          },
          revision: 3,
        }),
        options({ consent: 'withhold-denied' }),
      )
      expect(destinations(plan).ga4).toEqual({ reason: 'revision_not_resent', status: 'withheld' })
    })
  })
})
