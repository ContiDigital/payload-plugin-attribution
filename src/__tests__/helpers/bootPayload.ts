import type { CollectionConfig, Config, EmailAdapter, Payload } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConfig, getPayload } from 'payload'

import type { AttributionDispatcher, AttributionPluginOptions } from '../../types/index.js'

import { attributionPlugin } from '../../index.js'

// A minimal adapter so Payload does not warn "No email adapter provided" on every boot; tests
// never send mail. The boot logger level is 'error': unexpected errors still print, while
// routine info/warn output (job-run summaries, the plugin's intentional-path warnings) does not.
// Tests that exercise those paths spy on payload.logger and assert the message instead.
const silentTestEmailAdapter: EmailAdapter = () => ({
  name: 'silent-test-email-adapter',
  defaultFromAddress: 'test@example.com',
  defaultFromName: 'Attribution Tests',
  sendEmail: () => Promise.resolve(undefined),
})

export const postgresUrl = process.env.ATTRIBUTION_TEST_POSTGRES_URL || undefined
export const mongodbUrl = process.env.ATTRIBUTION_TEST_MONGODB_URL || undefined
if (postgresUrl && mongodbUrl) {
  throw new Error('Set ATTRIBUTION_TEST_POSTGRES_URL or ATTRIBUTION_TEST_MONGODB_URL, not both')
}
export const databaseName = postgresUrl ? 'Postgres' : mongodbUrl ? 'MongoDB' : 'SQLite'
// SQLite runs plugin-owned transactions one at a time; Postgres and MongoDB race for real.
export const isSqlite = !postgresUrl && !mongodbUrl

const runId = `${process.pid}_${Date.now()}`
const instances: Payload[] = []

// Drizzle skips the dev push when a schema matching the previous boot in this process was already pushed.
process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'

const database = async (label: string): Promise<Config['db']> => {
  if (mongodbUrl) {
    const { mongooseAdapter } = await import('@payloadcms/db-mongodb')
    return mongooseAdapter({
      connectOptions: { dbName: `attribution_${label}_${runId}` },
      // Unique indexes must exist before the duplicate-key tests run.
      ensureIndexes: true,
      url: mongodbUrl,
    })
  }
  if (!postgresUrl) {
    // libsql gives each transaction connection its own empty :memory: database.
    const directory = await mkdtemp(join(tmpdir(), `attribution-${label}-`))
    return sqliteAdapter({
      client: { url: `file:${join(directory, 'test.db')}` },
      transactionOptions: {},
    })
  }
  const { postgresAdapter } = await import('@payloadcms/db-postgres')
  return postgresAdapter({
    pool: { connectionString: postgresUrl },
    schemaName: `attribution_${label}_${runId}`,
  })
}

export const bootPayload = async (args: {
  collections?: CollectionConfig[]
  config?: Pick<Config, 'i18n' | 'jobs'>
  label: string
  options: AttributionPluginOptions
}): Promise<Payload> => {
  const config = buildConfig({
    ...args.config,
    admin: { user: 'users' },
    collections: [{ slug: 'users', auth: true, fields: [] }, ...(args.collections ?? [])],
    db: await database(args.label),
    email: silentTestEmailAdapter,
    logger: { options: { level: 'error' } },
    plugins: [attributionPlugin(args.options)],
    secret: 'test-payload-secret',
    telemetry: false,
    typescript: { autoGenerate: false },
  })
  const payload = await getPayload({ config, cron: false, key: `attribution-${args.label}` })
  instances.push(payload)
  return payload
}

export const destroyPayloads = async (): Promise<void> => {
  for (const payload of instances.splice(0)) {
    await payload.destroy()
  }
}

export type DispatchCall = Parameters<AttributionDispatcher['dispatch']>[0]

export const recordingDispatcher = (): {
  calls: DispatchCall[]
  dispatcher: AttributionDispatcher
  hooks: { onDispatch?: (call: DispatchCall) => Promise<void> }
} => {
  const calls: DispatchCall[] = []
  const hooks: { onDispatch?: (call: DispatchCall) => Promise<void> } = {}
  return {
    calls,
    dispatcher: {
      name: 'recording',
      dispatch: async (args) => {
        calls.push(args)
        await hooks.onDispatch?.(args)
      },
    },
    hooks,
  }
}
