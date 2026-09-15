import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('package.json')) as {
  engines: Record<string, string>
  peerDependencies: Record<string, string>
}

describe('Next.js proxy samples', () => {
  it('ships a compiled Next 16 proxy.ts and Next 15 middleware.ts sample with the right exports', async () => {
    const proxy = (await import('../../dev/docs-samples/proxy.js')) as Record<string, unknown>
    const middleware = (await import('../../dev/docs-samples/middleware.js')) as Record<
      string,
      unknown
    >
    expect(typeof proxy.proxy).toBe('function')
    expect(proxy.middleware).toBeUndefined()
    expect(typeof middleware.middleware).toBe('function')
    expect(middleware.proxy).toBeUndefined()
    expect(middleware.config).toEqual(proxy.config)
  })

  it.each(['README.md', 'docs/web-capture.md'])('shows both forms in %s', (page) => {
    const content = read(page)
    expect(content).toContain('<!-- sample: proxy.ts -->')
    expect(content).toContain('<!-- sample: middleware.ts -->')
  })
})

describe('peer and engine floors', () => {
  it('requires the Next.js version Payload itself requires, and keeps Node 22.12.0', () => {
    expect(manifest.peerDependencies.next).toBe('>=15.2.9 <17')
    expect(manifest.engines.node).toBe('>=22.12.0')
    for (const page of ['README.md', 'docs/installation.md']) {
      expect(read(page)).toContain('`>=15.2.9 <17`')
      expect(read(page)).not.toContain('15.2.0')
    }
  })
})
