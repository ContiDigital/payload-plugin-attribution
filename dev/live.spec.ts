import type { Payload } from 'payload'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AttributionPluginOptions, ConversionEventDoc } from '../src/index.js'

import { recordConversion, verifyDestination } from '../src/index.js'
import { devConfig } from './config.js'

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined

const ga4 =
  env('ATTRIBUTION_LIVE_GA4_MEASUREMENT_ID') && env('ATTRIBUTION_LIVE_GA4_API_SECRET')
    ? {
        apiSecret: env('ATTRIBUTION_LIVE_GA4_API_SECRET') ?? '',
        measurementId: env('ATTRIBUTION_LIVE_GA4_MEASUREMENT_ID') ?? '',
      }
    : undefined

const adsConversionAction = env('ATTRIBUTION_LIVE_GOOGLE_ADS_CONVERSION_ACTION_ID')
const adsLoginAccount = env('ATTRIBUTION_LIVE_GOOGLE_ADS_LOGIN_ACCOUNT_ID')
const googleAds =
  adsConversionAction &&
  env('ATTRIBUTION_LIVE_GOOGLE_ADS_OPERATING_ACCOUNT_ID') &&
  env('ATTRIBUTION_LIVE_GOOGLE_ADS_SERVICE_ACCOUNT_JSON')
    ? {
        conversionActions: { lead: adsConversionAction, sale: adsConversionAction },
        ...(adsLoginAccount ? { loginAccountId: adsLoginAccount } : {}),
        operatingAccountId: env('ATTRIBUTION_LIVE_GOOGLE_ADS_OPERATING_ACCOUNT_ID') ?? '',
        serviceAccountJson: env('ATTRIBUTION_LIVE_GOOGLE_ADS_SERVICE_ACCOUNT_JSON') ?? '',
        transport: 'dataManager' as const,
      }
    : undefined

// A test event code keeps Meta events in Test Events; without one the live check never runs.
const meta =
  env('ATTRIBUTION_LIVE_META_PIXEL_ID') &&
  env('ATTRIBUTION_LIVE_META_ACCESS_TOKEN') &&
  env('ATTRIBUTION_LIVE_META_TEST_EVENT_CODE')
    ? {
        accessToken: env('ATTRIBUTION_LIVE_META_ACCESS_TOKEN') ?? '',
        pixelId: env('ATTRIBUTION_LIVE_META_PIXEL_ID') ?? '',
        testEventCode: env('ATTRIBUTION_LIVE_META_TEST_EVENT_CODE') ?? '',
      }
    : undefined

describe.skipIf(!ga4 && !googleAds && !meta)('live provider validation', () => {
  let directory = ''
  let payload: Payload
  let event: ConversionEventDoc

  beforeAll(async () => {
    process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'
    directory = await mkdtemp(join(tmpdir(), 'attribution-live-'))
    const options: AttributionPluginOptions = {
      destinations: {
        ...(ga4 ? { ga4 } : {}),
        ...(googleAds ? { googleAds } : {}),
        ...(meta ? { meta } : {}),
      },
      // Verification only: recorded deliveries are never dispatched, so nothing reaches live collection.
      dispatcher: { name: 'live-no-dispatch', dispatch: () => Promise.resolve() },
      secret: 'live-validation-secret',
    }
    payload = await getPayload({
      config: devConfig(options, `file:${join(directory, 'live.db')}`),
      cron: false,
      key: 'attribution-live',
    })
    const now = new Date().toISOString()
    const recorded = await recordConversion({
      draft: {
        name: 'generate_lead',
        attribution: { capturedAt: now, source: 'web' },
        buyer: { email: 'live-validation@example.com' },
        context: { url: 'https://example.com/contact', userAgent: 'attribution-live-check' },
        currency: 'USD',
        eventKey: `lead:live-${Date.now()}`,
        eventSource: 'WEB',
        googleAds: { action: 'lead', kind: 'conversion' },
        occurredAt: now,
        transactionId: `live-${Date.now()}`,
        valueCents: 100,
      },
      payload,
    })
    if (!recorded) {
      throw new Error('live validation event was not recorded')
    }
    event = recorded
  })

  afterAll(async () => {
    await payload?.destroy()
    if (directory) {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it.skipIf(!ga4)(
    'validates a GA4 event with the Measurement Protocol debug endpoint',
    async () => {
      const result = await verifyDestination({ destination: 'ga4', eventId: event.id, payload })
      expect(result).toMatchObject({ details: { validationMessages: [] }, ok: true })
    },
  )

  it.skipIf(!googleAds)('validates a Data Manager request with validateOnly', async () => {
    const result = await verifyDestination({ destination: 'googleAds', eventId: event.id, payload })
    expect(result).toMatchObject({ ok: true })
  })

  it.skipIf(!meta)('sends a Meta test event with the test event code', async () => {
    const result = await verifyDestination({ destination: 'meta', eventId: event.id, payload })
    expect(result).toMatchObject({ ok: true })
  })
})
