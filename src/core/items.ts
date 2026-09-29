import { validName } from './names.js'

export type Ga4Item = {
  [key: string]: number | string | undefined
  discount?: number
  item_id?: string
  item_name?: string
  price?: number
  quantity?: number
}

export function validateItems(items: unknown): items is Ga4Item[] {
  return (
    Array.isArray(items) &&
    items.length <= 200 &&
    items.every((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return false
      }
      const row = item as Record<string, unknown>
      if (!(
        (typeof row.item_id === 'string' && row.item_id.trim()) ||
        (typeof row.item_name === 'string' && row.item_name.trim())
      )) {
        return false
      }
      if (Object.keys(row).length > 42) {
        return false
      }
      return Object.entries(row).every(
        ([key, value]) =>
          validName(key) &&
          (typeof value === 'string'
            ? !value.includes('@')
            : typeof value === 'number' && Number.isFinite(value) && value >= 0),
      )
    })
  )
}
