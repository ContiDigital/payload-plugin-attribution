import { getPayload } from 'payload'

import type { Destination, PropertyPlan } from '../../src/index.js'

import { setupGa4Property, verifyDestination } from '../../src/index.js'
import config from '../payload.config.js'

const USAGE = `Usage:
  payload run dev/scripts/attribution.ts -- setup-ga4 --plan <file.json> [--apply] [--service-account-json-env <NAME> | --access-token-env <NAME>]
  payload run dev/scripts/attribution.ts -- verify --destination <ga4|googleAds|googleAdsAdjustment|meta> --event <id>

Reads the GA4 service account JSON from the environment variable named by
--service-account-json-env, defaulting to GOOGLE_SERVICE_ACCOUNT_JSON.
`

const VERIFY_DESTINATIONS: readonly Destination[] = [
  'ga4',
  'googleAds',
  'googleAdsAdjustment',
  'meta',
]

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      continue
    }
    const name = arg.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next)
      index += 1
    } else {
      flags.set(name, 'true')
    }
  }
  return flags
}

const parseEventId = (raw: string): number | string => (/^\d+$/.test(raw) ? Number(raw) : raw)

const isDestination = (value: string): value is Destination =>
  (VERIFY_DESTINATIONS as readonly string[]).includes(value)

function serviceAccountJsonFromEnv(flags: Map<string, string>): string {
  const envName = flags.get('service-account-json-env') ?? 'GOOGLE_SERVICE_ACCOUNT_JSON'
  const value = process.env[envName]
  if (!value) {
    throw new Error(`environment variable ${envName} is not set`)
  }
  return value
}

async function runSetupGa4(flags: Map<string, string>): Promise<void> {
  const planPath = flags.get('plan')
  if (!planPath) {
    throw new Error('setup-ga4 requires --plan <file.json>')
  }
  const { readFile } = await import('node:fs/promises')
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as PropertyPlan
  const apply = flags.get('apply') === 'true'
  const tokenEnv = flags.get('access-token-env')
  const token = tokenEnv ? process.env[tokenEnv] : undefined
  if (tokenEnv && !token) {
    throw new Error(`environment variable ${tokenEnv} is not set`)
  }
  const credentials = token
    ? { accessToken: () => token }
    : { serviceAccountJson: serviceAccountJsonFromEnv(flags) }

  const payload = await getPayload({ config, cron: false })
  try {
    const result = await setupGa4Property({ apply, payload, plan, ...credentials })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await payload.destroy()
  }
}

async function runVerify(flags: Map<string, string>): Promise<void> {
  const destination = flags.get('destination')
  const eventIdRaw = flags.get('event')
  if (!destination || !isDestination(destination)) {
    throw new Error(`verify requires --destination <${VERIFY_DESTINATIONS.join('|')}>`)
  }
  if (!eventIdRaw) {
    throw new Error('verify requires --event <id>')
  }

  const payload = await getPayload({ config, cron: false })
  try {
    const result = await verifyDestination({
      destination,
      eventId: parseEventId(eventIdRaw),
      payload,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await payload.destroy()
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)

  if (command === 'setup-ga4') {
    await runSetupGa4(flags)
    return
  }
  if (command === 'verify') {
    await runVerify(flags)
    return
  }
  process.stdout.write(USAGE)
  // payload run's bin wrapper calls process.exit(0) unconditionally once this script settles, so
  // exitCode alone would be silently overwritten; throw through the same path as every other
  // validation error below, which the top-level catch turns into a real process.exit(1).
  throw new Error(`unknown subcommand: ${command ?? '(none)'}`)
}

try {
  await main()
} catch (error) {
  process.stdout.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
