import type { Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PluginError,
  ValidationError,
} from '../../utilities/errors.js'
import { errorResponse, jsonResponse } from '../errorResponse.js'

const payloadWithLogger = () => {
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
  return { logger, payload: { logger } as unknown as Payload }
}

describe('errorResponse', () => {
  it.each([
    [new ValidationError('invalid_body'), 400],
    [new ForbiddenError('forbidden'), 403],
    [new NotFoundError('event_not_found'), 404],
    [new ConflictError('already_sent'), 409],
  ])('maps %s to %i with its message', async (error, status) => {
    const { logger, payload } = payloadWithLogger()
    const response = errorResponse(payload, error)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: error.message })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('answers 500 for other plugin errors and unknown values, logging them', async () => {
    for (const error of [new PluginError('teapot', 418), new Error('secret detail'), 'thrown']) {
      const { logger, payload } = payloadWithLogger()
      const response = errorResponse(payload, error)
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'internal_error' })
      expect(logger.error).toHaveBeenCalledTimes(1)
    }
  })
})

describe('jsonResponse', () => {
  it('serializes JSON and disables caching', async () => {
    const response = jsonResponse({ ok: true }, 201)
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ ok: true })
  })
})
