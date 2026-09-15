import type { ConsentPolicy, ConsentState } from '../../types/index.js'

export function applyConsentPolicy(
  policy: ConsentPolicy,
  consent: { adUserData: ConsentState },
): { allowed: false; reason: 'consent_denied' | 'consent_missing' } | { allowed: true } {
  if (policy === 'ignore' || consent.adUserData === 'granted') {
    return { allowed: true }
  }
  if (consent.adUserData === 'denied') {
    return { allowed: false, reason: 'consent_denied' }
  }
  return policy === 'require-granted'
    ? { allowed: false, reason: 'consent_missing' }
    : { allowed: true }
}
