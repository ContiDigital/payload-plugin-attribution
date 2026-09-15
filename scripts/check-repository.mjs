import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const BANNED_BASENAMES = new Set(['AGENTS.md', 'CLAUDE.md', ['HAND', 'OFF.md'].join('')])

export const LEGACY_DIRECTORIES = ['src/legacy', 'src/web/legacy']

// Built from code points, never as literal characters, so this file itself stays clean.
export const DASH_PATTERN = new RegExp(
  `[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`,
)

// Generic leaks, matched as substrings so underscore-joined identifiers still match. Character
// classes keep each pattern's own source from matching it, so this file is scanned like any other.
export const LEAK_PATTERNS = [
  { label: 'local path', pattern: /\/home\//i },
  { label: 'local path', pattern: /\/User[s]\/[^/\s]/ },
  { label: 'process note', pattern: /co[d]ex/i },
  { label: 'process note', pattern: /hand[o]ff/i },
  { label: 'process note', pattern: /owner[ ]approval/i },
  { label: 'process note', pattern: /pre-release[ ]review/i },
]

// .gitignore must carry the literal ignore lines for agent tooling directories and files.
export const LEAK_SCAN_EXEMPT_FILES = new Set(['.gitignore'])

// Names that must never be published cannot be listed in a published file. Maintainers keep them
// in this untracked file at the repository root: one case-insensitive regular expression per
// line, blank lines and `#` comments ignored. Without the file only the generic rules run.
export const LEAK_PATTERNS_FILE = '.leak-patterns'

export const parseLeakPatterns = (text) => {
  const patterns = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const source = raw.trim()
    if (!source || source.startsWith('#')) {
      return
    }
    const line = index + 1
    try {
      patterns.push({ label: `local pattern ${line}`, pattern: new RegExp(source, 'i') })
    } catch {
      throw new Error(`invalid regular expression in ${LEAK_PATTERNS_FILE}:${line}`)
    }
  })
  return patterns
}

export const loadLeakPatterns = (root) => {
  const path = resolve(root, LEAK_PATTERNS_FILE)
  return existsSync(path) ? parseLeakPatterns(readFileSync(path, 'utf8')) : []
}

// Genuine third-party identifiers that legitimately appear in the lockfile go here, each with
// a reason. Nothing is allowlisted today; pnpm-lock.yaml currently has no matches at all.
export const LOCKFILE_ALLOWLIST = []

export const isLockfileMatchAllowed = (matchedText) =>
  LOCKFILE_ALLOWLIST.some((entry) => entry.value.toLowerCase() === matchedText.toLowerCase())

export const CONSOLE_PATTERN = /console\s*\./
export const isSourceFile = (file) => file.startsWith('src/') && /\.(?:ts|tsx)$/.test(file)
export const isTestFile = (file) => file.includes('__tests__/') || /\.test\.tsx?$/.test(file)

export const RESTRICTED_IMPORT_FILES = new Set([
  'src/core/sanitize.ts',
  'src/core/touches.ts',
  'src/core/names.ts',
  'src/core/time.ts',
  'src/core/money.ts',
])
export const isRestrictedImportSurface = (file) =>
  file.startsWith('src/web/') || RESTRICTED_IMPORT_FILES.has(file)

export const IMPORT_SPECIFIER_PATTERN =
  /(?:^|\s)(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/g
export const isBannedImportSpecifier = (specifier) =>
  specifier === 'payload' ||
  specifier.startsWith('payload/') ||
  specifier.startsWith('@payloadcms/') ||
  specifier === 'react' ||
  specifier.startsWith('react/') ||
  specifier.startsWith('node:')

export const importSpecifiersOf = (content) => {
  const specifiers = []
  for (const match of content.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2]
    if (specifier) {
      specifiers.push(specifier)
    }
  }
  return specifiers
}

// A NUL byte makes Git treat a text file as binary (diffs and reviews go blind).
export const hasNulByte = (buffer) => buffer.includes(0)

