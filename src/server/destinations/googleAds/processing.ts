import type { DestinationOutcome } from '../types.js'

import { isAbortError } from '../../utilities/errors.js'

type Receipt = { polls?: number; requestId: string; submittedAt: string }
const POLL_MS = 30 * 60_000
const DEADLINE_MS = 25 * 60 * 60_000

export const processingReceipt = (value: unknown): Receipt | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const receipt = value as Partial<Receipt>
  return typeof receipt.requestId === 'string' &&
    receipt.requestId.length > 0 &&
    typeof receipt.submittedAt === 'string' &&
    Number.isFinite(Date.parse(receipt.submittedAt))
    ? (receipt as Receipt)
    : undefined
}

export const processingWait = (
  receipt: Receipt,
  now: Date,
  reason = 'google_processing',
): Extract<DestinationOutcome, { kind: 'wait' }> => ({
  deadlineAt: new Date(Date.parse(receipt.submittedAt) + DEADLINE_MS).toISOString(),
  kind: 'wait',
  reason,
  response: { ...receipt, polls: (receipt.polls || 0) + 1 },
  until: new Date(
    now.getTime() + Math.min(60 * 60_000, POLL_MS * 1.3 ** (receipt.polls || 0)),
  ).toISOString(),
})

// A successful ingest only acknowledges receipt. Never upload again while polling that receipt.
export async function verifyProcessing({
  now,
  origin,
  receipt,
  signal,
  token,
}: {
  now: Date
  origin: string
  receipt: Receipt
  signal: AbortSignal
  token: string
}): Promise<DestinationOutcome> {
  let response: Response
  try {
    const url = new URL('/v1/requestStatus:retrieve', origin)
    url.searchParams.set('requestId', receipt.requestId)
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal,
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    return processingWait(receipt, now, 'diagnostics_network_error')
  }
  if ([404, 429].includes(response.status) || response.status >= 500) {
    return processingWait(receipt, now, `diagnostics_http_${response.status}`)
  }
  if (!response.ok) {
    return { kind: 'dead', reason: `diagnostics_http_${response.status}`, response: receipt }
  }
  let result: {
    requestStatusPerDestination?: {
      errorInfo?: unknown
      eventsIngestionStatus?: { recordCount?: string }
      requestStatus?: string
      warningInfo?: unknown
    }[]
  }
  try {
    result = await response.json()
  } catch {
    return processingWait(receipt, now, 'invalid_diagnostics')
  }
  const statuses = result.requestStatusPerDestination
  if (!Array.isArray(statuses) || statuses.length !== 1) {
    return processingWait(receipt, now, 'missing_diagnostics')
  }
  const status = statuses[0]
  const detail = { ...receipt, ...status }
  if (status.requestStatus === 'SUCCESS') {
    if (status.eventsIngestionStatus?.recordCount !== '1') {
      return { kind: 'dead', reason: 'unexpected_record_count', response: detail }
    }
    return { kind: 'sent', response: detail }
  }
  if (['FAILED', 'FAILURE', 'PARTIAL_SUCCESS'].includes(status.requestStatus || '')) {
    return { kind: 'dead', reason: 'google_processing_failed', response: detail }
  }
  return processingWait(receipt, now)
}
