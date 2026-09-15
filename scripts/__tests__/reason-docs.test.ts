import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Code that decides delivery outcomes, and the verify results that mirror them.
const SOURCES = [
  'src/server/deliveries',
  'src/server/destinations',
  'src/server/endpoints',
  'src/server/verify',
  'src/server/record/recordConversion.ts',
]

// Snake case literals in those files that are not delivery reasons.
const NOT_REASONS = new Map([
  ['already_sent', 'redelivery error, documented under Redelivery'],
  ['caller_aborted', 'internal sentinel; the row records aborted'],
  ['claimed_elsewhere', 'runDelivery result status, documented under Host dispatchers'],
  ['delivery_in_progress', 'redelivery error, documented under Redelivery'],
  ['identifiers_purged', 'redelivery error, documented under Redelivery'],
  ['identity_changed', 'recordConversion rejection, logged and returned as null'],
  ['internal_error', 'endpoint error body'],
  ['invalid_body', 'endpoint error body'],
  ['invalid_destinations', 'endpoint error body'],
  ['invalid_event_id', 'endpoint error body'],
  ['invalid_force', 'endpoint error body'],
  ['invalid_json', 'endpoint error body'],
  ['not_due', 'runDelivery result status, documented under Host dispatchers'],
  ['not_found', 'runDelivery result status, documented under Host dispatchers'],
  ['phone_call', 'Meta action source'],
  ['physical_store', 'Meta action source'],
  ['system_generated', 'Meta action source'],
  ['user_data', 'provider payload key'],
])

const REASON_LITERAL =
  /'([a-z]+(?:_[a-z0-9]+)+)'|(?:reason:\s*|withheld\(|retryOrDead\([^,]+,\s*|final\('[a-z]+',\s*)'([a-z0-9_]+)'/g

const sourceReasons = (): string[] => {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', ...SOURCES],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((file) => /\.tsx?$/.test(file) && !file.includes('__tests__/'))
  const found = new Set<string>()
  for (const file of files) {
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(REASON_LITERAL)) {
      found.add(match[1] ?? match[2])
    }
  }
  return [...found].filter((code) => !NOT_REASONS.has(code)).sort()
}

const reasonReference = (): string => {
  const workers = readFileSync(join(root, 'docs/workers.md'), 'utf8')
  const start = workers.indexOf('\n## Reasons\n')
  expect(start, 'docs/workers.md has a Reasons section').toBeGreaterThan(-1)
  const end = workers.indexOf('\n## ', start + 1)
  return workers.slice(start, end === -1 ? undefined : end)
}

describe('delivery reason reference', () => {
  it('finds the reasons the delivery code emits', () => {
    const reasons = sourceReasons()
    for (const known of [
      'consent_denied',
      'lease_expired',
      'retry_exhausted',
      'aborted',
      'timeout',
    ]) {
      expect(reasons).toContain(known)
    }
  })

  it('documents every reason in the docs/workers.md reference tables', () => {
    const reference = reasonReference()
    const missing = sourceReasons().filter((code) => !reference.includes(`\`${code}\``))
    expect(missing).toEqual([])
    expect(reference).toContain('`http_<status>`')
  })

  it('documents no reason the code no longer emits', () => {
    const emitted = new Set([...sourceReasons(), 'http_<status>'])
    const documented = [...reasonReference().matchAll(/^\| `([^`]+)`/gm)].map((match) => match[1])
    expect(documented.filter((code) => !emitted.has(code))).toEqual([])
  })
})
