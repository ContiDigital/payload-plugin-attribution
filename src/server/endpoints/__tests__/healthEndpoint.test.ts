import type { Endpoint, Payload, PayloadRequest, Where } from 'payload'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthorizeFn } from '../../../types/index.js'

import { DELIVERIES_SLUG, PLUGIN_SLUG } from '../../../constants.js'
import { normalizeOptions } from '../../../plugin/normalizeOptions.js'
import { healthEndpoint } from '../healthEndpoint.js'

const NOW = new Date('2026-09-14T12:00:00.000Z')
const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }

const endpointWith = (authorize: AuthorizeFn = () => true): Endpoint =>
  healthEndpoint(normalizeOptions({ authorize, secret: 'endpoint-secret' }))

const STATUS_COUNTS: Record<string, number> = {
  dead: 2,
  eligible: 4,
  pending: 3,
  retry: 1,
  sending: 5,
  sent: 40,
  served: 6,
  superseded: 7,
  withheld: 8,
}

const countFor = ({ where }: { where: Where }): number => {
  const text = JSON.stringify(where)
  if (text.includes('leaseExpiresAt')) {
    return 2
  }
  if (text.includes('updatedAt')) {
    return 1
  }
  return STATUS_COUNTS[(where.status as { equals: string }).equals]
}

const setup = (
  oldest: Array<{ createdAt: string }> = [{ createdAt: '2026-09-14T10:00:00.000Z' }],
) => {
  const count = vi.fn((args: { where: Where }) => Promise.resolve({ totalDocs: countFor(args) }))
  const find = vi.fn(() => Promise.resolve({ docs: oldest }))
  const req = {
    payload: {
      config: {
        custom: { [PLUGIN_SLUG]: { options: normalizeOptions({ secret: 'endpoint-secret' }) } },
      },
      count,
      find,
      logger,
    } as unknown as Payload,
    user: { id: 1, collection: 'users' },
  } as unknown as PayloadRequest
  return { count, find, req }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('healthEndpoint', () => {
  it('registers GET at {apiBasePath}/health', () => {
    const endpoint = endpointWith()
    expect(endpoint.method).toBe('get')
    expect(endpoint.path).toBe('/attribution/health')
  })

  it('reports status counts, the oldest pending delivery, expired leases and recent dead rows', async () => {
    const { count, find, req } = setup()
    const response = await endpointWith().handler(req)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      counts: STATUS_COUNTS,
      deadLast24h: 1,
      expiredLeases: 2,
      oldestPendingAt: '2026-09-14T10:00:00.000Z',
    })
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: DELIVERIES_SLUG,
        overrideAccess: true,
        where: {
          and: [
            { status: { equals: 'sending' } },
            { leaseExpiresAt: { less_than: NOW.toISOString() } },
          ],
        },
      }),
    )
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          and: [
            { status: { equals: 'dead' } },
            { updatedAt: { greater_than_equal: '2026-09-13T12:00:00.000Z' } },
          ],
        },
      }),
    )
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: DELIVERIES_SLUG,
        limit: 1,
        overrideAccess: true,
        sort: 'createdAt',
        where: { status: { equals: 'pending' } },
      }),
    )
  })

  it('reports a null oldestPendingAt when nothing is pending', async () => {
    const { req } = setup([])
    const body = (await (await endpointWith().handler(req)).json()) as Record<string, unknown>
    expect(body.oldestPendingAt).toBeNull()
  })

  it('answers 403 without querying when read is not authorized', async () => {
    const authorize = vi.fn(() => false)
    const { count, find, req } = setup()
    const response = await endpointWith(authorize).handler(req)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
    expect(authorize).toHaveBeenCalledWith({ req, scope: 'read' })
    expect(count).not.toHaveBeenCalled()
    expect(find).not.toHaveBeenCalled()
  })

  it('answers 500 without leaking a database error', async () => {
    const { count, req } = setup()
    count.mockRejectedValueOnce(new Error('relation does not exist'))
    const response = await endpointWith().handler(req)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'internal_error' })
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