// Documentation code samples. Every TypeScript or JavaScript fence in README.md and docs/ is
// introduced by a `<!-- sample: name.ts -->` comment naming a file under dev/docs-samples, which
// the repository typecheck compiles. The fence must equal that file after normalizing
// indentation, and every sample file must be shown by at least one page.
export const SAMPLES_DIRECTORY = 'dev/docs-samples'
export const SAMPLE_LANGUAGES = new Set([
  'javascript',
  'js',
  'jsx',
  'mjs',
  'ts',
  'tsx',
  'typescript',
])
export const FENCE_PATTERN = /^[ \t]*(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm
export const SAMPLE_MARKER_PATTERN = /^<!--\s*sample:\s*([\w.-]+(?:\/[\w.-]+)*)\s*-->$/

export const isDocumentationFile = (file) =>
  file === 'README.md' || (file.startsWith('docs/') && file.endsWith('.md'))
export const isSampleFile = (file) => file.startsWith(`${SAMPLES_DIRECTORY}/`)

// Line endings, trailing whitespace, surrounding blank lines and the common indentation are
// presentation; everything else must match byte for byte.
export const normalizeSample = (text) => {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
  while (lines.length > 0 && lines[0] === '') {
    lines.shift()
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  const indents = lines.filter(Boolean).map((line) => /^[ \t]*/.exec(line)[0].length)
  const indent = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(indent)).join('\n')
}

// Returns the sample-backed fences of one documentation page, and a failure for each compiled
// language fence that is not introduced by a sample marker.
export const documentationSamples = (file, content) => {
  const failures = []
  const samples = []
  for (const match of content.matchAll(FENCE_PATTERN)) {
    const language = (match[2].trim().split(/\s+/)[0] ?? '').toLowerCase()
    if (!SAMPLE_LANGUAGES.has(language)) {
      continue
    }
    const before = content.slice(0, match.index)
    const line = before.split('\n').length
    const preceding = before.replace(/\s+$/, '')
    const marker = SAMPLE_MARKER_PATTERN.exec(
      preceding.slice(preceding.lastIndexOf('\n') + 1).trim(),
    )
    if (!marker || marker[1].split('/').includes('..')) {
      failures.push(`code block without a sample marker in ${file}:${line}`)
      continue
    }
    samples.push({ code: match[3], line, name: marker[1] })
  }
  return { failures, samples }
}

// `docs` is a list of { file, content } pages; `samples` maps a path relative to
// SAMPLES_DIRECTORY to that file's content.
export const checkDocumentationSamples = (docs, samples) => {
  const failures = []
  const used = new Set()
  for (const name of samples.keys()) {
    if (!/\.tsx?$/.test(name)) {
      failures.push(`docs sample is not compiled TypeScript: ${SAMPLES_DIRECTORY}/${name}`)
    }
  }
  for (const { content, file } of docs) {
    const found = documentationSamples(file, content)
    failures.push(...found.failures)
    for (const { code, line, name } of found.samples) {
      used.add(name)
      const sample = samples.get(name)
      if (sample === undefined) {
        failures.push(`missing docs sample ${SAMPLES_DIRECTORY}/${name} used by ${file}:${line}`)
      } else if (normalizeSample(code) !== normalizeSample(sample)) {
        failures.push(
          `docs sample drift: ${file}:${line} differs from ${SAMPLES_DIRECTORY}/${name}`,
        )
      }
    }
  }
  for (const name of samples.keys()) {
    if (!used.has(name)) {
      failures.push(`unused docs sample: ${SAMPLES_DIRECTORY}/${name}`)
    }
  }
  return failures
}

export const checkTrackedPaths = (files) => {
  const failures = []
  for (const file of files) {
    if (BANNED_BASENAMES.has(basename(file))) {
      failures.push(`tracked AI process file: ${file}`)
    }
    if (file === LEAK_PATTERNS_FILE) {
      failures.push(`local leak patterns file is tracked: ${file}`)
    }
  }
  for (const legacy of LEGACY_DIRECTORIES) {
    if (files.some((file) => file === legacy || file.startsWith(`${legacy}/`))) {
      failures.push(`legacy directory is still tracked: ${legacy}`)
    }
  }
  return failures
}

// Legacy directories must not exist at all: an untracked or ignored leftover would still be
// compiled into dist by swc and packed. Only these two fixed paths are checked.
export const checkLegacyDirectoriesOnDisk = (root) =>
  LEGACY_DIRECTORIES.filter((legacy) => existsSync(resolve(root, legacy))).map(
    (legacy) => `legacy directory exists on disk: ${legacy}`,
  )

// One tracked file's rules, given its already-decoded text content. NUL-byte detection needs
// the raw buffer and is checked separately by the caller before this ever sees the content.
// `localPatterns` come from LEAK_PATTERNS_FILE and apply to every tracked file without exemption.
export const checkFileContent = (file, content, localPatterns = []) => {
  const failures = []

  if (DASH_PATTERN.test(content)) {
    failures.push(`prohibited dash punctuation (U+2013/U+2014): ${file}`)
  }

  const leakPatterns = LEAK_SCAN_EXEMPT_FILES.has(file)
    ? localPatterns
    : [...LEAK_PATTERNS, ...localPatterns]
  if (file === 'pnpm-lock.yaml') {
    for (const { label, pattern } of leakPatterns) {
      const matches = content.match(new RegExp(pattern.source, `${pattern.flags}g`))
      for (const matchedText of matches ?? []) {
        if (!isLockfileMatchAllowed(matchedText)) {
          failures.push(
            `leaked identifier "${label}" in pnpm-lock.yaml (matched "${matchedText}"); add it to LOCKFILE_ALLOWLIST only if it is a genuine third-party identifier`,
          )
        }
      }
    }
  } else {
    for (const { label, pattern } of leakPatterns) {
      if (pattern.test(content)) {
        failures.push(`leaked identifier "${label}" in ${file}`)
      }
    }
  }

  if (isSourceFile(file) && !isTestFile(file) && CONSOLE_PATTERN.test(content)) {
    failures.push(`console usage outside tests: ${file}`)
  }

  if (isRestrictedImportSurface(file)) {
    for (const specifier of importSpecifiersOf(content)) {
      if (isBannedImportSpecifier(specifier)) {
        failures.push(`disallowed import "${specifier}" in ${file}`)
      }
    }
  }

  return failures
}

// Runs every rule against the git repository at `root`. Returns { failures, scanned }.
export const runRepositoryChecks = async (root) => {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

  const failures = [...checkTrackedPaths(files), ...checkLegacyDirectoriesOnDisk(root)]
  let localPatterns = []
  try {
    localPatterns = loadLeakPatterns(root)
  } catch (error) {
    failures.push(error.message)
  }
  let scanned = 0
  const docs = []
  const samples = new Map()

  for (const file of files) {
    const buffer = await readFile(resolve(root, file))
    if (hasNulByte(buffer)) {
      failures.push(`NUL byte in tracked file: ${file}`)
      continue
    }
    scanned++
    const content = buffer.toString('utf8')
    failures.push(...checkFileContent(file, content, localPatterns))
    if (isDocumentationFile(file)) {
      docs.push({ content, file })
    }
    if (isSampleFile(file)) {
      samples.set(file.slice(SAMPLES_DIRECTORY.length + 1), content)
    }
  }

  failures.push(...checkDocumentationSamples(docs, samples))
  return { failures, scanned }
}

// import.meta.url is percent-encoded and symlink-resolved, so compare it with the real path of
// argv[1] as a file URL. A naive string comparison silently skips the checks when the checkout
// path contains a space or is reached through a symlink.
export const isInvokedDirectly = (moduleUrl, argvPath) => {
  if (!argvPath) {
    return false
  }
  try {
    return moduleUrl === pathToFileURL(realpathSync(argvPath)).href
  } catch {
    return false
  }
}

if (isInvokedDirectly(import.meta.url, process.argv[1])) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const { failures, scanned } = await runRepositoryChecks(root)

  if (failures.length > 0) {
    console.error(`Repository checks failed (${failures.length}):`)
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    process.exit(1)
  }

  console.info(`Repository checks passed for ${scanned} tracked file(s).`)
}
