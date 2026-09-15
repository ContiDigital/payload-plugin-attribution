import type { Payload, PayloadRequest } from 'payload'

import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'

import { PLUGIN_SLUG } from '../../../constants.js'
import { currentTransactionReq, withTransaction } from '../transaction.js'

vi.mock('payload', () => ({
  createLocalReq: vi.fn((options: { user?: unknown }) =>
    Promise.resolve(options.user ? { user: options.user } : {}),
  ),
}))

const fakePayload = (name = 'postgres') => {
  let next = 0
  const markers = new Set<string>()
  const db = {
    name,
    beginTransaction: vi.fn(() => Promise.resolve<null | string>(`tx-${++next}`)),
    commitTransaction: vi.fn(() => Promise.resolve()),
    rollbackTransaction: vi.fn(() => Promise.resolve()),
    // The SQLite commit marker: created in the transaction, read back after commit, then removed.
    create: vi.fn(({ data }: { data: { key: string } }) => {
      markers.add(data.key)
      return Promise.resolve(data)
    }),
    deleteMany: vi.fn(() => Promise.resolve()),
    findOne: vi.fn(({ where }: { where: { key: { equals: string } } }) =>
      Promise.resolve(markers.has(where.key.equals) ? { key: where.key.equals } : null),
    ),
  }
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
  const config = {
    custom: {
      [PLUGIN_SLUG]: { options: { collections: { claims: 'conversion-delivery-claims' } } },
    },
  }
  return { db, logger, markers, payload: { config, db, logger } as unknown as Payload }
}

