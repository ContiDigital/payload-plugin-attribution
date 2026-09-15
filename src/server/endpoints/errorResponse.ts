import type { Payload } from 'payload'

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type PluginError,
  ValidationError,
} from '../utilities/errors.js'
import { createLogger } from '../utilities/logger.js'

const STATUS_BY_ERROR: ReadonlyArray<readonly [new (message: string) => PluginError, number]> = [
  [ValidationError, 400],
  [ForbiddenError, 403],
  [NotFoundError, 404],
  [ConflictError, 409],
]

export const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, { headers: { 'Cache-Control': 'no-store' }, status })

export const errorResponse = (payload: Pick<Payload, 'logger'>, error: unknown): Response => {
  const mapped = STATUS_BY_ERROR.find(([type]) => error instanceof type)
  if (mapped && error instanceof Error) {
    return jsonResponse({ error: error.message }, mapped[1])
  }
  createLogger(payload).error('endpoint request failed', { error })
  return jsonResponse({ error: 'internal_error' }, 500)
}
