import type { ConversionDraft, Ga4Item } from '../../types/index.js'

import { isMinorUnits } from '../../core/money.js'
import { validateItems } from './validateDraft.js'

export function resolveValueCents(
  draft: ConversionDraft,
  kind: string,
  policy: { formLeadValueCents?: number; leadValuePercent?: number },
): number | undefined {
  if (kind === 'retraction' && draft.name !== 'refund') {
    return 0
  }
  if (draft.valueCents !== undefined) {
    return draft.valueCents
  }
  if (draft.name === 'generate_lead') {
    if (draft.listPriceCents !== undefined) {
      return Math.round((draft.listPriceCents * (policy.leadValuePercent ?? 5)) / 100)
    }
    return policy.formLeadValueCents ?? 0
  }
  return undefined
}

export function buildItems(
  lines: Array<{
    attributes?: Record<string, number | string>
    discountCents?: number
    id: string
    name: string
    quantity?: number
    unitPriceCents: number
  }>,
): Ga4Item[] {
  const items = lines.map((line) => {
    if (
      !isMinorUnits(line.unitPriceCents) ||
      (line.discountCents !== undefined && !isMinorUnits(line.discountCents))
    ) {
      throw new TypeError('Item money must be nonnegative integer cents')
    }
    return {
      ...line.attributes,
      item_id: line.id,
      item_name: line.name,
      price: line.unitPriceCents / 100,
      quantity: line.quantity ?? 1,
      ...(line.discountCents === undefined ? {} : { discount: line.discountCents / 100 }),
    }
  })
  if (!validateItems(items)) {
    throw new TypeError('Invalid items')
  }
  return items
}

export function priceBand(valueCents: number, thresholds = [10000, 50000, 100000, 500000]): string {
  if (
    !isMinorUnits(valueCents) ||
    !thresholds.every(isMinorUnits) ||
    thresholds.some((n, i) => i > 0 && n <= thresholds[i - 1])
  ) {
    throw new TypeError('Invalid price bands')
  }
  const upper = thresholds.find((n) => valueCents < n)
  const lower = [...thresholds].reverse().find((n) => valueCents >= n) ?? 0
  return upper === undefined ? `${lower / 100}+` : `${lower / 100}-${upper / 100}`
}
