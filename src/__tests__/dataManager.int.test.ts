import type { Payload } from 'payload'

import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'

import type { DeliveryDoc } from '../types/index.js'

import { runDelivery } from '../server/deliveries/runDelivery.js'
import { recordConversion } from '../server/record/recordConversion.js'
import { bootPayload, destroyPayloads, recordingDispatcher } from './helpers/bootPayload.js'
let payload: Payload
const start = new Date('2026-09-22T12:00:00Z')
const { dispatcher } = recordingDispatcher()
beforeAll(async () => {
  payload = await bootPayload({
    label: 'data_manager_refunds',
    options: {
      destinations: {
        googleAds: {
          accessToken: () => 'test-token',
          adjustments: { enabled: true, transport: 'dataManager' },
          conversionActions: { lead: '111', sale: '555' },
          operatingAccountId: '1234567890',
          transport: 'dataManager',
          verifyProcessing: true,
        },
      },
      dispatcher,
      secret: 'test',
    },
  })
})
afterAll(destroyPayloads)
afterEach(() => vi.unstubAllGlobals())
it('processes one purchase and a full refund through durable jobs and diagnostics', async () => {
  const fetchMock = vi.fn().mockImplementation((url: string | URL) =>
    Promise.resolve(
      String(url).includes('requestStatus:retrieve')
        ? Response.json({
            requestStatusPerDestination: [
              { eventsIngestionStatus: { recordCount: '1' }, requestStatus: 'SUCCESS' },
            ],
          })
        : Response.json({ requestId: 'provider-' + fetchMock.mock.calls.length }),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const purchase = await recordConversion({
    draft: {
      name: 'purchase',
      buyer: { email: 'test@example.com' },
      consent: { adUserData: 'granted' },
      currency: 'USD',
      eventKey: 'order:1:purchase',
      googleAds: { action: 'sale' },
      items: [{ item_id: 'product-1', price: 100, quantity: 1 }],
      occurredAt: start.toISOString(),
      transactionId: 'ORDER-0001',
      valueCents: 10000,
    },
    payload,
  })
  expect(purchase).not.toBeNull()
  const deliveryFor = async (id: number | string) =>
    (
      await payload.find({
        collection: 'conversion-deliveries' as never,
        depth: 0,
        overrideAccess: true,
        where: { event: { equals: id } },
      })
    ).docs[0] as unknown as DeliveryDoc
  const saleDelivery = await deliveryFor(purchase!.id)
  expect(await runDelivery({ deliveryId: saleDelivery.id, now: start, payload })).toMatchObject({
    reason: 'google_processing',
    status: 'retry',
  })
  const refund = await recordConversion({
    draft: {
      name: 'refund',
      consent: { adUserData: 'granted' },
      currency: 'USD',
      eventKey: 'order:1:refund:1',
      googleAds: { action: 'sale', adjustedValueCents: 0, kind: 'restatement' },
      occurredAt: new Date(start.getTime() + 60000).toISOString(),
      transactionId: 'ORDER-0001',
      valueCents: 10000,
    },
    payload,
  })
  const refundDelivery = await deliveryFor(refund!.id)
  expect(await runDelivery({ deliveryId: refundDelivery.id, now: start, payload })).toMatchObject({
    reason: 'awaiting_original',
    status: 'retry',
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const later = new Date(start.getTime() + 3600000)
  expect(await runDelivery({ deliveryId: saleDelivery.id, now: later, payload })).toMatchObject({
    status: 'sent',
  })
  expect(await runDelivery({ deliveryId: refundDelivery.id, now: later, payload })).toMatchObject({
    reason: 'google_processing',
    status: 'retry',
  })
  const uploads = fetchMock.mock.calls.filter(([url]) => String(url).includes('events:ingest'))
  expect(uploads).toHaveLength(2)
  const bodies = uploads.map(([, init]) => JSON.parse(init.body))
  expect(bodies[0].events[0]).toMatchObject({ conversionValue: 100, transactionId: 'ORDER-0001' })
  expect(bodies[1].events[0]).toMatchObject({
    conversionValue: 0,
    eventTimestamp: start.toISOString(),
    transactionId: 'ORDER-0001',
  })
  expect(bodies[1].destinations).toEqual(bodies[0].destinations)
  expect(
    await runDelivery({
      deliveryId: refundDelivery.id,
      now: new Date(later.getTime() + 3600000),
      payload,
    }),
  ).toMatchObject({ status: 'sent' })
  expect(fetchMock).toHaveBeenCalledTimes(4)
})
