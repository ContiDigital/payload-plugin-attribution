import type { Config } from 'payload'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig } from 'payload'

import type { AttributionPluginOptions } from '../src/types/index.js'

import { attributionField, attributionPlugin } from '../src/index.js'
import { outboxCollection } from './hostDispatcher.js'

const directory = dirname(fileURLToPath(import.meta.url))

export function devConfig(
  options: AttributionPluginOptions = { secret: 'local-development-secret' },
  database = 'file:./dev/attribution.db',
  overrides: Partial<Config> = {},
) {
  return buildConfig({
    admin: {
      importMap: {
        baseDir: directory,
        importMapFile: join(directory, 'app/(payload)/admin/importMap.js'),
      },
      user: 'users',
    },
    collections: [
      { slug: 'users', auth: true, fields: [] },
      {
        slug: 'orders',
        admin: { useAsTitle: 'title' },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'totalCents', type: 'number' },
          attributionField(),
        ],
      },
      {
        slug: 'leads',
        admin: {
          defaultColumns: ['reference', 'name', 'email', 'createdAt'],
          useAsTitle: 'reference',
        },
        fields: [
          { name: 'reference', type: 'text', index: true, required: true, unique: true },
          { name: 'name', type: 'text', required: true },
          { name: 'email', type: 'email', required: true },
          { name: 'message', type: 'textarea' },
          attributionField(),
        ],
      },
      outboxCollection,
    ],
    db: database.startsWith('postgres')
      ? postgresAdapter({
          pool: { connectionString: database },
          push: true,
          schemaName: process.env.ATTRIBUTION_TEST_SCHEMA ?? 'attribution_dev',
        })
      : sqliteAdapter({ client: { url: database }, transactionOptions: {} }),
    plugins: [attributionPlugin(options)],
    secret: 'local-only-payload-development-secret',
    typescript: { autoGenerate: false },
    ...overrides,
  })
}
