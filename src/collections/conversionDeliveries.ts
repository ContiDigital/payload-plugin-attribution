import type { CollectionConfig } from 'payload'

import type { NormalizedOptions } from '../types/index.js'
import type { CollectionMode } from './fieldHelpers.js'

import { DELIVERY_STATUSES, DESTINATIONS } from '../constants.js'
import { dateField, denyAll, piiReadAccess, readAccess, readOnly } from './fieldHelpers.js'

export function conversionDeliveries(
  options: NormalizedOptions,
  mode: CollectionMode = {},
): CollectionConfig {
  return {
    slug: options.collections.deliveries,
    access: mode.schemaOnly ? { ...denyAll } : { ...denyAll, read: readAccess(options, mode) },
    admin: {
      defaultColumns: ['key', 'destination', 'status', 'attempt', 'nextAttemptAt'],
      group: options.adminGroup,
      hidden: mode.schemaOnly === true,
      useAsTitle: 'key',
    },
    fields: readOnly([
      {
        name: 'event',
        type: 'relationship',
        index: true,
        relationTo: options.collections.events,
        required: true,
      },
      {
        name: 'destination',
        type: 'select',
        index: true,
        options: [...DESTINATIONS],
        required: true,
      },
      { name: 'revision', type: 'number', required: true },
      { name: 'sequence', type: 'number', defaultValue: 0, required: true },
      { name: 'key', type: 'text', required: true, unique: true },
      {
        name: 'status',
        type: 'select',
        index: true,
        options: [...DELIVERY_STATUSES],
        required: true,
      },
      { name: 'reason', type: 'text' },
      { name: 'attempt', type: 'number', defaultValue: 0 },
      dateField('nextAttemptAt', { index: true }),
      dateField('leaseExpiresAt', { index: true }),
      dateField('lastDispatchedAt', { index: true }),
      dateField('deadlineAt'),
      dateField('sentAt'),
      dateField('firstServedAt'),
      dateField('lastServedAt'),
      { name: 'request', type: 'json', access: { read: piiReadAccess(options, mode) } },
      { name: 'response', type: 'json' },
    ]),
    indexes: [{ fields: ['status', 'nextAttemptAt'] }, { fields: ['status', 'updatedAt'] }],
    labels: { plural: 'Conversion deliveries', singular: 'Conversion delivery' },
  }
}
