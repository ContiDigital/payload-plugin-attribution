import { describe, expect, it } from 'vitest'

import type { ConsentPolicy, ConsentState } from '../../../types/index.js'

import { applyConsentPolicy } from '../consentPolicy.js'

describe('applyConsentPolicy', () => {
  it.each<[ConsentPolicy, ConsentState, ReturnType<typeof applyConsentPolicy>]>([
    ['ignore', 'granted', { allowed: true }],
    ['ignore', 'denied', { allowed: true }],
    ['ignore', 'unknown', { allowed: true }],
    ['withhold-denied', 'granted', { allowed: true }],
    ['withhold-denied', 'denied', { allowed: false, reason: 'consent_denied' }],
    ['withhold-denied', 'unknown', { allowed: true }],
    ['require-granted', 'granted', { allowed: true }],
    ['require-granted', 'denied', { allowed: false, reason: 'consent_denied' }],
    ['require-granted', 'unknown', { allowed: false, reason: 'consent_missing' }],
  ])('%s with adUserData %s', (policy, adUserData, expected) => {
    expect(applyConsentPolicy(policy, { adUserData })).toEqual(expected)
  })
})
