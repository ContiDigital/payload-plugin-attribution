import type {
  ConversionDraft,
  GoogleAdsAction,
  GoogleAdsKind,
  OriginalConversion,
} from '../../types/index.js'

export function resolveAdsTreatment(
  draft: ConversionDraft,
  original: OriginalConversion,
): { action: GoogleAdsAction; kind: GoogleAdsKind } {
  const action = draft.googleAds?.action ?? 'none'
  if (action === 'none') {
    return { action: 'none', kind: 'none' }
  }
  const requested = draft.googleAds?.kind ?? 'auto'
  if (requested === 'restatement' || requested === 'retraction' || requested === 'none') {
    return { action, kind: requested }
  }
  // requested is 'auto' or 'conversion' (the only kinds left after the early
  // return above). An original sharing this eventKey is a revision of this
  // very conversion, not a new or differing one, so both kinds agree here.
  const differentOriginal = original !== null && original.eventKey !== draft.eventKey
  if (!differentOriginal) {
    return { action, kind: 'conversion' }
  }
  return { action, kind: draft.name === 'purchase' ? 'restatement' : 'none' }
}
