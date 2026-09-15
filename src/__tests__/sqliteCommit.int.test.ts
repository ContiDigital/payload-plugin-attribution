import type { Payload } from 'payload'

import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { EVENTS_SLUG } from '../constants.js'
import { recordConversion } from '../server/record/recordConversion.js'
import {
  bootPayload,
  destroyPayloads,
  isSqlite,
  recordingDispatcher,
} from './helpers/bootPayload.js'

const { dispatcher } = recordingDispatcher()
let payload: Payload

beforeAll(async () => {
  if (!isSqlite) {
    return
  }
  payload = await bootPayload({
    collections: [{ slug: 'orders', fields: [{ name: 'title', type: 'text' }] }],
    label: 'sqlite_commit',
    options: {
      destinations: { ga4: { apiSecret: 'ga4-secret', measurementId: 'G-TEST' } },
      dispatcher,
      secret: 'sqlite-commit-secret',
    },
  })
})

afterAll(destroyPayloads)

describe.runIf(isSqlite)('plugin-owned commits on SQLite', () => {
  it('never returns an event that was not stored while the host writes concurrently', async () => {
    // Payload logs every SQLITE_BUSY it hits on begin; the test asserts outcomes instead.
    const errorLog = vi.spyOn(payload.logger, 'error').mockImplementation(() => undefined)
    let stop = false
    let hostWrites = 0
    const host = (async () => {
      while (!stop) {
        try {
          await payload.create({
            collection: 'orders' as never,
            data: { title: 'order' } as never,
            overrideAccess: true,
          })
          hostWrites += 1
        } catch {
          // Host writes may fail with SQLITE_BUSY; only the plugin's own results matter here.
        }
        await delay(10)
      }
    })()
    const phantom: string[] = []
    let returned = 0
    let thrown = 0
    for (let index = 0; index < 30; index++) {
      const eventKey = `sqlite-commit-${index}`
      try {
        const event = await recordConversion({
          draft: { name: 'generate_lead', eventKey, occurredAt: '2026-09-14T10:00:00.000Z' },
          payload,
        })
        if (event) {
          returned += 1
          const { totalDocs } = await payload.count({
            collection: EVENTS_SLUG as never,
            overrideAccess: true,
            where: { eventKey: { equals: eventKey } },
          })
          if (totalDocs === 0) {
            phantom.push(eventKey)
          }
        }
      } catch {
        thrown += 1
      }
      await delay(5)
    }
    stop = true
    await host
    expect(hostWrites).toBeGreaterThan(0)
    expect(returned + thrown).toBe(30)
    expect(phantom).toEqual([])
    errorLog.mockRestore()
  })
})
