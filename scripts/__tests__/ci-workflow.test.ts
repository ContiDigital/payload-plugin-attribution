import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')

// Top-level jobs, each as its raw YAML block.
const jobs = (): Map<string, string> => {
  const body = workflow.slice(workflow.indexOf('\njobs:\n') + 7)
  const result = new Map<string, string>()
  for (const block of body.split(/\n(?= {2}[\w-]+:\n)/)) {
    const name = /^ {2}([\w-]+):/.exec(block)?.[1]
    if (name) {
      result.set(name, block)
    }
  }
  return result
}

describe('CI Node floor', () => {
  it('never runs pnpm under Node 22.12.0, which pnpm refuses', () => {
    for (const [name, block] of jobs()) {
      const floor = block.search(/node-version: ['"]?22\.12\.0|node: \[[^\]]*22\.12\.0/)
      if (floor === -1) {
        continue
      }
      const after = block.slice(floor)
      expect({ job: name, runsPnpm: /run: pnpm |\$\{\{ matrix\.node \}\}/.test(after) }).toEqual({
        job: name,
        runsPnpm: false,
      })
    }
  })

  it('builds on Node 24, then runs the tests and runtime import checks on Node 22.12.0', () => {
    const floor = [...jobs().values()].find((block) => /node-version: ['"]?22\.12\.0/.test(block))
    expect(floor).toBeDefined()
    const text = floor ?? ''
    const order = [
      /node-version: 24/,
      /run: pnpm install --frozen-lockfile/,
      /run: pnpm build/,
      /node-version: ['"]?22\.12\.0/,
      /run: node node_modules\/vitest\/vitest\.mjs run/,
      /pack-smoke\.sh/,
    ].map((pattern) => text.search(pattern))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})
