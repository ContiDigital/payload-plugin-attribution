export const DAY_MS = 86_400_000
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000

// Clocks can disagree by a few minutes: a start slightly after the reference instant, within
// CLOCK_SKEW_TOLERANCE_MS, counts as age 0. Beyond that the age stays negative.
export function ageMs(fromMs: number, toMs: number): number {
  const raw = toMs - fromMs
  return raw < 0 && raw >= -CLOCK_SKEW_TOLERANCE_MS ? 0 : raw
}

export function parseIso(value: string | undefined): number | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}