describe('withTransaction', () => {
  it('joins a host transaction without beginning one or touching the request', async () => {
    const { db, payload } = fakePayload()
    const req = { transactionID: 'host' } as unknown as PayloadRequest
    const result = await withTransaction(payload, req, (joined) => {
      expect(joined).toBe(req)
      return Promise.resolve('done')
    })
    expect(result).toBe('done')
    expect(db.beginTransaction).not.toHaveBeenCalled()
    expect(db.commitTransaction).not.toHaveBeenCalled()
    expect(req.transactionID).toBe('host')
  })

  it('owns a transaction for a request without one and never mutates it', async () => {
    const { db, payload } = fakePayload()
    const user = { id: 1 }
    const req = { user } as unknown as PayloadRequest
    await withTransaction(payload, req, (local) => {
      expect(local).not.toBe(req)
      expect(local).toMatchObject({ transactionID: 'tx-1', user })
      return Promise.resolve()
    })
    expect(req.transactionID).toBeUndefined()
    expect(db.commitTransaction).toHaveBeenCalledWith('tx-1')
    expect(db.rollbackTransaction).not.toHaveBeenCalled()
  })

  it('rolls back and rethrows when the work fails', async () => {
    const { db, payload } = fakePayload()
    const failure = new Error('work failed')
    await expect(withTransaction(payload, undefined, () => Promise.reject(failure))).rejects.toBe(
      failure,
    )
    expect(db.rollbackTransaction).toHaveBeenCalledWith('tx-1')
    expect(db.commitTransaction).not.toHaveBeenCalled()
  })

  it('logs a failing rollback and rethrows the original error', async () => {
    const { db, logger, payload } = fakePayload()
    db.rollbackTransaction.mockRejectedValueOnce(new Error('rollback broke'))
    const failure = new Error('work failed')
    await expect(withTransaction(payload, undefined, () => Promise.reject(failure))).rejects.toBe(
      failure,
    )
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('rollback failed') }),
    )
  })

  it('refuses to run without database transactions', async () => {
    const { db, payload } = fakePayload()
    db.beginTransaction.mockResolvedValueOnce(null)
    await expect(withTransaction(payload, undefined, () => Promise.resolve())).rejects.toThrow(
      /transactions must be enabled/,
    )
  })

  it(
    'joins the active plugin-owned transaction on re-entry instead of waiting on SQLite',
    { timeout: 2000 },
    async () => {
      const { db, payload } = fakePayload('sqlite')
      expect(currentTransactionReq(payload)).toBeUndefined()
      await withTransaction(payload, undefined, (outer) => {
        expect(currentTransactionReq(payload)).toBe(outer)
        return withTransaction(payload, undefined, (inner) => {
          expect(inner).toBe(outer)
          return Promise.resolve()
        })
      })
      expect(db.beginTransaction).toHaveBeenCalledTimes(1)
      expect(db.commitTransaction).toHaveBeenCalledTimes(1)
      expect(currentTransactionReq(payload)).toBeUndefined()
    },
  )

  it('does not join a transaction owned for another Payload instance', async () => {
    const first = fakePayload()
    const second = fakePayload()
    await withTransaction(first.payload, undefined, () =>
      withTransaction(second.payload, undefined, () => Promise.resolve()),
    )
    expect(first.db.beginTransaction).toHaveBeenCalledTimes(1)
    expect(second.db.beginTransaction).toHaveBeenCalledTimes(1)
  })

  it('opens a fresh transaction that joins neither the host nor the active one', async () => {
    const { db, payload } = fakePayload()
    const host = { transactionID: 'host' } as unknown as PayloadRequest
    await withTransaction(payload, host, (outer) =>
      withTransaction(
        payload,
        host,
        (inner) => {
          expect(inner).not.toBe(outer)
          expect(inner.transactionID).toBe('tx-1')
          return Promise.resolve()
        },
        { fresh: true },
      ),
    )
    expect(db.beginTransaction).toHaveBeenCalledTimes(1)
    await withTransaction(payload, undefined, (owned) =>
      withTransaction(
        payload,
        undefined,
        (inner) => {
          expect(inner).not.toBe(owned)
          expect(currentTransactionReq(payload)).toBe(inner)
          return Promise.resolve()
        },
        { fresh: true },
      ),
    )
    expect(db.beginTransaction).toHaveBeenCalledTimes(3)
    expect(db.commitTransaction).toHaveBeenCalledTimes(3)
  })

  it(
    'refuses a fresh transaction inside a plugin-owned SQLite transaction',
    { timeout: 2000 },
    async () => {
      const { db, payload } = fakePayload('sqlite')
      await expect(
        withTransaction(payload, undefined, () =>
          withTransaction(payload, undefined, () => Promise.resolve(), { fresh: true }),
        ),
      ).rejects.toThrow(/independent transaction/)
      expect(db.beginTransaction).toHaveBeenCalledTimes(1)
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1)
    },
  )

  it('runs independent plugin-owned SQLite transactions one at a time', async () => {
    const { payload } = fakePayload('sqlite')
    let active = 0
    let peak = 0
    const work = async () => {
      active++
      peak = Math.max(peak, active)
      await delay(5)
      active--
    }
    await Promise.all([
      withTransaction(payload, undefined, work),
      withTransaction(payload, undefined, work),
      withTransaction(payload, undefined, work),
    ])
    expect(peak).toBe(1)
  })

  it('throws instead of returning when a SQLite commit silently did not persist', async () => {
    const { db, markers, payload } = fakePayload('sqlite')
    db.commitTransaction.mockImplementationOnce(() => {
      markers.clear()
      return Promise.resolve()
    })
    await expect(
      withTransaction(payload, undefined, () => Promise.resolve('phantom')),
    ).rejects.toThrow(/did not commit/)
    await expect(
      withTransaction(payload, undefined, () => Promise.resolve('stored')),
    ).resolves.toBe('stored')
    expect(db.deleteMany).toHaveBeenCalledTimes(1)
  })

  it('does not roll back a transaction whose COMMIT already ran when the marker is missing', async () => {
    const { db, markers, payload } = fakePayload('sqlite')
    db.commitTransaction.mockImplementationOnce(() => {
      markers.clear()
      return Promise.resolve()
    })
    await expect(withTransaction(payload, undefined, () => Promise.resolve())).rejects.toThrow(
      /did not commit/,
    )
    expect(db.commitTransaction).toHaveBeenCalledTimes(1)
    expect(db.rollbackTransaction).not.toHaveBeenCalled()
  })

  it('writes no commit marker outside SQLite', async () => {
    const { db, payload } = fakePayload()
    await withTransaction(payload, undefined, () => Promise.resolve())
    expect(db.create).not.toHaveBeenCalled()
    expect(db.findOne).not.toHaveBeenCalled()
  })
})
