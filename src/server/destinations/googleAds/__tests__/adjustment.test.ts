import { describe, expect, it, vi } from 'vitest'

import type { ConversionEventDoc, DeliveryDoc } from '../../../../types/index.js'

import { withPluginContext } from '../../../../plugin/getPluginContext.js'
import { normalizeOptions } from '../../../../plugin/normalizeOptions.js'
import { prepareDataManagerAdjustment } from '../adjustment.js'
const now = new Date('2026-09-22T12:00:00Z')
const original = {
  id: 1,
  name: 'purchase',
  consent: { adPersonalization: 'granted', adUserData: 'granted', analyticsStorage: 'granted' },
  createdAt: '2026-09-21T12:00:00Z',
  currency: 'USD',
  eventKey: 'purchase:1',
  googleAdsAction: 'sale',
  googleAdsKind: 'conversion',
  occurredAt: '2026-09-21T12:00:00Z',
  revision: 1,
  transactionId: 'order-1',
  updatedAt: now.toISOString(),
  valueCents: 10000,
} as ConversionEventDoc
const refund = {
  ...original,
  id: 2,
  name: 'refund',
  adjustedValueCents: 6000,
  createdAt: now.toISOString(),
  googleAdsKind: 'restatement',
} as ConversionEventDoc
const setup = (status = 'sent') => {
  const find = vi.fn().mockResolvedValue({ docs: [] })
  const config = withPluginContext({} as never, normalizeOptions({ secret: 'test' }))
  const lookup = {
    originalConversion: vi.fn().mockResolvedValue({ delivery: { status }, event: original }),
    retracted: vi.fn(),
  }
  const args = { event: refund, lookup, now, payload: { config, find } as never }
  return { args, find, lookup }
}
describe('Data Manager adjustments', () => {
  it('preserves the original transaction and timestamp and restates the remaining net revenue', async () => {
    const { args } = setup()
    expect(await prepareDataManagerAdjustment(args)).toEqual({ ...original, valueCents: 6000 })
  })
  it('restates full refunds to zero without pretending to retract the count', async () => {
    const { args } = setup()
    expect(
      await prepareDataManagerAdjustment({ ...args, event: { ...refund, adjustedValueCents: 0 } }),
    ).toEqual({ ...original, valueCents: 0 })
    expect(
      await prepareDataManagerAdjustment({
        ...args,
        event: { ...refund, googleAdsKind: 'retraction' },
      }),
    ).toMatchObject({ kind: 'withheld', reason: 'data_manager_retraction_unsupported' })
  })
  it('waits until the original conversion has finished processing', async () => {
    const { args, find } = setup('retry')
    expect(await prepareDataManagerAdjustment(args)).toMatchObject({
      kind: 'wait',
      reason: 'awaiting_original',
    })
    expect(find).not.toHaveBeenCalled()
  })
  it('never creates a new conversion when the original failed', async () => {
    const { args } = setup('dead')
    expect(await prepareDataManagerAdjustment(args)).toMatchObject({
      kind: 'withheld',
      reason: 'original_not_delivered',
    })
  })
  it('supersedes an old unsent refund when a newer total exists, including manual replays', async () => {
    const { args, find } = setup()
    find.mockResolvedValueOnce({ docs: [{ id: 3 }] })
    expect(await prepareDataManagerAdjustment(args)).toMatchObject({
      kind: 'withheld',
      reason: 'superseded_adjustment',
    })
  })
  it('waits for earlier in-flight adjustments to avoid out-of-order value overwrites', async () => {
    const { args, find } = setup()
    find
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [{ id: 1 }] })
      .mockResolvedValueOnce({ docs: [{ id: 10 }] })
    expect(await prepareDataManagerAdjustment(args)).toMatchObject({
      kind: 'wait',
      reason: 'awaiting_prior_adjustment',
    })
  })
  it('finishes polling an already submitted older adjustment before allowing newer totals', async () => {
    const { args, find } = setup()
    const delivery = {
      response: { requestId: 'r-1', submittedAt: now.toISOString() },
    } as DeliveryDoc
    expect(await prepareDataManagerAdjustment({ ...args, delivery })).toMatchObject({
      valueCents: 6000,
    })
    expect(find).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(find.mock.calls[0])).toContain('less_than')
  })
})
