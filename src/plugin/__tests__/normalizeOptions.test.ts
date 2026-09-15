import type { Config, PayloadRequest } from 'payload'

import { describe, expect, it } from 'vitest'

import type { AttributionPluginOptions } from '../../types/index.js'

import { attributionPlugin } from '../../index.js'
import { normalizeOptions } from '../normalizeOptions.js'

const base: AttributionPluginOptions = { secret: 'test-secret' }

const dataManager = {
  conversionActions: { lead: '111', sale: '222' },
  operatingAccountId: '1234567890',
  serviceAccountJson: '{"type":"service_account"}',
  transport: 'dataManager' as const,
}

const feed = {
  conversionActions: { lead: 'Business lead', sale: 'Business sale' },
  feed: { password: 'p', username: 'u' },
  transport: 'feed' as const,
}

const reqFor = (user: unknown): PayloadRequest => ({ user }) as unknown as PayloadRequest

const invalid: Array<[string, AttributionPluginOptions, RegExp]> = [
  ['missing secret', { secret: '' }, /secret is required/],
  ['blank static secret', { secret: '   ' }, /secret is required/],
  [
    'Data Manager without operatingAccountId',
    { ...base, destinations: { googleAds: { ...dataManager, operatingAccountId: undefined } } },
    /operatingAccountId/,
  ],
  [
    'Data Manager without serviceAccountJson',
    { ...base, destinations: { googleAds: { ...dataManager, serviceAccountJson: undefined } } },
    /serviceAccountJson/,
  ],
  [
    'Data Manager with a non-digit operatingAccountId',
    { ...base, destinations: { googleAds: { ...dataManager, operatingAccountId: '123-456' } } },
    /operatingAccountId/,
  ],
  [
    'Data Manager with non-digit conversion action ids',
    {
      ...base,
      destinations: {
        googleAds: { ...dataManager, conversionActions: { lead: 'Lead', sale: '222' } },
      },
    },
    /conversionActions\.lead/,
  ],
  [
    'feed without credentials',
    { ...base, destinations: { googleAds: { ...feed, feed: undefined } } },
    /feed credentials/,
  ],
  [
    'feed with a blank password',
    { ...base, destinations: { googleAds: { ...feed, feed: { password: '', username: 'u' } } } },
    /feed credentials/,
  ],
  [
    'adjustments without feed credentials',
    { ...base, destinations: { googleAds: { ...dataManager, adjustments: { enabled: true } } } },
    /feed credentials/,
  ],
  [
    'feed conversion name with a comma',
    {
      ...base,
      destinations: {
        googleAds: { ...feed, conversionActions: { lead: 'Lead, web', sale: 'Sale' } },
      },
    },
    /conversionActions\.lead/,
  ],
  [
    'feed conversion name longer than 100 characters',
    {
      ...base,
      destinations: {
        googleAds: { ...feed, conversionActions: { lead: 'L'.repeat(101), sale: 'Sale' } },
      },
    },
    /conversionActions\.lead/,
  ],
  [
    'feed lookbackDays out of range',
    {
      ...base,
      destinations: {
        googleAds: { ...feed, feed: { lookbackDays: 91, password: 'p', username: 'u' } },
      },
    },
    /lookbackDays/,
  ],
  [
    'feed lookbackDays not an integer',
    {
      ...base,
      destinations: {
        googleAds: { ...feed, feed: { lookbackDays: 1.5, password: 'p', username: 'u' } },
      },
    },
    /lookbackDays/,
  ],
  [
    'unknown transport',
    {
      ...base,
      destinations: { googleAds: { ...feed, transport: 'csv' as unknown as 'feed' } },
    },
    /transport/,
  ],
  ['apiBasePath without a leading slash', { ...base, apiBasePath: 'attribution' }, /apiBasePath/],
  ['apiBasePath with a trailing slash', { ...base, apiBasePath: '/attribution/' }, /apiBasePath/],
  ['apiBasePath with a traversal segment', { ...base, apiBasePath: '/a/../b' }, /apiBasePath/],
  [
    'lowercase defaultPhoneCountry',
    { ...base, identity: { defaultPhoneCountry: 'us' } },
    /defaultPhoneCountry/,
  ],
  [
    'three-letter defaultPhoneCountry',
    { ...base, identity: { defaultPhoneCountry: 'USA' } },
    /defaultPhoneCountry/,
  ],
  ['negative leadValuePercent', { ...base, policy: { leadValuePercent: -1 } }, /leadValuePercent/],
  [
    'infinite leadValuePercent',
    { ...base, policy: { leadValuePercent: Number.POSITIVE_INFINITY } },
    /leadValuePercent/,
  ],
  [
    'negative formLeadValueCents',
    { ...base, policy: { formLeadValueCents: -5 } },
    /formLeadValueCents/,
  ],
  [
    'fractional formLeadValueCents',
    { ...base, policy: { formLeadValueCents: 12.5 } },
    /formLeadValueCents/,
  ],
  ['maxAttempts of zero', { ...base, maxAttempts: 0 }, /maxAttempts/],
  [
    'identifierRetentionDays of zero',
    { ...base, privacy: { identifierRetentionDays: 0 } },
    /identifierRetentionDays/,
  ],
  [
    'GA4 without a measurementId',
    { ...base, destinations: { ga4: { apiSecret: 'x', measurementId: '' } } },
    /ga4\.measurementId/,
  ],
  [
    'Meta without an accessToken',
    { ...base, destinations: { meta: { accessToken: '', pixelId: '123' } } },
    /meta\.accessToken/,
  ],
  [
    'Meta timeoutMs above half the delivery lease',
    { ...base, destinations: { meta: { accessToken: 't', pixelId: '123', timeoutMs: 60_001 } } },
    /meta\.timeoutMs must be at most 60000 ms, half the delivery lease/,
  ],
  [
    'Meta with a malformed apiVersion',
    { ...base, destinations: { meta: { accessToken: 't', apiVersion: '26', pixelId: '123' } } },
    /apiVersion/,
  ],
  [
    'unknown consentPolicy',
    {
      ...base,
      destinations: {
        ga4: {
          apiSecret: 'x',
          consentPolicy: 'strict' as unknown as 'ignore',
          measurementId: 'G-1',
        },
      },
    },
    /consentPolicy/,
  ],
  [
    'operatingAccountId with surrounding whitespace',
    { ...base, destinations: { googleAds: { ...dataManager, operatingAccountId: ' 1234567890' } } },
    /operatingAccountId must contain digits only, with no surrounding whitespace/,
  ],
  [
    'loginAccountId with surrounding whitespace',
    { ...base, destinations: { googleAds: { ...dataManager, loginAccountId: '987654 ' } } },
    /loginAccountId must contain digits only, with no surrounding whitespace/,
  ],
  [
    'Data Manager conversion action id with surrounding whitespace',
    {
      ...base,
      destinations: {
        googleAds: { ...dataManager, conversionActions: { lead: '111', sale: ' 222' } },
      },
    },
    /conversionActions\.sale must be a Data Manager conversion action id \(digits only, no surrounding whitespace\)/,
  ],
  [
    'feed conversion name with surrounding whitespace',
    {
      ...base,
      destinations: {
        googleAds: { ...feed, conversionActions: { lead: 'Business lead ', sale: 'Sale' } },
      },
    },
    /conversionActions\.lead .*surrounding whitespace/,
  ],
  ['sweep cron with four fields', { ...base, sweep: { cron: '* * * *' } }, /sweep\.cron/],
  ['sweep cron with seven fields', { ...base, sweep: { cron: '0 * * * * * *' } }, /sweep\.cron/],
  ['sweep cron with a shell character', { ...base, sweep: { cron: '* * * * ;' } }, /sweep\.cron/],
  [
    'sweep cron with surrounding whitespace',
    { ...base, sweep: { cron: ' */5 * * * *' } },
    /sweep\.cron/,
  ],
  [
    'sweep cron that is not a string',
    { ...base, sweep: { cron: 5 as unknown as string } },
    /sweep\.cron/,
  ],
  ['blank sweep queue', { ...base, sweep: { cron: '*/5 * * * *', queue: ' ' } }, /sweep\.queue/],
  ...(['+', '-', '=', '@', '\t', '\r'] as const).map(
    (prefix): [string, AttributionPluginOptions, RegExp] => [
      `feed conversion name starting with ${JSON.stringify(prefix)}`,
      {
        ...base,
        destinations: {
          googleAds: { ...feed, conversionActions: { lead: 'Lead', sale: `${prefix}Sale` } },
        },
      },
      /conversionActions\.sale .*must not start with/,
    ],
  ),
]

