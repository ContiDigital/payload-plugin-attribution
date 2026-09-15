// Verifies that the declaration graphs of the edge/browser entry points in a built or packed
// package reference nothing from payload, @payloadcms/*, react or Node. `next` (only
// `next/server`) is allowed in the /next graph alone.
//
//   node scripts/check-dts-boundary.mjs <packageRoot>

import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ENTRY_POINTS = [
  { allowNextServer: true, file: 'dist/exports/next.d.ts' },
  { allowNextServer: false, file: 'dist/exports/browser.d.ts' },
]

// Every way a declaration file can pull in another module or type package.
const REFERENCE_PATTERNS = [
  // import/export ... from 'x'
  { kind: 'module', pattern: /\bfrom\s*['"]([^'"]+)['"]/g },
  // import 'x' (side effect)
  { kind: 'module', pattern: /\bimport\s*['"]([^'"]+)['"]/g },
  // inline import types: import('x').Foo
  { kind: 'module', pattern: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
  // import x = require('x')
  { kind: 'module', pattern: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
  // /// <reference types="x" />
  { kind: 'types', pattern: /\/\/\/\s*<reference\s+types\s*=\s*['"]([^'"]+)['"]/g },
  // /// <reference path="./x.d.ts" />
  { kind: 'path', pattern: /\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"]+)['"]/g },
]

const DISALLOWED_MODULES = [
  /^payload(?:\/|$)/,
  /^@payloadcms\//,
  /^react(?:\/|$)/,
  /^react-dom(?:\/|$)/,
  /^node:/,
]
// Type packages named by /// <reference types>, e.g. "node" or "react".
const DISALLOWED_TYPES = [
  /^node(?:\/|$)/,
  /^react(?:\/|$)/,
  /^react-dom(?:\/|$)/,
  /^payload(?:\/|$)/,
  /^@payloadcms\//,
]

export const referencesOf = (content) => {
  const references = []
  for (const { kind, pattern } of REFERENCE_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      references.push({ kind, specifier: match[1] })
    }
  }
  return references
}

// Resolves a relative declaration reference; returns null when no file exists (fails closed).
const resolveRelative = (fromFile, specifier) => {
  const base = resolve(dirname(fromFile), specifier)
  const stripped = base.replace(/\.(?:d\.ts|ts|js|mjs)$/, '')
  const candidates = [
    base.endsWith('.d.ts') ? base : null,
    `${stripped}.d.ts`,
    join(base, 'index.d.ts'),
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

const violationFor = ({ kind, specifier }, allowNextServer) => {
  if (kind === 'types') {
    if (DISALLOWED_TYPES.some((pattern) => pattern.test(specifier))) {
      return `references types "${specifier}"`
    }
    return null
  }
  if (DISALLOWED_MODULES.some((pattern) => pattern.test(specifier))) {
    return `imports disallowed specifier "${specifier}"`
  }
  if (/^next(?:\/|$)/.test(specifier)) {
    if (allowNextServer && /^next\/server(?:\.js)?$/.test(specifier)) {
      return null
    }
    return `imports "${specifier}", which only the /next entry may use (and only next/server)`
  }
  return null
}

// Walks the declaration graph from one entry file. Returns { failures, files }.
export const checkDeclarationGraph = async (entryFile, { allowNextServer }) => {
  const failures = []
  const visited = new Set()
  const queue = [entryFile]
  while (queue.length > 0) {
    const file = queue.shift()
    if (visited.has(file)) {
      continue
    }
    visited.add(file)
    const content = await readFile(file, 'utf8')
    for (const reference of referencesOf(content)) {
      if (reference.kind === 'path' || reference.specifier.startsWith('.')) {
        const target = resolveRelative(file, reference.specifier)
        if (target) {
          queue.push(target)
        } else {
          failures.push(`${file} references "${reference.specifier}", which does not resolve`)
        }
        continue
      }
      const violation = violationFor(reference, allowNextServer)
      if (violation) {
        failures.push(`${file} ${violation}`)
      }
    }
  }
  return { failures, files: visited }
}

export const checkPackageBoundary = async (packageRoot) => {
  const failures = []
  const counts = []
  for (const { allowNextServer, file } of ENTRY_POINTS) {
    const entry = join(packageRoot, file)
    if (!existsSync(entry)) {
      failures.push(`missing declaration entry: ${entry}`)
      continue
    }
    const result = await checkDeclarationGraph(entry, { allowNextServer })
    failures.push(...result.failures)
    counts.push(`${result.files.size} from ${file}`)
  }
  return { counts, failures }
}

const invokedDirectly = () => {
  const invoked = process.argv[1]
  if (!invoked) {
    return false
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const packageRoot = process.argv[2]
  if (!packageRoot) {
    console.error('usage: node scripts/check-dts-boundary.mjs <packageRoot>')
    process.exit(2)
  }
  const { counts, failures } = await checkPackageBoundary(resolve(packageRoot))
  if (failures.length > 0) {
    console.error(`Declaration boundary check failed (${failures.length}):`)
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    process.exit(1)
  }
  console.info(`Declaration boundary check passed: ${counts.join(', ')} type file(s).`)
}
