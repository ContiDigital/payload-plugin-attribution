import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { checkPackageBoundary, referencesOf } from '../check-dts-boundary.mjs'

const checker = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-dts-boundary.mjs')
const roots: string[] = []

// Builds a fake package root. Unspecified entries get a clean default.
const fakePackage = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'dts-boundary-'))
  roots.push(root)
  const all = {
    'dist/exports/browser.d.ts': "export { createEventId } from '../web/browser.js'\n",
    'dist/exports/next.d.ts':
      "import { NextResponse } from 'next/server.js'\nexport type Response = NextResponse\n",
    'dist/web/browser.d.ts': 'export declare const createEventId: () => string\n',
    ...files,
  }
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

describe('referencesOf', () => {
  it('finds from, side-effect, inline import types, require and triple-slash references', () => {
    const content = [
      "import type { A } from 'a'",
      "export * from './b.js'",
      "import 'c'",
      "export declare const d: () => import('d').D",
      "import e = require('e')",
      '/// <reference types="node" />',
      '/// <reference path="./f.d.ts" />',
    ].join('\n')
    expect(referencesOf(content).map(({ kind, specifier }) => `${kind}:${specifier}`)).toEqual(
      expect.arrayContaining([
        'module:a',
        'module:./b.js',
        'module:c',
        'module:d',
        'module:e',
        'types:node',
        'path:./f.d.ts',
      ]),
    )
  })
})

describe('checkPackageBoundary', () => {
  it('passes a clean package where only /next uses next/server', async () => {
    const { failures } = await checkPackageBoundary(fakePackage({}))
    expect(failures).toEqual([])
  })

  it('fails on an inline import type reached through a re-exported relative file', async () => {
    const root = fakePackage({
      'dist/exports/next.d.ts': "export { configure } from '../web/configure.js'\n",
      'dist/web/configure.d.ts': 'export declare const configure: () => import("payload").Config\n',
    })
    const { failures } = await checkPackageBoundary(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('"payload"')
    expect(failures[0]).toContain('configure.d.ts')
  })

  it('fails on /// <reference types="node" />', async () => {
    const root = fakePackage({
      'dist/exports/browser.d.ts':
        '/// <reference types="node" />\nexport declare const a: Buffer\n',
    })
    const { failures } = await checkPackageBoundary(root)
    expect(failures).toEqual([expect.stringContaining('references types "node"')])
  })

  it('fails on /// <reference types="react-dom" />', async () => {
    const root = fakePackage({
      'dist/exports/browser.d.ts':
        '/// <reference types="react-dom" />\nexport declare const a: string\n',
    })
    const { failures } = await checkPackageBoundary(root)
    expect(failures).toEqual([expect.stringContaining('references types "react-dom"')])
  })

  it('follows /// <reference path> and inline relative import types', async () => {
    const root = fakePackage({
      'dist/exports/browser.d.ts':
        '/// <reference path="../web/globals.d.ts" />\nexport declare const a: import("../web/el.js").El\n',
      'dist/web/el.d.ts': "export type El = import('react').JSX.Element\n",
      'dist/web/globals.d.ts': "import '@payloadcms/ui'\n",
    })
    const { failures } = await checkPackageBoundary(root)
    expect(failures).toHaveLength(2)
    expect(failures.join('\n')).toContain('"react"')
    expect(failures.join('\n')).toContain('"@payloadcms/ui"')
  })

  it('fails when /browser imports next, or /next imports next beyond next/server', async () => {
    const root = fakePackage({
      'dist/exports/browser.d.ts': "export type { NextRequest } from 'next/server'\n",
      'dist/exports/next.d.ts': "export type { Metadata } from 'next'\n",
    })
    const { failures } = await checkPackageBoundary(root)
    expect(failures).toHaveLength(2)
  })

  it('fails closed on node: imports and on relative references that do not resolve', async () => {
    const root = fakePackage({
      'dist/exports/browser.d.ts': "import type { Readable } from 'node:stream'\n",
      'dist/exports/next.d.ts': "export * from './missing.js'\n",
    })
    const { failures } = await checkPackageBoundary(root)
    expect(failures).toHaveLength(2)
    expect(failures.join('\n')).toContain('does not resolve')
  })
})

describe('check-dts-boundary CLI', () => {
  it('exits 1 on a violation and 0 on a clean package', () => {
    const bad = fakePackage({
      'dist/exports/browser.d.ts': "export declare const a: import('payload').Config\n",
    })
    const failed = spawnSync(process.execPath, [checker, bad], { encoding: 'utf8' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('"payload"')

    const passed = spawnSync(process.execPath, [checker, fakePackage({})], { encoding: 'utf8' })
    expect(passed.status).toBe(0)
    expect(passed.stdout).toContain('Declaration boundary check passed')
  })
})
