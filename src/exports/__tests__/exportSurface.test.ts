import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { Attribution, BrowserOptions, ConsentState, Touches } from '../browser.js'

import { DELIVERIES_PANEL_PATH, DELIVERY_STATUS_CELL_PATH } from '../../constants.js'

const external = ['payload', '@payloadcms/*', 'react', 'react-dom', 'next', 'next/*', 'node:*']

const importsOf = async (entry: string): Promise<string[]> => {
  const result = await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL(`../${entry}.ts`, import.meta.url))],
    external,
    logLevel: 'silent',
    metafile: true,
    platform: 'neutral',
    write: false,
  })
  const inputs = Object.values(result.metafile.inputs)
  expect(inputs.length).toBeGreaterThan(0)
  return inputs.flatMap((input) => input.imports.map((imported) => imported.path))
}

const serverOnly = (path: string): boolean =>
  path === 'payload' ||
  path.startsWith('@payloadcms/') ||
  path === 'react' ||
  path.startsWith('react/') ||
  path === 'react-dom' ||
  path.startsWith('react-dom/') ||
  path.startsWith('node:')

describe('edge and browser entry points', () => {
  it('keeps ./next free of payload, react and node modules', async () => {
    expect((await importsOf('next')).filter(serverOnly)).toEqual([])
  })

  it('keeps ./browser free of payload, react, next and node modules', async () => {
    const imports = await importsOf('browser')
    expect(imports.filter(serverOnly)).toEqual([])
    expect(imports.filter((path) => path === 'next' || path.startsWith('next/'))).toEqual([])
  })

  it('keeps request capture and cookie parsing free of next', async () => {
    for (const entry of ['../web/capture', '../web/cookie']) {
      const imports = await importsOf(entry)
      expect(imports.filter(serverOnly)).toEqual([])
      expect(imports.filter((path) => path === 'next' || path.startsWith('next/'))).toEqual([])
    }
  })

  it('keeps ./client free of the payload runtime and node modules', async () => {
    const imports = await importsOf('client')
    expect(imports.filter((path) => path === 'payload' || path.startsWith('node:'))).toEqual([])
    expect(imports).toContain('@payloadcms/ui')
  })

  it('exports the admin components named by the collection component paths from ./client', async () => {
    const source = await readFile(fileURLToPath(new URL('../client.ts', import.meta.url)), 'utf8')
    expect(source.startsWith("'use client'")).toBe(true)
    for (const path of [DELIVERY_STATUS_CELL_PATH, DELIVERIES_PANEL_PATH]) {
      const [entry, name] = path.split('#')
      expect(entry).toBe('payload-plugin-attribution/client')
      expect(source).toMatch(new RegExp(`export \\{ ${name} \\}`))
    }
  })

  it('exports the browser helpers and shared attribution types from ./browser', async () => {
    const api = await import('../browser.js')
    expect(typeof api.captureAttribution).toBe('function')
    expect(typeof api.attributionForSubmit).toBe('function')
    expect(typeof api.consentDefaults).toBe('function')
    expect(typeof api.trackClient).toBe('function')
    expect(typeof api.createEventId).toBe('function')
    expect(typeof api.sanitizeAttribution).toBe('function')
    // Type-only exports have no runtime presence; referencing them here fails typecheck
    // (not this test) if a future change drops one of them from ../browser.ts.
    const typeSurface: { a: Attribution; b: BrowserOptions; c: ConsentState; d: Touches } = {
      a: {},
      b: {},
      c: 'unknown',
      d: { first: {}, last: {} },
    }
    expect(typeSurface).toBeDefined()
  })

  it('exports the server recording, delivery and setup API from the root entry', async () => {
    const api = await import('../../index.js')
    for (const name of [
      'attributionPlugin',
      'attributionField',
      'payloadJobsDispatcher',
      'recordConversion',
      'redeliverConversion',
      'requestContextFromHeaders',
      'runDelivery',
      'setupGa4Property',
      'sweepDeliveries',
      'verifyDestination',
    ] as const) {
      expect(typeof api[name]).toBe('function')
    }
  })
})
