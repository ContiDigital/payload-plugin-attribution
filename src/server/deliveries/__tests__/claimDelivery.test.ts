import type { Payload } from 'payload'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DeliveryDoc } from '../../../types/index.js'

import { claimDelivery } from '../claimDelivery.js'

const withTransaction = vi.hoisted(() => vi.fn())
vi.mock('../../utilities/transaction.js', () => ({ withTransaction }))

const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
const payload = { logger } as unknown as Payload
const delivery = { id: 'delivery-1', attempt: 0, status: 'pending' } as unknown as DeliveryDoc

afterEach(() => {
  vi.clearAllMocks()
})

describe('claimDelivery transaction failures', () => {
  it.each([{ code: 112 }, { code: '112' }])(
    'returns null and logs at debug level for a MongoDB WriteConflict %o',
    async (conflict) => {
      withTransaction.mockRejectedValueOnce(
        Object.assign(new Error('Please retry your operation'), conflict),
      )
      expect(await claimDelivery(payload, delivery, new Date())).toBeNull()
      expect(withTransaction).toHaveBeenCalledTimes(1)
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ data: { deliveryId: 'delivery-1' } }),
      )
      expect(logger.warn).not.toHaveBeenCalled()
    },
  )

  it('propagates a transient transaction error that is not a WriteConflict', async () => {
    const stepdown = Object.assign(new Error('not primary'), {
      code: 10107,
      errorLabels: ['TransientTransactionError'],
    })
    withTransaction.mockRejectedValueOnce(stepdown)
    await expect(claimDelivery(payload, delivery, new Date())).rejects.toBe(stepdown)
    expect(withTransaction).toHaveBeenCalledTimes(1)
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('propagates a network error carrying only the transient label', async () => {
    const network = Object.assign(new Error('connection reset'), {
      errorLabels: ['TransientTransactionError'],
    })
    withTransaction.mockRejectedValueOnce(network)
    await expect(claimDelivery(payload, delivery, new Date())).rejects.toBe(network)
  })
})
