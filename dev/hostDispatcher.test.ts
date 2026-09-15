import type { AddressInfo } from 'node:net'
import type { Payload } from 'payload'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { recordConversion } from '../src/index.js'
import { devConfig } from './config.js'
import { drainOutbox, hostLedgerDispatcher, OUTBOX_SLUG } from './hostDispatcher.js'
import { createMockProviders } from './mockProviders.js'

describe('host ledger dispatcher', () => {
  const mock = createMockProviders()
  let directory = ''
  let payload: Payload

  beforeAll(async () => {
    process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'
    await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve))
    const { port } = mock.server.address() as AddressInfo
    directory = await mkdtemp(join(tmpdir(), 'attribution-outbox-'))
    payload = await getPayload({
      config: devConfig(
        {
          destinations: { ga4: { apiSecret: 'mock-api-secret', measurementId: 'G-MOCK000000' } },
          dispatcher: hostLedgerDispatcher(),
          endpoints: { ga4: `http://127.0.0.1:${port}` },
          secret: 'outbox-test-secret',
        },
        `file:${join(directory, 'outbox.db')}`,
        {
          // Keep this test's boot log quiet; the real dev server (which reuses devConfig)
          // still gets the default "no email adapter" reminder.
          email: () => ({
            name: 'silent-test-email-adapter',
            defaultFromAddress: 'test@example.com',
            defaultFromName: 'Attribution Tests',
            sendEmail: () => Promise.resolve(undefined),
          }),
          logger: { options: { level: 'error' } },
        },
      ),
      cron: false,
      key: 'attribution-outbox',
    })
  })

  afterAll(async () => {
    await payload?.destroy()
    await new Promise((resolve) => mock.server.close(resolve))
    await rm(directory, { force: true, recursive: true })
  })

  it('queues deliveries as outbox rows and delivers them when a worker drains the outbox', async () => {
    const event = await recordConversion({
      draft: {
        name: 'generate_lead',
        eventKey: 'lead:outbox-1',
        occurredAt: new Date().toISOString(),
        transactionId: 'outbox-1',
      },
      payload,
    })
    expect(event).not.toBeNull()

    const queued = await payload.find({ collection: OUTBOX_SLUG, overrideAccess: true })
    expect(queued.docs).toHaveLength(1)
    expect(payload.collections['payload-jobs']).toBeUndefined()
    expect(mock.requests).toEqual([])

    expect(await drainOutbox(payload)).toEqual({ processed: 1 })
    expect(mock.requests.map(({ provider }) => provider)).toEqual(['ga4'])
    const drained = await payload.find({ collection: OUTBOX_SLUG, overrideAccess: true })
    expect(drained.docs[0]).toMatchObject({
      processedAt: expect.any(String),
      result: { status: 'sent' },
    })
    expect(await drainOutbox(payload)).toEqual({ processed: 0 })
  })
})
