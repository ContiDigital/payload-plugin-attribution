import type { Payload } from 'payload'

import type {
  ConversionEventDoc,
  DeliveryDoc,
  DeliveryStatus,
  Destination,
  NormalizedOptions,
} from '../../types/index.js'

export type DestinationOutcome =
  | { deadlineAt: string; kind: 'wait'; reason: string; until: string }
  | { kind: 'dead'; reason: string; response?: unknown }
  | { kind: 'eligible' }
  | { kind: 'retry'; reason: string; response?: unknown; retryAfterMs?: number }
  | { kind: 'sent'; request?: unknown; response?: unknown }
  | { kind: 'withheld'; reason: string }

export type DeliveryLookup = {
  originalConversion: (
    event: ConversionEventDoc,
  ) => Promise<{ delivery: DeliveryDoc | null; event: ConversionEventDoc } | null>
  /** True when another retraction of the same order and action has reached Google. */
  retracted: (event: ConversionEventDoc) => Promise<boolean>
}

export type DestinationHandler = {
  deliver: (args: {
    delivery: DeliveryDoc
    event: ConversionEventDoc
    lookup: DeliveryLookup
    now: Date
    options: NormalizedOptions
    payload: Payload
    signal: AbortSignal
  }) => Promise<DestinationOutcome>
  destination: Destination
}

export type DeliveryResult = {
  deliveryId: number | string
  nextAttemptAt?: string
  reason?: string
  status: 'claimed_elsewhere' | 'not_due' | 'not_found' | DeliveryStatus
}
