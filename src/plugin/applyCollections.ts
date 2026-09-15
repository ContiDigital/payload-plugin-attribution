import type { CollectionConfig, Config } from 'payload'

import type { NormalizedOptions } from '../types/index.js'

import { conversionDeliveries } from '../collections/conversionDeliveries.js'
import { conversionEvents } from '../collections/conversionEvents.js'
import { deliveryClaims } from '../collections/deliveryClaims.js'
import { PLUGIN_SLUG } from '../constants.js'
import { sqlTableName } from './tableName.js'

const tableOf = (collection: CollectionConfig): string => {
  const fallback = sqlTableName(collection.slug)
  const { dbName } = collection
  const custom = typeof dbName === 'function' ? dbName({ tableName: fallback }) : dbName
  return custom || fallback
}

export const applyCollections = (config: Config, options: NormalizedOptions): Config => {
  const mode = { schemaOnly: options.disabled }
  const owned = [
    conversionEvents(options, mode),
    conversionDeliveries(options, mode),
    deliveryClaims(options),
  ]
  const existing = config.collections ?? []
  for (const collection of owned) {
    if (existing.some((candidate) => candidate.slug === collection.slug)) {
      throw new Error(`${PLUGIN_SLUG}: collection "${collection.slug}" is already registered`)
    }
    // Postgres and SQLite derive table names from slugs, so different slugs can share a table.
    const table = sqlTableName(collection.slug)
    const clash = existing.find((candidate) => tableOf(candidate) === table)
    if (clash) {
      throw new Error(
        `${PLUGIN_SLUG}: collection "${clash.slug}" uses the database table "${table}" that the plugin's "${collection.slug}" collection needs; set dbName on "${clash.slug}" or choose other slugs with the collections option`,
      )
    }
  }
  return { ...config, collections: [...existing, ...owned] }
}
