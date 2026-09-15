import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'

// Recommended for production.
export const postgres = postgresAdapter({ pool: { connectionString: process.env.DATABASE_URL } })

// Development only. SQLite transactions are off unless transactionOptions is set.
export const sqlite = sqliteAdapter({ client: { url: 'file:./local.db' }, transactionOptions: {} })

// Transactions need a replica set; a single node can run as a one-member replica set.
export const mongodb = mongooseAdapter({
  url: 'mongodb://127.0.0.1:27017/app?replicaSet=rs0',
})
