import type { Endpoint, Payload, PayloadRequest } from 'payload'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AuthorizeFn } from '../../../types/index.js'

import { normalizeOptions } from '../../../plugin/normalizeOptions.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utilities/errors.js'
import { redeliverEndpoint } from '../redeliverEndpoint.js'

const redeliver = vi.hoisted(() => vi.fn())
vi.mock('../../deliveries/redeliver.js', () => ({ redeliverConversion: redeliver }))

const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }

const endpointWith = (authorize: AuthorizeFn = () => true): Endpoint =>
  redeliverEndpoint(normalizeOptions({ authorize, secret: 'endpoint-secret' }))

type RequestArgs = { body?: string; id?: unknown; idType?: 'number' | 'text' }

const request = ({ body = '', idType = 'number', ...args }: RequestArgs = {}): PayloadRequest =>
  ({
    payload: { db: { defaultIDType: idType }, logger } as unknown as Payload,
    routeParams: { id: 'id' in args ? args.id : '7' },
    text: () => Promise.resolve(body),
    user: { id: 1, collection: 'users' },
  }) as unknown as PayloadRequest

const call = async (
  endpoint: Endpoint,
  req: PayloadRequest,
): Promise<{ body: unknown; headers: Headers; status: number }> => {
  const response = await endpoint.handler(req)
  return { body: await response.json(), headers: response.headers, status: response.status }
}

afterEach(() => {
  redeliver.mockReset()
  vi.clearAllMocks()
})

describe('redeliverEndpoint', () => {
  it('registers POST at {apiBasePath}/events/:id/redeliver', () => {
    const endpoint = endpointWith()
    expect(endpoint.method).toBe('post')
    expect(endpoint.path).toBe('/attribution/events/:id/redeliver')
  })

  it('answers 200 with the created deliveries and passes destinations and force through', async () => {
    redeliver.mockResolvedValue([
      { id: 11, destination: 'ga4', key: 'k', status: 'pending' },
      { id: 12, destination: 'meta', key: 'k2', status: 'withheld' },
    ])
    const req = request({ body: '{"destinations":["ga4","meta"],"force":true}' })
    const result = await call(endpointWith(), req)
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(result.body).toEqual({
      deliveries: [
        { id: 11, destination: 'ga4', status: 'pending' },
        { id: 12, destination: 'meta', status: 'withheld' },
      ],
    })
    expect(redeliver).toHaveBeenCalledWith({
      destinations: ['ga4', 'meta'],
      eventId: 7,
      force: true,
      payload: req.payload,
      req,
    })
  })

  it('treats an empty body as every destination without force', async () => {
    redeliver.mockResolvedValue([])
    const result = await call(endpointWith(), request())
    expect(result).toMatchObject({ body: { deliveries: [] }, status: 200 })
    expect(redeliver).toHaveBeenCalledWith(
      expect.objectContaining({ destinations: undefined, eventId: 7, force: false }),
    )
  })

  it('keeps text ids on adapters without numeric ids', async () => {
    redeliver.mockResolvedValue([])
    await call(endpointWith(), request({ id: '65f0c0ffee0123456789abcd', idType: 'text' }))
    expect(redeliver).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: '65f0c0ffee0123456789abcd' }),
    )
  })

  it.each<[string, RequestArgs]>([
    ['a non-numeric id on a numeric adapter', { id: 'abc' }],
    ['a missing id', { id: undefined }],
    ['an empty id', { id: '' }],
    ['an id beyond the safe integer range', { id: '9'.repeat(20) }],
    ['a text id with a path separator', { id: 'a/b', idType: 'text' }],
    ['malformed JSON', { body: '{"force":' }],
    ['a non-object body', { body: '["ga4"]' }],
    ['a non-boolean force', { body: '{"force":"yes"}' }],
    ['destinations that are not an array', { body: '{"destinations":"ga4"}' }],
    ['an empty destinations array', { body: '{"destinations":[]}' }],
    ['an unknown destination', { body: '{"destinations":["tiktok"]}' }],
  ])('answers 400 for %s without redelivering', async (_label, args) => {
    const result = await call(endpointWith(), request(args))
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: expect.any(String) })
    expect(redeliver).not.toHaveBeenCalled()
  })

  it('answers 403 before reading the request when operate is not authorized', async () => {
    const authorize = vi.fn(() => false)
    const result = await call(endpointWith(authorize), request({ id: 'x', body: 'not json' }))
    expect(result).toEqual({
      body: { error: 'forbidden' },
      headers: expect.any(Headers),
      status: 403,
    })
    expect(authorize).toHaveBeenCalledWith({ req: expect.anything(), scope: 'operate' })
    expect(redeliver).not.toHaveBeenCalled()
  })

  it('answers 403 when the host authorize callback throws', async () => {
    const authorize = vi.fn(() => {
      throw new Error('authorization backend down')
    })
    expect((await call(endpointWith(authorize), request())).status).toBe(403)
    expect(redeliver).not.toHaveBeenCalled()
  })

  it.each([
    [new NotFoundError('event_not_found'), 404],
    [new ConflictError('already_sent'), 409],
    [new ConflictError('delivery_in_progress'), 409],
    [new ValidationError('destination_not_applicable: meta'), 400],
  ])('maps %s to its status', async (error, status) => {
    redeliver.mockRejectedValue(error)
    const result = await call(endpointWith(), request())
    expect(result.status).toBe(status)
    expect(result.body).toEqual({ error: error.message })
  })

  it('answers 500 without leaking an unexpected error and logs it', async () => {
    redeliver.mockRejectedValue(new Error('connection refused at db.internal:5432'))
    const result = await call(endpointWith(), request())
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'internal_error' })
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
