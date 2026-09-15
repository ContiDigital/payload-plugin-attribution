import type { CollectionConfig } from 'payload'

import type { NormalizedOptions } from '../types/index.js'

import { dateField, denyAll } from './fieldHelpers.js'

export function deliveryClaims(options: NormalizedOptions): CollectionConfig {
  return {
    slug: options.collections.claims,
    access: { ...denyAll },
    admin: { hidden: true },
    fields: [
      { name: 'key', type: 'text', required: true, unique: true },
      { name: 'delivery', type: 'text', index: true },
      { name: 'token', type: 'text' },
      dateField('claimedAt'),
    ],
  }
}