describe('normalizeOptions validation', () => {
  it.each(invalid)('rejects %s', (_label, options, message) => {
    expect(() => normalizeOptions(options)).toThrow(message)
  })

  it('prefixes every validation error with the plugin slug', () => {
    for (const [, options] of invalid) {
      expect(() => normalizeOptions(options)).toThrow(/^payload-plugin-attribution: /)
    }
  })

  it('rejects a missing secret object property', () => {
    expect(() => normalizeOptions({} as AttributionPluginOptions)).toThrow(/secret is required/)
  })

  it('defers function-valued settings to first use', () => {
    expect(() =>
      normalizeOptions({
        destinations: {
          googleAds: {
            ...dataManager,
            operatingAccountId: () => 'not validated yet',
            serviceAccountJson: () => '',
          },
          meta: { accessToken: () => '', pixelId: () => '' },
        },
        secret: () => '',
      }),
    ).not.toThrow()
  })

  it('skips validation for a destination that is explicitly disabled', () => {
    expect(() =>
      normalizeOptions({
        ...base,
        destinations: { googleAds: { ...feed, enabled: false, feed: undefined } },
      }),
    ).not.toThrow()
  })

  it('skips consentPolicy and timeoutMs checks for disabled destinations', () => {
    const strict = 'strict' as unknown as 'ignore'
    const options = normalizeOptions({
      ...base,
      destinations: {
        ga4: { apiSecret: '', consentPolicy: strict, enabled: false, measurementId: '' },
        googleAds: { ...feed, consentPolicy: strict, enabled: false },
        meta: {
          accessToken: '',
          consentPolicy: strict,
          enabled: false,
          pixelId: '',
          timeoutMs: 0,
        },
      },
    })
    expect(options.destinations.ga4?.consentPolicy).toBe('ignore')
    expect(options.destinations.googleAds?.consentPolicy).toBe('withhold-denied')
    expect(options.destinations.meta).toMatchObject({
      consentPolicy: 'withhold-denied',
      enabled: false,
      timeoutMs: 0,
    })
  })

  it('skips secret and destination validation in disabled mode', () => {
    const options = normalizeOptions({
      destinations: { googleAds: { ...dataManager, operatingAccountId: undefined } },
      disabled: true,
      secret: '',
    })
    expect(options.disabled).toBe(true)
    expect(options.destinations).toEqual({})
  })

  it('accepts Data Manager digit ids and feed names', () => {
    expect(() =>
      normalizeOptions({ ...base, destinations: { googleAds: dataManager } }),
    ).not.toThrow()
    expect(() => normalizeOptions({ ...base, destinations: { googleAds: feed } })).not.toThrow()
  })
})

