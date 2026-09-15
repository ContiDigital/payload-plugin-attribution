import type { Payload, PayloadRequest } from 'payload'

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createLocalReq } from 'payload'

import { COMMIT_MARKER_PREFIX, PLUGIN_SLUG } from '../../constants.js'
import { collectionSlugs } from '../../plugin/getPluginContext.js'
import { PluginError } from './errors.js'
import { createLogger } from './logger.js'

// Payload's drizzle adapter resolves commitTransaction even when COMMIT fails (for example
// SQLITE_BUSY while another connection reads), so on SQLite a plugin transaction writes a marker
// row and counts as committed only once that row is visible outside it.
const confirmSqliteCommit = async (payload: Payload, marker: string): Promise<void> => {
  const where = { key: { equals: marker } }
  const committed = await payload.db.findOne({ collection: collectionSlugs(payload).claims, where })
  if (!committed) {
    throw new PluginError(`${PLUGIN_SLUG}: the SQLite transaction did not commit`, 500)
  }
  try {
    await payload.db.deleteMany({ collection: collectionSlugs(payload).claims, where })
  } catch (error) {
    createLogger(payload).warn('could not remove a commit marker', { error, marker })
  }
}

const sqliteStarts = new WeakMap<Payload, Promise<void>>()
const ownedTransaction = new AsyncLocalStorage<{ payload: Payload; req: PayloadRequest }>()

// libsql keeps an unfinished statement on a connection whose BEGIN failed with SQLITE_BUSY; the
// next transaction on that connection cannot COMMIT and Payload's adapter swallows the failure,
// losing the write. Plugin-owned SQLite transactions in one process therefore run one at a time.
const oneAtATimeOnSqlite = async <T>(payload: Payload, run: () => Promise<T>): Promise<T> => {
  if (payload.db.name !== 'sqlite') {
    return run()
  }
  const previous = sqliteStarts.get(payload) ?? Promise.resolve()
  let release = (): void => undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  sqliteStarts.set(payload, tail)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (sqliteStarts.get(payload) === tail) {
      sqliteStarts.delete(payload)
    }
  }
}

export const currentTransactionReq = (payload: Payload): PayloadRequest | undefined => {
  const active = ownedTransaction.getStore()
  return active?.payload === payload ? active.req : undefined
}

export type TransactionOptions = { fresh?: boolean }

export async function withTransaction<T>(
  payload: Payload,
  req: PayloadRequest | undefined,
  work: (req: PayloadRequest) => Promise<T>,
  { fresh = false }: TransactionOptions = {},
): Promise<T> {
  if (!fresh && req && (await req.transactionID)) {
    return work(req)
  }
  // Re-entry from a callback inside a plugin-owned transaction joins it; waiting on the
  // SQLite serializer from there would deadlock.
  const active = currentTransactionReq(payload)
  if (active && !fresh) {
    return work(active)
  }
  // A fresh transaction inside an outer plugin transaction that holds a lock on the same row waits on itself.
  if (active && payload.db.name === 'sqlite') {
    throw new PluginError(
      `${PLUGIN_SLUG}: an independent transaction cannot start inside a plugin-owned SQLite transaction`,
      500,
    )
  }
  const local = await createLocalReq(req?.user ? { user: req.user } : {}, payload)
  return oneAtATimeOnSqlite(payload, async () => {
    const id = await payload.db.beginTransaction()
    if (id === null || id === undefined) {
      throw new PluginError(`${PLUGIN_SLUG}: database transactions must be enabled`, 500)
    }
    // Payload operations delete req.transactionID when they fail, so the id is kept here.
    local.transactionID = id
    let committed: { marker: null | string; result: T }
    try {
      const result = await ownedTransaction.run({ payload, req: local }, () => work(local))
      const marker = payload.db.name === 'sqlite' ? `${COMMIT_MARKER_PREFIX}${randomUUID()}` : null
      if (marker) {
        await payload.db.create({
          collection: collectionSlugs(payload).claims,
          data: { key: marker },
          req: local,
        })
      }
      await payload.db.commitTransaction(id)
      committed = { marker, result }
    } catch (error) {
      try {
        await payload.db.rollbackTransaction(id)
      } catch (rollbackError) {
        createLogger(payload).error('rollback failed after an error', rollbackError)
      }
      throw error
    }
    // COMMIT has run, so a missing marker is reported without rolling back a finished transaction,
    // still inside the serializer so no other plugin transaction begins during the check.
    if (committed.marker) {
      await confirmSqliteCommit(payload, committed.marker)
    }
    return committed.result
  })
}
