import type { CollectionConfig, Field } from 'payload'

import type { NormalizedOptions } from '../types/index.js'
import type { CollectionMode } from './fieldHelpers.js'

import {
  CONSENT_STATES,
  DEFAULT_CURRENCY,
  DELIVERIES_PANEL_PATH,
  DELIVERY_STATUS_CELL_PATH,
  EVENT_SOURCES,
  GOOGLE_ADS_ACTIONS,
  GOOGLE_ADS_KINDS,
} from '../constants.js'
import { attributionField } from '../fields/attributionField.js'
import { dateField, denyAll, piiReadAccess, readAccess, readOnly } from './fieldHelpers.js'

export function conversionEvents(
  options: NormalizedOptions,
  mode: CollectionMode = {},
): CollectionConfig {
  const fields: Field[] = [
    { name: 'eventKey', type: 'text', index: true, required: true, unique: true },
    { name: 'eventId', type: 'text', index: true },
    { name: 'name', type: 'text', index: true, required: true },
    dateField('occurredAt', { index: true, required: true }),
    { name: 'revision', type: 'number', defaultValue: 1, required: true },
    { name: 'transactionId', type: 'text', index: true, maxLength: 64 },
    { name: 'valueCents', type: 'number' },
    { name: 'taxCents', type: 'number' },
    { name: 'shippingCents', type: 'number' },
    { name: 'currency', type: 'text', defaultValue: DEFAULT_CURRENCY },
    { name: 'channel', type: 'text', index: true },
    { name: 'eventSource', type: 'select', options: [...EVENT_SOURCES] },
    { name: 'userId', type: 'text' },
    { name: 'params', type: 'json' },
    { name: 'items', type: 'json' },
    { name: 'userProperties', type: 'json' },
    {
      name: 'subject',
      type: 'group',
      fields: [
        { name: 'collectionSlug', type: 'text' },
        { name: 'recordId', type: 'text' },
      ],
    },
    attributionField(),
    {
      name: 'consent',
      type: 'group',
      fields: (['adUserData', 'adPersonalization', 'analyticsStorage'] as const).map(
        (name): Field => ({
          name,
          type: 'select',
          defaultValue: 'unknown',
          options: [...CONSENT_STATES],
        }),
      ),
    },
    {
      name: 'identifiers',
      type: 'group',
      access: { read: piiReadAccess(options, mode) },
      fields: [
        { name: 'google', type: 'json' },
        { name: 'meta', type: 'json' },
      ],
    },
    {
      name: 'context',
      type: 'group',
      access: { read: piiReadAccess(options, mode) },
      fields: [
        { name: 'ipAddress', type: 'text' },
        { name: 'userAgent', type: 'text' },
        { name: 'url', type: 'text' },
      ],
    },
    dateField('identifiersPurgedAt'),
    { name: 'googleAdsAction', type: 'select', options: [...GOOGLE_ADS_ACTIONS] },
    { name: 'googleAdsKind', type: 'select', options: [...GOOGLE_ADS_KINDS] },
    { name: 'adjustedValueCents', type: 'number' },
    {
      name: 'deliverySummary',
      type: 'json',
      admin: { components: { Cell: DELIVERY_STATUS_CELL_PATH } },
    },
    {
      name: 'deliveriesPanel',
      type: 'ui',
      admin: {
        components: {
          Field: {
            clientProps: {
              apiBasePath: options.apiBasePath,
              deliveriesSlug: options.collections.deliveries,
            },
            path: DELIVERIES_PANEL_PATH,
          },
        },
      },
    },
    {
      name: 'deliveries',
      type: 'join',
      collection: options.collections.deliveries,
      on: 'event',
    },
  ]

  return {
    slug: options.collections.events,
    access: mode.schemaOnly ? { ...denyAll } : { ...denyAll, read: readAccess(options, mode) },
    admin: {
      defaultColumns: ['name', 'occurredAt', 'transactionId', 'valueCents', 'deliverySummary'],
      group: options.adminGroup,
      hidden: mode.schemaOnly === true,
      useAsTitle: 'eventKey',
    },
    fields: readOnly(fields),
    hooks: mode.schemaOnly
      ? undefined
      : {
          afterRead: [
            ({ doc }) => {
              // Payload reserves nested `id` and removes it while reading groups. Store
              // a non-reserved field, then preserve the public subject.id contract.
              if (doc.subject?.recordId != null) {
                doc.subject.id = doc.subject.recordId
              }
              return doc
            },
          ],
        },
    labels: { plural: 'Conversion events', singular: 'Conversion event' },
  }
}