describe('normalizeOptions defaults', () => {
  it('fills top-level defaults', () => {
    const options = normalizeOptions(base)
    expect(options).toMatchObject({
      adminGroup: 'Marketing',
      apiBasePath: '/attribution',
      disabled: false,
      identity: {},
      maxAttempts: 6,
      policy: {},
      privacy: { identifierRetentionDays: 90 },
      queue: 'attribution',
      secret: 'test-secret',
      sweep: {},
    })
    expect(options.destinations).toEqual({})
  })

  it.each(['*/5 * * * *', '0 */5 * * * *', '0 3 * * MON-FRI'])(
    'accepts the sweep cron %s with an optional queue',
    (cron) => {
      expect(normalizeOptions({ ...base, sweep: { cron } }).sweep).toEqual({ cron })
      expect(normalizeOptions({ ...base, sweep: { cron, queue: 'maintenance' } }).sweep).toEqual({
        cron,
        queue: 'maintenance',
      })
    },
  )

  it('defaults the dispatcher to Payload Jobs', () => {
    const { dispatcher } = normalizeOptions(base)
    expect(dispatcher.name).toBe('payload-jobs')
    expect(dispatcher.install).toBeTypeOf('function')
  })

  it('keeps a supplied dispatcher', () => {
    const dispatcher = { name: 'fake', dispatch: () => Promise.resolve() }
    expect(normalizeOptions({ ...base, dispatcher }).dispatcher).toBe(dispatcher)
  })

  it('authorizes admin users for read and operate but never pii by default', async () => {
    const options = normalizeOptions(base, { admin: { user: 'staff' } })
    const staff = reqFor({ id: 1, collection: 'staff' })
    expect(await options.authorize({ req: staff, scope: 'read' })).toBe(true)
    expect(await options.authorize({ req: staff, scope: 'operate' })).toBe(true)
    expect(await options.authorize({ req: staff, scope: 'pii' })).toBe(false)
    expect(
      await options.authorize({ req: reqFor({ id: 1, collection: 'users' }), scope: 'read' }),
    ).toBe(false)
    expect(await options.authorize({ req: reqFor(null), scope: 'read' })).toBe(false)
  })

  it('uses the users collection when admin.user is not configured', async () => {
    const options = normalizeOptions(base)
    expect(
      await options.authorize({ req: reqFor({ id: 1, collection: 'users' }), scope: 'read' }),
    ).toBe(true)
  })

  it('fills destination defaults', () => {
    const options = normalizeOptions({
      ...base,
      destinations: {
        ga4: { apiSecret: 'a', measurementId: 'G-1' },
        googleAds: feed,
        meta: { accessToken: 't', pixelId: '1' },
      },
    })
    expect(options.destinations.ga4).toMatchObject({
      consentPolicy: 'ignore',
      enabled: true,
      euEndpoint: false,
      resendRevisions: false,
      userProvidedData: false,
    })
    expect(options.destinations.googleAds).toMatchObject({
      adjustments: { enabled: false },
      allowBraidsInFeed: false,
      consentPolicy: 'withhold-denied',
      enabled: true,
      feed: { lookbackDays: 90 },
    })
    expect(options.destinations.meta).toMatchObject({
      apiVersion: 'v26.0',
      consentPolicy: 'withhold-denied',
      enabled: true,
      events: {
        appointment_booked: 'Schedule',
        generate_lead: 'Lead',
        purchase: 'Purchase',
        sign_up: 'CompleteRegistration',
      },
      limitedDataUse: false,
      resendRevisions: false,
      timeoutMs: 5000,
    })
  })

  it('keeps explicit destination values', () => {
    const options = normalizeOptions({
      ...base,
      destinations: {
        meta: {
          accessToken: 't',
          apiVersion: 'v27.0',
          consentPolicy: 'ignore',
          events: { purchase: { name: 'Purchase', actionSource: 'physical_store' } },
          pixelId: '1',
          resendRevisions: true,
          timeoutMs: 2000,
        },
      },
    })
    expect(options.destinations.meta).toMatchObject({
      apiVersion: 'v27.0',
      consentPolicy: 'ignore',
      events: { purchase: { name: 'Purchase', actionSource: 'physical_store' } },
      resendRevisions: true,
      timeoutMs: 2000,
    })
  })
})

