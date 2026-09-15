import type { Payload, PayloadRequest } from 'payload'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConversionDraft, ConversionEventDoc } from '../../../types/index.js'

import { WRITE_CONFLICT_RETRY_DELAY_MS } from '../../../constants.js'
import { PluginError } from '../../utilities/errors.js'
import { recordConversion } from '../recordConversion.js'

const mocks = vi.hoisted(() => ({
  delay: vi.fn(() => Promise.resolve()),
  dispatch: vi.fn(() => Promise.resolve()),
  withTransaction: vi.fn(),
}))
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }))
vi.mock('../../utilities/transaction.js', () => ({
  currentTransactionReq: () => undefined,
  withTransaction: mocks.withTransaction,
}))
vi.mock('../../../plugin/getPluginContext.js', () => ({
  collectionSlugs: () => ({
    claims: 'conversion-delivery-claims',
    deliveries: 'conversion-deliveries',
    events: 'conversion-events',
  }),
  getPluginContext: () => ({
    options: {
      destinations: {},
      disabled: false,
      dispatcher: { dispatch: mocks.dispatch },
      identity: {},
      policy: {},
    },
  }),
}))

const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }

const draft: ConversionDraft = {
  name: 'generate_lead',
  eventKey: 'unit-write-conflict',
  occurredAt: '2026-09-14T10:00:00.000Z',
}

const event = { id: 'event-1', eventKey: draft.eventKey } as unknown as ConversionEventDoc

const writeConflict = () =>
  Object.assign(new Error('Please retry your operation'), {
    code: 112,
    errorLabels: ['TransientTransactionError'],
  })

afterEach(() => {
  vi.clearAllMocks()
})

describe('recordConversion MongoDB write conflicts', () => {
  it('retries an owned transaction once, after the wait, on a WriteConflict', async () => {
    const payload = { logger } as unknown as Payload
    mocks.withTransaction
      .mockRejectedValueOnce(writeConflict())
      .mockResolvedValueOnce({ event, pending: [] })
    expect(await recordConversion({ draft, payload })).toBe(event)
    expect(mocks.withTransaction).toHaveBeenCalledTimes(2)
    expect(mocks.delay).toHaveBeenCalledTimes(1)
    const [waited] = mocks.delay.mock.calls[0] as unknown as [number]
    expect(waited).toBeGreaterThanOrEqual(WRITE_CONFLICT_RETRY_DELAY_MS.min)
    expect(waited).toBeLessThanOrEqual(WRITE_CONFLICT_RETRY_DELAY_MS.max)
    expect(mocks.delay.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.withTransaction.mock.invocationCallOrder[1],
    )
  })

  it('propagates a second WriteConflict without retrying again', async () => {
    const payload = { logger } as unknown as Payload
    const second = writeConflict()
    mocks.withTransaction.mockRejectedValueOnce(writeConflict()).mockRejectedValueOnce(second)
    await expect(recordConversion({ draft, payload })).rejects.toBe(second)
    expect(mocks.withTransaction).toHaveBeenCalledTimes(2)
    expect(mocks.delay).toHaveBeenCalledTimes(1)
  })

  it('propagates a transient transaction error that is not a WriteConflict without retrying', async () => {
    const payload = { logger } as unknown as Payload
    const stepdown = Object.assign(new Error('not primary'), {
      code: 10107,
      errorLabels: ['TransientTransactionError'],
    })
    mocks.withTransaction.mockRejectedValueOnce(stepdown)
    await expect(recordConversion({ draft, payload })).rejects.toBe(stepdown)
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.delay).not.toHaveBeenCalled()
  })

  it('propagates a WriteConflict inside a joined host transaction without a retry', async () => {
    const conflict = writeConflict()
    const find = vi.fn(() => Promise.reject(conflict))
    const payload = { find, logger } as unknown as Payload
    const req = { transactionID: 'host' } as unknown as PayloadRequest
    await expect(recordConversion({ draft, payload, req })).rejects.toBe(conflict)
    expect(find).toHaveBeenCalledTimes(1)
    expect(mocks.withTransaction).not.toHaveBeenCalled()
    expect(mocks.delay).not.toHaveBeenCalled()
  })
})

describe('recordConversion purchase claims', () => {
  const order = 'unit-claim-order'
  const purchaseDraft: ConversionDraft = {
    name: 'purchase',
    eventKey: `thanks:${order}`,
    items: [{ item_id: 'artwork-1', price: 1200, quantity: 1 }],
    occurredAt: '2026-09-14T09:00:00.000Z',
    transactionId: order,
    valueCents: 120000,
  }
  const winner = {
    id: 'event-winner',
    name: 'purchase',
    eventKey: `webhook:${order}`,
    transactionId: order,
  } as unknown as ConversionEventDoc
  const req = { transactionID: 'host' } as unknown as PayloadRequest

  // The early lookups ran before a racing recording committed its claim and event; only the
  // statements after that see them.
  const racedPayload = (eventVisible: boolean) => {
    const find = vi
      .fn()
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValue({ docs: eventVisible ? [winner] : [] })
    const db = {
      create: vi.fn(() => Promise.resolve({})),
      findOne: vi.fn(() => Promise.resolve({ key: `purchase:${order}` })),
    }
    return { db, find, payload: { db, find, logger } as unknown as Payload }
  }

  it('returns the committed purchase when a claim appears with its event after the early lookup', async () => {
    const { db, find, payload } = racedPayload(true)
    expect(await recordConversion({ draft: purchaseDraft, payload, req })).toBe(winner)
    expect(find).toHaveBeenCalledTimes(3)
    expect(find.mock.calls[2][0]).toMatchObject({
      where: {
        and: [{ name: { equals: 'purchase' } }, { transactionId: { equals: order } }],
      },
    })
    expect(db.create).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('purchase already recorded for transaction'),
      }),
    )
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('throws the orphan PluginError only when the claim has no visible purchase event', async () => {
    const { db, payload } = racedPayload(false)
    const failure = await recordConversion({ draft: purchaseDraft, payload, req }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(PluginError)
    expect(String((failure as Error).message)).toContain(`purchase:${order}`)
    expect(db.create).not.toHaveBeenCalled()
  })
})
