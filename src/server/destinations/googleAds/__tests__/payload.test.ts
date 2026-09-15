import { describe, expect, it } from 'vitest'

import type { ConversionEventDoc } from '../../../../types/index.js'

import { buildIngestRequest } from '../payload.js'

const baseEvent = (overrides: Partial<ConversionEventDoc> = {}): ConversionEventDoc => ({
  id: 1,
  name: 'purchase',
  consent: { adPersonalization: 'denied', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: '2026-09-01T12:00:00.000Z',
  currency: 'USD',
  eventKey: 'purchase:ORDER-1',
  eventSource: 'WEB',
  occurredAt: '2026-09-01T12:00:00.000Z',
  revision: 1,
  transactionId: 'ORDER-1',
  updatedAt: '2026-09-01T12:00:00.000Z',
  valueCents: 123450,
  ...overrides,
})

describe('buildIngestRequest', () => {
  it('builds the exact request for a click id plus user data', () => {
    const event = baseEvent({
      attribution: { clickCapturedAt: '2026-08-01T00:00:00.000Z', gclid: '...' },
      identifiers: {
        google: {
          country: 'US',
          emailSha256: '<sha256>',
          firstNameSha256: '<sha256>',
          lastNameSha256: '<sha256>',
          phoneSha256: '<sha256>',
          postalCode: '94103',
          region: 'CA',
        },
      },
    })

    const request = buildIngestRequest(event, {
      conversionActionId: '555',
      loginAccountId: '9876543210',
      operatingAccountId: '1234567890',
    })

    expect(request).toStrictEqual({
      consent: { adPersonalization: 'CONSENT_DENIED', adUserData: 'CONSENT_GRANTED' },
      destinations: [
        {
          loginAccount: { accountId: '9876543210', accountType: 'GOOGLE_ADS' },
          operatingAccount: { accountId: '1234567890', accountType: 'GOOGLE_ADS' },
          productDestinationId: '555',
        },
      ],
      encoding: 'HEX',
      events: [
        {
          adIdentifiers: { gclid: '...' },
          conversionValue: 1234.5,
          currency: 'USD',
          eventSource: 'WEB',
          eventTimestamp: '2026-09-01T12:00:00.000Z',
          transactionId: 'ORDER-1',
          userData: {
            userIdentifiers: [
              { emailAddress: '<sha256>' },
              { phoneNumber: '<sha256>' },
              {
                address: {
                  familyName: '<sha256>',
                  givenName: '<sha256>',
                  postalCode: '94103',
                  regionCode: 'US',
                },
              },
            ],
          },
        },
      ],
      validateOnly: false,
    })
  })

  it.each([
    ['postal code', { postalCode: undefined }],
    ['given name', { firstNameSha256: undefined }],
    ['family name', { lastNameSha256: undefined }],
    ['country', { country: undefined }],
    ['a two letter country (three letters given)', { country: 'USA' }],
  ])('omits the address identifier without %s', (_label, missing) => {
    const event = baseEvent({
      consent: { adPersonalization: 'unknown', adUserData: 'unknown', analyticsStorage: 'unknown' },
      identifiers: {
        google: {
          country: 'US',
          emailSha256: '<sha256>',
          firstNameSha256: '<sha256>',
          lastNameSha256: '<sha256>',
          postalCode: '94103',
          region: 'CA',
          ...missing,
        },
      },
    })

    expect(
      buildIngestRequest(event, { conversionActionId: '555', operatingAccountId: '1234567890' }),
    ).toStrictEqual({
      destinations: [
        {
          operatingAccount: { accountId: '1234567890', accountType: 'GOOGLE_ADS' },
          productDestinationId: '555',
        },
      ],
      encoding: 'HEX',
      events: [
        {
          conversionValue: 1234.5,
          currency: 'USD',
          eventSource: 'WEB',
          eventTimestamp: '2026-09-01T12:00:00.000Z',
          transactionId: 'ORDER-1',
          userData: { userIdentifiers: [{ emailAddress: '<sha256>' }] },
        },
      ],
      validateOnly: false,
    })
  })

  it.each([
    [
      'gclid over both braids',
      { gbraid: 'gbraid-1', gclid: 'gclid-1', wbraid: 'wbraid-1' },
      { gclid: 'gclid-1' },
    ],
    ['gbraid over wbraid', { gbraid: 'gbraid-1', wbraid: 'wbraid-1' }, { gbraid: 'gbraid-1' }],
    ['wbraid alone', { wbraid: 'wbraid-1' }, { wbraid: 'wbraid-1' }],
  ])('sends exactly one click id: %s', (_label, attribution, adIdentifiers) => {
    const event = baseEvent({
      attribution,
      consent: { adPersonalization: 'unknown', adUserData: 'unknown', analyticsStorage: 'unknown' },
    })

    expect(
      buildIngestRequest(event, { conversionActionId: '555', operatingAccountId: '1234567890' }),
    ).toStrictEqual({
      destinations: [
        {
          operatingAccount: { accountId: '1234567890', accountType: 'GOOGLE_ADS' },
          productDestinationId: '555',
        },
      ],
      encoding: 'HEX',
      events: [
        {
          adIdentifiers,
          conversionValue: 1234.5,
          currency: 'USD',
          eventSource: 'WEB',
          eventTimestamp: '2026-09-01T12:00:00.000Z',
          transactionId: 'ORDER-1',
        },
      ],
      validateOnly: false,
    })
  })

  it('builds the exact request for a gbraid only, with no loginAccount, consent or userData', () => {
    const event = baseEvent({
      attribution: { clickCapturedAt: '2026-08-01T00:00:00.000Z', gbraid: 'gbraid-value' },
      consent: { adPersonalization: 'unknown', adUserData: 'unknown', analyticsStorage: 'unknown' },
    })

    const request = buildIngestRequest(event, {
      conversionActionId: '555',
      operatingAccountId: '1234567890',
    })

    expect(request).toStrictEqual({
      destinations: [
        {
          operatingAccount: { accountId: '1234567890', accountType: 'GOOGLE_ADS' },
          productDestinationId: '555',
        },
      ],
      encoding: 'HEX',
      events: [
        {
          adIdentifiers: { gbraid: 'gbraid-value' },
          conversionValue: 1234.5,
          currency: 'USD',
          eventSource: 'WEB',
          eventTimestamp: '2026-09-01T12:00:00.000Z',
          transactionId: 'ORDER-1',
        },
      ],
      validateOnly: false,
    })
  })

  it('builds the exact request with validateOnly true', () => {
    const event = baseEvent({ attribution: { gclid: '...' } })

    const request = buildIngestRequest(event, {
      conversionActionId: '555',
      operatingAccountId: '1234567890',
      validateOnly: true,
    })

    expect(request).toStrictEqual({
      consent: { adPersonalization: 'CONSENT_DENIED', adUserData: 'CONSENT_GRANTED' },
      destinations: [
        {
          operatingAccount: { accountId: '1234567890', accountType: 'GOOGLE_ADS' },
          productDestinationId: '555',
        },
      ],
      encoding: 'HEX',
      events: [
        {
          adIdentifiers: { gclid: '...' },
          conversionValue: 1234.5,
          currency: 'USD',
          eventSource: 'WEB',
          eventTimestamp: '2026-09-01T12:00:00.000Z',
          transactionId: 'ORDER-1',
        },
      ],
      validateOnly: true,
    })
  })

  it('omits userData when ad user data consent is denied, even with identifiers present', () => {
    const event = baseEvent({
      consent: { adPersonalization: 'unknown', adUserData: 'denied', analyticsStorage: 'unknown' },
      identifiers: { google: { emailSha256: '<sha256>' } },
    })

    const request = buildIngestRequest(event, {
      conversionActionId: '555',
      operatingAccountId: '1234567890',
    })

    expect(request.events).toStrictEqual([
      {
        conversionValue: 1234.5,
        currency: 'USD',
        eventSource: 'WEB',
        eventTimestamp: '2026-09-01T12:00:00.000Z',
        transactionId: 'ORDER-1',
      },
    ])
    expect(request).toStrictEqual({
      consent: { adUserData: 'CONSENT_DENIED' },
      destinations: [
        {
          operatingAccount: { accountId: '1234567890', accountType: 'GOOGLE_ADS' },
          productDestinationId: '555',
        },
      ],
      encoding: 'HEX',
      events: [
        {
          conversionValue: 1234.5,
          currency: 'USD',
          eventSource: 'WEB',
          eventTimestamp: '2026-09-01T12:00:00.000Z',
          transactionId: 'ORDER-1',
        },
      ],
      validateOnly: false,
    })
  })

  it('falls back to eventKey for transactionId when it is missing', () => {
    const event = baseEvent({ attribution: { gclid: '...' }, transactionId: undefined })
    const request = buildIngestRequest(event, {
      conversionActionId: '555',
      operatingAccountId: '1234567890',
    })
    expect((request.events as Record<string, unknown>[])[0]?.transactionId).toBe('purchase:ORDER-1')
  })

  it('omits currency and conversionValue when valueCents is not present', () => {
    const event = baseEvent({ attribution: { gclid: '...' }, valueCents: undefined })
    const request = buildIngestRequest(event, {
      conversionActionId: '555',
      operatingAccountId: '1234567890',
    })
    const builtEvent = (request.events as Record<string, unknown>[])[0]
    expect(builtEvent?.currency).toBeUndefined()
    expect(builtEvent?.conversionValue).toBeUndefined()
  })

  it('drops user data when match is click-only, even with identifiers present (stale user data window)', () => {
    const event = baseEvent({
      attribution: { clickCapturedAt: '2026-08-01T00:00:00.000Z', gclid: '...' },
      identifiers: { google: { emailSha256: '<sha256>' } },
    })
    const request = buildIngestRequest(event, {
      conversionActionId: '555',
      match: 'click',
      operatingAccountId: '1234567890',
    })
    const builtEvent = (request.events as Record<string, unknown>[])[0]
    expect(builtEvent?.adIdentifiers).toStrictEqual({ gclid: '...' })
    expect(builtEvent?.userData).toBeUndefined()
  })

  it('drops the click id when match is user_data-only, even with a click id present (stale click window)', () => {
    const event = baseEvent({
      attribution: { clickCapturedAt: '2026-08-01T00:00:00.000Z', gclid: '...' },
      identifiers: { google: { emailSha256: '<sha256>' } },
    })
    const request = buildIngestRequest(event, {
      conversionActionId: '555',
      match: 'user_data',
      operatingAccountId: '1234567890',
    })
    const builtEvent = (request.events as Record<string, unknown>[])[0]
    expect(builtEvent?.adIdentifiers).toBeUndefined()
    expect(builtEvent?.userData).toStrictEqual({ userIdentifiers: [{ emailAddress: '<sha256>' }] })
  })

  it('includes both when match is both', () => {
    const event = baseEvent({
      attribution: { clickCapturedAt: '2026-08-01T00:00:00.000Z', gclid: '...' },
      identifiers: { google: { emailSha256: '<sha256>' } },
    })
    const request = buildIngestRequest(event, {
      conversionActionId: '555',
      match: 'both',
      operatingAccountId: '1234567890',
    })
    const builtEvent = (request.events as Record<string, unknown>[])[0]
    expect(builtEvent?.adIdentifiers).toStrictEqual({ gclid: '...' })
    expect(builtEvent?.userData).toStrictEqual({ userIdentifiers: [{ emailAddress: '<sha256>' }] })
  })
})