describe('normalizeOptions endpoints', () => {
  it('defaults every provider endpoint to the real provider and leaves ga4 to euEndpoint', () => {
    expect(normalizeOptions(base).endpoints).toEqual({
      dataManager: 'https://datamanager.googleapis.com',
      ga4Admin: 'https://analyticsadmin.googleapis.com/v1beta',
      meta: 'https://graph.facebook.com',
    })
  })

  it('accepts https URLs and http loopback URLs, dropping trailing slashes', () => {
    expect(
      normalizeOptions({
        ...base,
        endpoints: {
          dataManager: 'https://proxy.example.com/google/',
          ga4: 'http://127.0.0.1:3199/',
          ga4Admin: 'http://localhost:3199/v1beta',
          meta: 'http://[::1]:3199',
        },
      }).endpoints,
    ).toEqual({
      dataManager: 'https://proxy.example.com/google',
      ga4: 'http://127.0.0.1:3199',
      ga4Admin: 'http://localhost:3199/v1beta',
      meta: 'http://[::1]:3199',
    })
  })

  it.each([
    ['plain http on a public host', { ga4: 'http://collector.example.com' }],
    ['a non-http scheme', { meta: 'ftp://127.0.0.1' }],
    ['credentials', { dataManager: 'https://user:pass@example.com' }],
    ['a query string', { ga4Admin: 'https://example.com/v1beta?key=1' }],
    ['a fragment', { meta: 'https://example.com/#x' }],
    ['a relative path', { ga4: '/mock' }],
    ['a non-string', { ga4: 3199 as unknown as string }],
  ])('rejects an endpoint with %s', (_label, endpoints) => {
    expect(() => normalizeOptions({ ...base, endpoints })).toThrow(
      /^payload-plugin-attribution: endpoints\.\w+ must be an https URL/,
    )
  })

  it('lets a Data Manager access token function stand in for the service account', () => {
    const { serviceAccountJson: _omitted, ...withoutServiceAccount } = dataManager
    expect(() =>
      normalizeOptions({
        ...base,
        destinations: { googleAds: { ...withoutServiceAccount, accessToken: () => 'token' } },
      }),
    ).not.toThrow()
    expect(() =>
      normalizeOptions({ ...base, destinations: { googleAds: withoutServiceAccount } }),
    ).toThrow(/serviceAccountJson is required for transport "dataManager" unless accessToken/)
    expect(() =>
      normalizeOptions({
        ...base,
        destinations: {
          googleAds: { ...dataManager, accessToken: 'token' as unknown as () => string },
        },
      }),
    ).toThrow(/accessToken must be a function/)
  })
})

describe('attributionPlugin', () => {
  it('refuses to be applied twice to one config', () => {
    const once = attributionPlugin(base)({} as Config)
    expect(() => attributionPlugin(base)(once)).toThrow(
      'payload-plugin-attribution: only one plugin instance may be applied to a Payload config',
    )
  })

  it('validates options when applied', () => {
    expect(() => attributionPlugin({ secret: '' })({} as Config)).toThrow(/secret is required/)
  })
})
