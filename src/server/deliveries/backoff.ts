import {
  BACKOFF_BASE_MS,
  BACKOFF_JITTER,
  BACKOFF_MAX_MS,
  RETRY_AFTER_MAX_MS,
} from '../../constants.js'

export function nextBackoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(Math.round(retryAfterMs), RETRY_AFTER_MAX_MS)
  }
  const exponent = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) - 1 : 0
  const base = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS)
  return Math.round(base * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * Math.random()))
}
