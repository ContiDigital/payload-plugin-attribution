import type { Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import { createLogger, redact } from '../logger.js'

const fakePayload = () => {
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
  return { logger, payload: { logger } as unknown as Payload }
}

describe('redact', () => {
  it('redacts secret-shaped keys at any depth and token-shaped values', () => {
    expect(
      redact({
        headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
        list: [{ api_key: 'k' }, 'ya29.a0Af', 'plain'],
        meta: { accessToken: 'EAABsbCS1iHgBAKZC', pixel: '123' },
        nested: { deeper: { clientSecret: 's', Cookie: 'c', password: 'pw', privateKey: 'p' } },
        pem: 'x\n-----BEGIN PRIVATE KEY-----\nabc',
        safe: 1,
      }),
    ).toEqual({
      headers: { authorization: '[redacted]', 'content-type': 'application/json' },
      list: [{ api_key: '[redacted]' }, '[redacted]', 'plain'],
      meta: { accessToken: '[redacted]', pixel: '123' },
      nested: {
        deeper: {
          clientSecret: '[redacted]',
          Cookie: '[redacted]',
          password: '[redacted]',
          privateKey: '[redacted]',
        },
      },
      pem: '[redacted]',
      safe: 1,
    })
  })

  it.each([
    [
      'an api_secret query parameter',
      'POST https://www.google-analytics.com/mp/collect?measurement_id=G-1&api_secret=abc123 failed',
      'POST https://www.google-analytics.com/mp/collect?measurement_id=G-1&api_secret=[redacted] failed',
    ],
    [
      'an access_token query parameter',
      'GET https://graph.facebook.com/v26.0/me?access_token=tok%2Fen&fields=id',
      'GET https://graph.facebook.com/v26.0/me?access_token=[redacted]&fields=id',
    ],
    [
      'Basic credentials',
      'header was Basic dXNlcjpwYXNz, rejected',
      'header was Basic [redacted], rejected',
    ],
    [
      'a Bearer token',
      'authorization: Bearer abc.def-ghi_jkl=',
      'authorization: Bearer [redacted]',
    ],
    ['a lower case bearer token', 'bearer abc123def456', 'bearer [redacted]'],
  ])('redacts %s inside a string value', (_label, input, expected) => {
    expect(redact({ detail: input, list: [input] })).toStrictEqual({
      detail: expected,
      list: [expected],
    })
  })

  it('leaves ordinary strings mentioning the words untouched', () => {
    expect(redact({ note: 'Basic plan, bearer of news, api_secret missing' })).toStrictEqual({
      note: 'Basic plan, bearer of news, api_secret missing',
    })
  })

  it('redacts credential patterns inside error messages', () => {
    const error = new Error('request to /mp/collect?api_secret=s3cr3t failed')
    expect(redact(error)).toStrictEqual({
      name: 'Error',
      message: 'request to /mp/collect?api_secret=[redacted] failed',
      stack: expect.any(String),
    })
  })

  it('serializes errors with redacted messages and tolerates cycles', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    const error = new Error('ya29.leaked')
    expect(redact({ cyclic, error })).toEqual({
      cyclic: { name: 'loop', self: '[circular]' },
      error: { name: 'Error', message: '[redacted]', stack: '[redacted]' },
    })
  })

  it('serializes error code and data through redaction', () => {
    const error = Object.assign(new Error('rejected'), {
      code: 'PERMISSION_DENIED',
      data: { detail: 'ok', token: 'secret-value' },
    })
    expect(redact(error)).toEqual({
      name: 'Error',
      code: 'PERMISSION_DENIED',
      data: { detail: 'ok', token: '[redacted]' },
      message: 'rejected',
      stack: expect.any(String),
    })
  })
})

describe('createLogger', () => {
  it('logs through payload.logger with the plugin prefix and redacted data', () => {
    const { logger, payload } = fakePayload()
    const log = createLogger(payload)
    log.warn('delivery failed', {
      headers: { authorization: 'Bearer x' },
      meta: { accessToken: 'EAAB...' },
    })
    expect(logger.warn).toHaveBeenCalledWith({
      data: { headers: { authorization: '[redacted]' }, meta: { accessToken: '[redacted]' } },
      msg: 'payload-plugin-attribution: delivery failed',
    })
    log.info('plain')
    expect(logger.info).toHaveBeenCalledWith({ msg: 'payload-plugin-attribution: plain' })
    log.debug('d', 1)
    expect(logger.debug).toHaveBeenCalledWith({ data: 1, msg: 'payload-plugin-attribution: d' })
    log.error('e', new Error('boom'))
    expect(logger.error).toHaveBeenCalledWith({
      data: { name: 'Error', message: 'boom', stack: expect.any(String) },
      msg: 'payload-plugin-attribution: e',
    })
  })
})
