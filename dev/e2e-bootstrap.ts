import { rm } from 'node:fs/promises'
import { getPayload } from 'payload'

import { E2E_DATABASE_FILE, E2E_USER } from './e2eConstants.js'

if (process.env.DATABASE_URL !== `file:./${E2E_DATABASE_FILE}`) {
  throw new Error(`E2E bootstrap requires DATABASE_URL=file:./${E2E_DATABASE_FILE}`)
}

// A database left by an earlier run can drift from the schema and make Payload prompt interactively.
for (const suffix of ['', '-journal', '-shm', '-wal']) {
  await rm(`${E2E_DATABASE_FILE}${suffix}`, { force: true })
}

const { default: config } = await import('./payload.config.js')
// This CLI process has no Next.js server. An HMR socket can keep it alive after destroy().
process.env.DISABLE_PAYLOAD_HMR = 'true'
const payload = await getPayload({ config, cron: false })
try {
  await payload.create({ collection: 'users', data: E2E_USER })
} finally {
  await payload.destroy()
}
