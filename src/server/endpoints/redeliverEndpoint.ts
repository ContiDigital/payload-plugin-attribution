import type { Endpoint, PayloadRequest } from 'payload'

import type { Destination, NormalizedOptions } from '../../types/index.js'

import { DESTINATIONS, MAX_TEXT_ID_LENGTH } from '../../constants.js'
import { redeliverConversion } from '../deliveries/redeliver.js'
import { ValidationError } from '../utilities/errors.js'
import { errorResponse, jsonResponse } from './errorResponse.js'
import { requireScope } from './requireScope.js'

type RedeliverBody = { destinations: Destination[] | undefined; force: boolean }

const DIGITS = /^\d+$/
const TEXT_ID = /^[\w-]+$/

const isDestination = (value: unknown): value is Destination =>
  typeof value === 'string' && (DESTINATIONS as readonly string[]).includes(value)

const parseEventId = (req: PayloadRequest): number | string => {
  const raw = req.routeParams?.id
  if (typeof raw === 'string') {
    if (req.payload.db.defaultIDType === 'number') {
      const id = Number(raw)
      if (DIGITS.test(raw) && Number.isSafeInteger(id)) {
        return id
      }
    } else if (raw.length <= MAX_TEXT_ID_LENGTH && TEXT_ID.test(raw)) {
      return raw
    }
  }
  throw new ValidationError('invalid_event_id')
}

const parseBody = async (req: PayloadRequest): Promise<RedeliverBody> => {
  const text = (await req.text?.()) ?? ''
  if (text.trim() === '') {
    return { destinations: undefined, force: false }
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ValidationError('invalid_json')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('invalid_body')
  }
  const { destinations, force } = body as Record<string, unknown>
  if (force !== undefined && typeof force !== 'boolean') {
    throw new ValidationError('invalid_force')
  }
  if (
    destinations !== undefined &&
    (!Array.isArray(destinations) ||
      destinations.length === 0 ||
      !destinations.every(isDestination))
  ) {
    throw new ValidationError('invalid_destinations')
  }
  return { destinations, force: force === true }
}

export const redeliverEndpoint = (options: NormalizedOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await requireScope(options, req, 'operate')
      const eventId = parseEventId(req)
      const { destinations, force } = await parseBody(req)
      const deliveries = await redeliverConversion({
        destinations,
        eventId,
        force,
        payload: req.payload,
        req,
      })
      return jsonResponse({
        deliveries: deliveries.map(({ id, destination, status }) => ({ id, destination, status })),
      })
    } catch (error) {
      return errorResponse(req.payload, error)
    }
  },
  method: 'post',
  path: `${options.apiBasePath}/events/:id/redeliver`,
})
