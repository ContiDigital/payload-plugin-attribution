import { POSTGRES_IDENTIFIER_LIMIT } from '../constants.js'
import { sha256 } from '../core/identifiers/normalize.js'

// Postgres enums are schema-wide and capped at 63 characters. The suffix carries
// the group name so two attribution groups in one collection never collide, and
// an over-long name is replaced by a hash of the full name.
export const boundedEnumName =
  (suffix: string) =>
  ({ tableName = '' }: { tableName?: string }): string => {
    const name = `enum_${tableName}_${suffix}`
    return name.length <= POSTGRES_IDENTIFIER_LIMIT ? name : `enum_${sha256(name).slice(0, 32)}`
  }
