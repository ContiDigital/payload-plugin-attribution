import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  checkDocumentationSamples,
  checkFileContent,
  checkLegacyDirectoriesOnDisk,
  checkTrackedPaths,
  documentationSamples,
  hasNulByte,
  importSpecifiersOf,
  isBannedImportSpecifier,
  isDocumentationFile,
  isSampleFile,
  LEAK_PATTERNS_FILE,
  loadLeakPatterns,
  normalizeSample,
  parseLeakPatterns,
} from '../check-repository.mjs'

// Assembled from fragments so this file does not trip the rules it exercises.
const NOTE_TOKEN = ['hand', 'off'].join('')
const TOOL_TOKEN = ['co', 'dex'].join('')
const HOME = ['/ho', 'me/'].join('')
const USERS = ['/Us', 'ers/'].join('')
const OWNER_APPROVAL = ['owner', 'approval'].join(' ')
const PRE_RELEASE_REVIEW = ['pre-release', 'review'].join(' ')

const FENCE = '```'
const sampled = (name: string, code: string, language = 'ts') =>
  `<!-- sample: ${name} -->\n\n${FENCE}${language}\n${code}${FENCE}\n`

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-repository.mjs')
const scratchRoots: string[] = []

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

// A throwaway git repository whose path contains a space, with the script copied into its
// scripts/ directory (untracked, so it is not scanned) and `tracked` files staged.
const fixtureRepo = (tracked: Record<string, string>) => {
  const parent = mkdtempSync(join(tmpdir(), 'repo-check-'))
  scratchRoots.push(parent)
  const root = join(parent, 'checkout with space')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(script, join(root, 'scripts', 'check-repository.mjs'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [path, content] of Object.entries(tracked)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
    execFileSync('git', ['add', path], { cwd: root })
  }
  return { parent, root }
}

const run = (scriptPath: string) =>
  spawnSync(process.execPath, [scriptPath], { cwd: tmpdir(), encoding: 'utf8' })

describe('check-repository CLI', () => {
  it('exits 0 on a clean repository whose path contains a space', () => {
    const { root } = fixtureRepo({ 'README.md': '# clean\n' })
    const result = run(join(root, 'scripts', 'check-repository.mjs'))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Repository checks passed for 1 tracked file(s).')
  })

  it('exits 1 on a violation when the path contains a space', () => {
    const { root } = fixtureRepo({ 'README.md': `see ${NOTE_TOKEN}_NOTES\n` })
    const result = run(join(root, 'scripts', 'check-repository.mjs'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('leaked identifier "process note" in README.md')
  })

  it('exits 1 on a violation when invoked through a symlinked checkout', () => {
    const { parent, root } = fixtureRepo({ 'README.md': `see ${NOTE_TOKEN}_NOTES\n` })
    const link = join(parent, 'linked-checkout')
    symlinkSync(root, link, 'dir')
    const result = run(join(link, 'scripts', 'check-repository.mjs'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('leaked identifier "process note"')
  })

  it('applies an untracked local .leak-patterns file to every tracked file', () => {
    const { root } = fixtureRepo({
      'README.md': 'Built for Acme_Widgets\n',
      'scripts/notes.mjs': "export const client = 'globex-corp.example'\n",
    })
    writeFileSync(join(root, LEAK_PATTERNS_FILE), '# fictional clients\nacme.?widgets\n\nglobex\n')
    const result = run(join(root, 'scripts', 'check-repository.mjs'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('leaked identifier "local pattern 2" in README.md')
    expect(result.stderr).toContain('leaked identifier "local pattern 4" in scripts/notes.mjs')
  })

  it('passes the same content when no local patterns file exists', () => {
    const { root } = fixtureRepo({ 'README.md': 'Built for Acme_Widgets\n' })
    const result = run(join(root, 'scripts', 'check-repository.mjs'))
    expect(result.status).toBe(0)
  })

  it('fails with the line number when a local pattern is not a valid regular expression', () => {
    const { root } = fixtureRepo({ 'README.md': '# clean\n' })
    writeFileSync(join(root, LEAK_PATTERNS_FILE), 'acme\n(unclosed\n')
    const result = run(join(root, 'scripts', 'check-repository.mjs'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`invalid regular expression in ${LEAK_PATTERNS_FILE}:2`)
  })

  it('fails when the local patterns file is tracked', () => {
    const { root } = fixtureRepo({ [LEAK_PATTERNS_FILE]: 'acme\n' })
    const result = run(join(root, 'scripts', 'check-repository.mjs'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`local leak patterns file is tracked: ${LEAK_PATTERNS_FILE}`)
  })

  it('exits 1 when a docs page drifts from its compiled sample', () => {
    const { root } = fixtureRepo({
      'dev/docs-samples/proxy.ts': "export const proxy = 'current'\n",
      'docs/web-capture.md': sampled('proxy.ts', "export const proxy = 'stale'\n"),
    })
    const result = run(join(root, 'scripts', 'check-repository.mjs'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'docs sample drift: docs/web-capture.md:3 differs from dev/docs-samples/proxy.ts',
    )
  })

  it('exits 0 when every docs fence matches its tracked sample', () => {
    const { root } = fixtureRepo({
      'dev/docs-samples/proxy.ts': "export const proxy = 'current'\n",
      'README.md': sampled('proxy.ts', "export const proxy = 'current'\n"),
    })
    const result = run(join(root, 'scripts', 'check-repository.mjs'))
    expect(result.status).toBe(0)
  })

  it('exits 1 when an untracked src/legacy directory exists', () => {
    const { root } = fixtureRepo({ 'README.md': '# clean\n' })
    mkdirSync(join(root, 'src', 'legacy'), { recursive: true })
    writeFileSync(join(root, 'src', 'legacy', 'old.ts'), 'export {}\n')
    const result = run(join(root, 'scripts', 'check-repository.mjs'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('legacy directory exists on disk: src/legacy')
  })
})

describe('checkLegacyDirectoriesOnDisk', () => {
  it('reports src/legacy and src/web/legacy only when they exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-check-'))
    scratchRoots.push(root)
    expect(checkLegacyDirectoriesOnDisk(root)).toEqual([])
    mkdirSync(join(root, 'src', 'web', 'legacy'), { recursive: true })
    expect(checkLegacyDirectoriesOnDisk(root)).toEqual([
      'legacy directory exists on disk: src/web/legacy',
    ])
    mkdirSync(join(root, 'src', 'legacy'))
    expect(checkLegacyDirectoriesOnDisk(root)).toHaveLength(2)
  })
})

describe('hasNulByte', () => {
  it('detects an embedded NUL byte and passes plain text', () => {
    expect(hasNulByte(Buffer.from(`export const a = 1${String.fromCharCode(0)}`))).toBe(true)
    expect(hasNulByte(Buffer.from('export const a = 1\n'))).toBe(false)
  })
})

describe('checkTrackedPaths', () => {
  it('fails on a tracked agent instructions or notes file at any depth', () => {
    const failures = checkTrackedPaths([
      'dev/AGENTS.md',
      'a/b/CLAUDE.md',
      `${NOTE_TOKEN.toUpperCase()}.md`,
      'src/index.ts',
    ])
    expect(failures).toHaveLength(3)
  })

  it('fails when src/legacy or src/web/legacy is tracked', () => {
    expect(checkTrackedPaths(['src/legacy/index.ts'])).toHaveLength(1)
    expect(checkTrackedPaths(['src/web/legacy/index.ts'])).toHaveLength(1)
    expect(checkTrackedPaths(['src/index.ts'])).toHaveLength(0)
  })
})

describe('checkFileContent', () => {
  it('fails on U+2013 and U+2014 but not a plain hyphen', () => {
    expect(checkFileContent('README.md', `a ${String.fromCharCode(0x2013)} b`)).toHaveLength(1)
    expect(checkFileContent('README.md', `a ${String.fromCharCode(0x2014)} b`)).toHaveLength(1)
    expect(checkFileContent('README.md', 'a - b')).toHaveLength(0)
  })

  it('fails on local paths and process vocabulary', () => {
    expect(checkFileContent('README.md', `path ${HOME}someone/repo`)).toHaveLength(1)
    expect(checkFileContent('README.md', `path ${USERS}someone/repo`)).toHaveLength(1)
    expect(checkFileContent('README.md', `built with ${TOOL_TOKEN}`)).toHaveLength(1)
    expect(checkFileContent('README.md', `${NOTE_TOKEN} notes`)).toHaveLength(1)
    expect(checkFileContent('README.md', `needs ${OWNER_APPROVAL}`)).toHaveLength(1)
    expect(checkFileContent('README.md', `the ${PRE_RELEASE_REVIEW}`)).toHaveLength(1)
  })

  it('matches underscore-joined process tokens and does not flag API paths', () => {
    for (const token of [`${NOTE_TOKEN.toUpperCase()}_NOTES`, `${TOOL_TOKEN}_cli`]) {
      expect(checkFileContent('README.md', `value ${token} here`), token).toHaveLength(1)
    }
    expect(checkFileContent('README.md', 'GET /api/users/me')).toHaveLength(0)
  })

  it('scans this script and its test like any other tracked file', () => {
    expect(
      checkFileContent('scripts/check-repository.mjs', `${TOOL_TOKEN} ${NOTE_TOKEN}`),
    ).toHaveLength(2)
    expect(
      checkFileContent('scripts/__tests__/check-repository.test.ts', `${NOTE_TOKEN} notes`),
    ).toHaveLength(1)
  })

  it('exempts .gitignore from process vocabulary only, never from local patterns', () => {
    const local = parseLeakPatterns('acme.?widgets\n')
    expect(
      checkFileContent('.gitignore', `${NOTE_TOKEN.toUpperCase()}.md\n.${TOOL_TOKEN}/`),
    ).toHaveLength(0)
    expect(checkFileContent('.gitignore', 'acme-widgets/\n', local)).toHaveLength(1)
  })

  it('applies local patterns case-insensitively as substrings, lookbehinds included', () => {
    const local = parseLeakPatterns('# fictional\n(?<!tot)acme\nglobex corp\n')
    expect(local.map(({ label }) => label)).toEqual(['local pattern 2', 'local pattern 3'])
    expect(checkFileContent('README.md', 'www.ACMEwidgets.example', local)).toHaveLength(1)
    expect(checkFileContent('README.md', 'Globex Corp integration', local)).toHaveLength(1)
    expect(checkFileContent('README.md', 'totacme is fine', local)).toHaveLength(0)
    expect(checkFileContent('README.md', 'Built for acme', [])).toHaveLength(0)
  })

  it('rejects an invalid local pattern with its line number', () => {
    expect(() => parseLeakPatterns('ok\n\n[broken\n')).toThrow(
      `invalid regular expression in ${LEAK_PATTERNS_FILE}:3`,
    )
  })

  it('loads no local patterns when the file is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'leak-patterns-'))
    scratchRoots.push(root)
    expect(loadLeakPatterns(root)).toEqual([])
    writeFileSync(join(root, LEAK_PATTERNS_FILE), 'acme\n')
    expect(loadLeakPatterns(root)).toHaveLength(1)
  })

  it('fails on an unallowlisted match in pnpm-lock.yaml', () => {
    expect(checkFileContent('pnpm-lock.yaml', `${TOOL_TOKEN}-cli@1.0.0`)).toHaveLength(1)
    expect(
      checkFileContent('pnpm-lock.yaml', 'acme-widgets@1.0.0', parseLeakPatterns('acme\n')),
    ).toHaveLength(1)
  })

  it('fails on console usage in src/ outside __tests__', () => {
    expect(checkFileContent('src/server/foo.ts', 'console.log("x")')).toHaveLength(1)
    expect(checkFileContent('src/server/__tests__/foo.test.ts', 'console.log("x")')).toHaveLength(0)
  })

  it('fails on disallowed imports in restricted core/web files', () => {
    expect(checkFileContent('src/web/browser.ts', "import { z } from 'payload'")).toHaveLength(1)
    expect(checkFileContent('src/core/sanitize.ts', "import fs from 'node:fs'")).toHaveLength(1)
    expect(
      checkFileContent('src/core/touches.ts', "import { x } from '@payloadcms/ui'"),
    ).toHaveLength(1)
    expect(checkFileContent('src/core/names.ts', "import React from 'react'")).toHaveLength(1)
    expect(
      checkFileContent('src/core/money.ts', "import type { Config } from 'payload'"),
    ).toHaveLength(1)
    expect(checkFileContent('src/core/time.ts', "import { a } from './sanitize.js'")).toHaveLength(
      0,
    )
  })

  it('allows unrestricted files to import payload, and /next to import next/server', () => {
    expect(checkFileContent('src/index.ts', "import type { Config } from 'payload'")).toHaveLength(
      0,
    )
    expect(
      checkFileContent('src/web/next.ts', "import { NextResponse } from 'next/server.js'"),
    ).toHaveLength(0)
  })
})

describe('importSpecifiersOf', () => {
  it('extracts static import and export specifiers', () => {
    expect(importSpecifiersOf("import { a } from 'x'\nexport { b } from 'y'")).toEqual(['x', 'y'])
  })

  it('extracts bare side-effect imports', () => {
    expect(importSpecifiersOf("import 'polyfill'")).toEqual(['polyfill'])
  })
})

describe('isDocumentationFile and isSampleFile', () => {
  it('covers README.md and markdown under docs/, and files under dev/docs-samples', () => {
    expect(isDocumentationFile('README.md')).toBe(true)
    expect(isDocumentationFile('docs/decisions/0001-one-package.md')).toBe(true)
    expect(isDocumentationFile('CONTRIBUTING.md')).toBe(false)
    expect(isDocumentationFile('docs/plan.json')).toBe(false)
    expect(isSampleFile('dev/docs-samples/proxy.ts')).toBe(true)
    expect(isSampleFile('dev/proxy.ts')).toBe(false)
  })
})

describe('normalizeSample', () => {
  it('ignores line endings, trailing spaces, surrounding blank lines and common indentation', () => {
    expect(normalizeSample('\n    const a = 1  \r\n      return a\n\n')).toBe(
      'const a = 1\n  return a',
    )
  })

  it('keeps inner blank lines and relative indentation', () => {
    expect(normalizeSample('a\n\n  b\n')).toBe('a\n\n  b')
  })
})

describe('documentationSamples', () => {
  it('reads the sample marker before a ts fence, across a blank line', () => {
    const { failures, samples } = documentationSamples(
      'docs/a.md',
      `# Title\n\n${sampled('a.ts', 'export {}\n')}`,
    )
    expect(failures).toEqual([])
    expect(samples).toEqual([{ code: 'export {}\n', line: 5, name: 'a.ts' }])
  })

  it('fails on a compiled-language fence without a marker, in any indentation', () => {
    for (const language of ['ts', 'tsx', 'typescript', 'js', 'javascript']) {
      const { failures } = documentationSamples('README.md', `${FENCE}${language}\nx\n${FENCE}\n`)
      expect(failures, language).toEqual(['code block without a sample marker in README.md:1'])
    }
    expect(
      documentationSamples('README.md', `- item\n\n    ${FENCE}ts\n    x\n    ${FENCE}\n`).failures,
    ).toHaveLength(1)
  })

  it('ignores shell, json and plain fences', () => {
    const content = `${FENCE}bash\npnpm add x\n${FENCE}\n\n${FENCE}json\n{}\n${FENCE}\n\n${FENCE}\nplain\n${FENCE}\n`
    expect(documentationSamples('README.md', content)).toEqual({ failures: [], samples: [] })
  })

  it('rejects a marker that is not directly before the fence or escapes the samples directory', () => {
    expect(
      documentationSamples(
        'README.md',
        `<!-- sample: a.ts -->\n\nText.\n\n${FENCE}ts\nx\n${FENCE}\n`,
      ).failures,
    ).toHaveLength(1)
    expect(documentationSamples('README.md', sampled('../proxy.ts', 'x\n')).failures).toHaveLength(
      1,
    )
  })

  it('does not end a four-backtick fence at an inner three-backtick line', () => {
    const content = `${FENCE}\`markdown\n${FENCE}ts\nx\n${FENCE}\n${FENCE}\`\n`
    expect(documentationSamples('README.md', content).failures).toEqual([])
  })
})

describe('checkDocumentationSamples', () => {
  const samples = new Map([['proxy.ts', "export const proxy = 'current'\n"]])

  it('passes when every fence matches its sample and every sample is used', () => {
    expect(
      checkDocumentationSamples(
        [{ content: sampled('proxy.ts', "  export const proxy = 'current'\n"), file: 'README.md' }],
        samples,
      ),
    ).toEqual([])
  })

  it('fails on drift, on a missing sample and on an unused sample', () => {
    expect(
      checkDocumentationSamples(
        [{ content: sampled('proxy.ts', "export const proxy = 'stale'\n"), file: 'README.md' }],
        samples,
      ),
    ).toEqual(['docs sample drift: README.md:3 differs from dev/docs-samples/proxy.ts'])
    expect(
      checkDocumentationSamples(
        [{ content: sampled('gone.ts', 'x\n'), file: 'docs/a.md' }],
        new Map(),
      ),
    ).toEqual(['missing docs sample dev/docs-samples/gone.ts used by docs/a.md:3'])
    expect(checkDocumentationSamples([], samples)).toEqual([
      'unused docs sample: dev/docs-samples/proxy.ts',
    ])
  })

  it('fails on a sample file the typecheck does not compile', () => {
    expect(
      checkDocumentationSamples(
        [{ content: sampled('notes.md', 'x\n'), file: 'README.md' }],
        new Map([['notes.md', 'x\n']]),
      ),
    ).toEqual(['docs sample is not compiled TypeScript: dev/docs-samples/notes.md'])
  })
})

describe('isBannedImportSpecifier', () => {
  it('bans payload, @payloadcms/*, react and node:*', () => {
    expect(isBannedImportSpecifier('payload')).toBe(true)
    expect(isBannedImportSpecifier('payload/types')).toBe(true)
    expect(isBannedImportSpecifier('@payloadcms/ui')).toBe(true)
    expect(isBannedImportSpecifier('react')).toBe(true)
    expect(isBannedImportSpecifier('node:fs')).toBe(true)
  })

  it('does not ban react-dom, relative specifiers or next/server', () => {
    expect(isBannedImportSpecifier('react-dom')).toBe(false)
    expect(isBannedImportSpecifier('./local.js')).toBe(false)
    expect(isBannedImportSpecifier('next/server')).toBe(false)
  })
})
