import type {
  ConsentPolicy,
  ConversionEventDoc,
  Destination,
  NormalizedOptions,
} from '../../types/index.js'

import { applyConsentPolicy } from './consentPolicy.js'

export type PlannedDelivery = {
  destination: Destination
  reason?: string
  status: 'pending' | 'withheld'
}

export function planDeliveries(
  event: Pick<
    ConversionEventDoc,
    'consent' | 'googleAdsAction' | 'googleAdsKind' | 'name' | 'revision'
  >,
  options: NormalizedOptions,
  requested: Partial<Record<Destination, boolean>> = {},
): PlannedDelivery[] {
  if (options.disabled) {
    return []
  }
  const { ga4, googleAds, meta } = options.destinations
  const consent = { adUserData: event.consent?.adUserData ?? 'unknown' }
  const plan: PlannedDelivery[] = []

  const add = (destination: Destination, policy: ConsentPolicy, withheldFor?: string): void => {
    if (requested[destination] === false) {
      return
    }
    const decision = applyConsentPolicy(policy, consent)
    const reason = withheldFor ?? (decision.allowed ? undefined : decision.reason)
    plan.push(
      reason ? { destination, reason, status: 'withheld' } : { destination, status: 'pending' },
    )
  }

  if (ga4?.enabled) {
    const notResent = event.revision > 1 && !ga4.resendRevisions
    // GA4 is analytics: a visitor who explicitly refused analytics storage is never sent,
    // whatever the ad consent policy says.
    const analyticsDenied = event.consent?.analyticsStorage === 'denied'
    add(
      'ga4',
      ga4.consentPolicy,
      notResent ? 'revision_not_resent' : analyticsDenied ? 'consent_denied' : undefined,
    )
  }
  const kind = event.googleAdsKind
  if (googleAds?.enabled && event.googleAdsAction && event.googleAdsAction !== 'none') {
    if (kind === 'conversion') {
      add('googleAds', googleAds.consentPolicy)
    }
    if (googleAds.adjustments.enabled && (kind === 'restatement' || kind === 'retraction')) {
      add('googleAdsAdjustment', googleAds.consentPolicy)
    }
  }
  if (meta?.enabled && Object.hasOwn(meta.events, event.name) && kind !== 'retraction') {
    const notResent = event.revision > 1 && !meta.resendRevisions
    add('meta', meta.consentPolicy, notResent ? 'revision_not_resent' : undefined)
  }
  return plan
}
