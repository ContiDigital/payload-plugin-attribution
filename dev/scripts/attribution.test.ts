import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const payloadBin = fileURLToPath(new URL('../../node_modules/.bin/payload', import.meta.url))

// An unknown subcommand never boots Payload (the check happens before getPayload is called), so
// this spawns the real CLI entry point directly rather than mocking process.exit: payload run's
// bin wrapper calls process.exit(0) unconditionally once the imported script settles, which
// silently turns a validation failure into a successful exit unless the script exits itself.
describe('attribution CLI', () => {
  it('exits non-zero for an unknown subcommand', async () => {
    await expect(
      execFileAsync(payloadBin, ['run', 'dev/scripts/attribution.ts', '--', 'bogus-command'], {
        cwd: repoRoot,
        timeout: 30000,
      }),
    ).rejects.toMatchObject({ code: 1 })
  }, 30000)

  it('exits non-zero with no subcommand at all', async () => {
    await expect(
      execFileAsync(payloadBin, ['run', 'dev/scripts/attribution.ts'], {
        cwd: repoRoot,
        timeout: 30000,
      }),
    ).rejects.toMatchObject({ code: 1 })
  }, 30000)
})
