// Retry-After is either a delay in seconds or an HTTP date; both GA4 and Google Ads honour either form.
export function retryAfterMs(headers: Headers, now: Date): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) {
    return undefined
  }
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000
  }
  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) {
    return undefined
  }
  const diff = at - now.getTime()
  return diff > 0 ? diff : undefined
}
