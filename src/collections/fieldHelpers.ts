import type { Access, DateField, Field, FieldAccess } from 'payload'

import type { NormalizedOptions } from '../types/index.js'

export type CollectionMode = { schemaOnly?: boolean }

const deny = (): boolean => false

// A host authorize callback that throws or rejects denies the read instead of failing it.
const authorized = async (
  options: NormalizedOptions,
  req: Parameters<NormalizedOptions['authorize']>[0]['req'],
  scope: 'pii' | 'read',
): Promise<boolean> => {
  try {
    return (await options.authorize({ req, scope })) === true
  } catch {
    return false
  }
}

export const readAccess = (options: NormalizedOptions, mode: CollectionMode): Access =>
  mode.schemaOnly ? deny : ({ req }) => authorized(options, req, 'read')

export const piiReadAccess = (options: NormalizedOptions, mode: CollectionMode): FieldAccess =>
  mode.schemaOnly ? deny : ({ req }) => authorized(options, req, 'pii')

// Frozen shared default: collections take a spread copy because Payload adds keys to access.
export const denyAll = Object.freeze({ create: deny, delete: deny, read: deny, update: deny })

export const dateField = (name: string, extras: Partial<DateField> = {}): Field =>
  ({
    name,
    type: 'date',
    ...extras,
    admin: { date: { pickerAppearance: 'dayAndTime' }, ...extras.admin },
  }) as Field

// Join fields reject admin.readOnly and ui fields store nothing, so both pass through unchanged.
export const readOnly = (fields: Field[]): Field[] =>
  fields.map((field) =>
    field.type === 'join' || field.type === 'ui'
      ? field
      : ({ ...field, admin: { ...field.admin, readOnly: true } } as Field),
  )
