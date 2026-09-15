#!/usr/bin/env bash
#
# Smoke-test the npm tarball: pack, install it into scratch npm projects, and
# exercise it as a real consumer would.
#
#   - dir A (x2): tarball plus the `payload` peer, once at the pinned
#     devDependency version and once at the peer floor (3.84.1). Imports the
#     package root as ESM, applies the curried plugin factory to a minimal
#     config, and resolves (does not execute) the bundler-only `/client`
#     entry point.
#   - dir B-next (x2): tarball plus `next` only (no other peers), once at the
#     pinned devDependency version and once at the peer floor. Imports `/next`
#     under plain node and under `--conditions=edge-light` and calls
#     `readAttributionCookie('')`.
#   - dir B-browser: tarball with nothing else installed. Imports `/browser`
#     the same way.
#
# It also statically checks dist/exports/next.d.ts and browser.d.ts (and
# everything they import transitively) for imports of `payload`,
# `@payloadcms/*`, `react` or `node:*` -- those entries must stay usable from
# an edge runtime and a plain browser bundle. `next/server` is allowed only
# in the `/next` graph.
#
# Run via `pnpm pack:smoke` after `pnpm build`. Wired into `release:check`.
#
# PACK_SMOKE_SKIP_BUILD=true packs the existing dist without the prepack build, for the CI
# Node floor job: pnpm cannot run on Node 22.12.0, so dist is built on Node 24 first.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

payload_dev_version="$(node -p "require('./package.json').devDependencies.payload")"
payload_floor_version="3.84.1"
next_dev_version="$(node -p "require('./package.json').devDependencies.next")"
next_floor_version="15.2.9"
react_dev_version="$(node -p "require('./package.json').devDependencies.react")"

scratch="$(mktemp -d)"
pack_log="$(mktemp)"
pack_file=""
cleanup() {
  rm -rf "$scratch"
  rm -f "$pack_log"
  if [ -n "$pack_file" ]; then
    rm -f "$pack_file"
  fi
}
trap cleanup EXIT

pack_args=(--pack-destination "$scratch")
if [ "${PACK_SMOKE_SKIP_BUILD:-}" = "true" ]; then
  if [ ! -f dist/index.js ]; then
    echo "PACK_SMOKE_SKIP_BUILD=true requires an existing build in dist" >&2
    exit 1
  fi
  pack_args+=(--ignore-scripts)
fi
npm pack "${pack_args[@]}" >"$pack_log" 2>&1 || {
  cat "$pack_log"
  exit 1
}
pack_file="$(realpath "$(ls -1 "$scratch"/*.tgz)")"

extract_dir="$scratch/extract"
mkdir -p "$extract_dir"
tar -xzf "$pack_file" -C "$extract_dir"
node "$repo_root/scripts/check-dts-boundary.mjs" "$extract_dir/package"

root_and_client_check() {
  local label="$1" payload_version="$2"
  local dir="$scratch/$label"
  mkdir -p "$dir"
  (cd "$dir" && npm init -y >/dev/null 2>&1)
  (cd "$dir" && npm install --no-audit --no-fund --legacy-peer-deps "$pack_file" "payload@${payload_version}" >/dev/null)
  (
    cd "$dir"
    node --input-type=module -e "
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { attributionPlugin } from 'payload-plugin-attribution'

if (typeof attributionPlugin !== 'function') {
  throw new Error('attributionPlugin is not exported as a function')
}
const configure = attributionPlugin({ secret: 'x', disabled: true })
if (typeof configure !== 'function') {
  throw new Error('attributionPlugin(options) did not return a config function')
}
const config = configure({ collections: [] })
if (typeof config !== 'object' || config === null) {
  throw new Error('applying the plugin to a minimal config did not return a config object')
}
await access(fileURLToPath(import.meta.resolve('payload-plugin-attribution/client')))
"
  )
  echo "Root + /client check passed against payload@${payload_version}."
}

edge_entry_check() {
  local label="$1" specifier="$2"
  shift 2
  local dir="$scratch/$label"
  mkdir -p "$dir"
  (cd "$dir" && npm init -y >/dev/null 2>&1)
  # No --legacy-peer-deps here: next cannot load without its own required peers (react,
  # react-dom), so npm must install those. Every peer of this package is optional, so npm
  # installs none of them; the assertion below proves payload stayed out.
  (cd "$dir" && npm install --no-audit --no-fund "$pack_file" "$@" >/dev/null)
  if [ -e "$dir/node_modules/payload" ] || [ -e "$dir/node_modules/@payloadcms" ]; then
    echo "${label}: payload or @payloadcms/* was installed; expected only next and its own peers" >&2
    exit 1
  fi
  local script="
import { readAttributionCookie } from '${specifier}'
if (typeof readAttributionCookie !== 'function') {
  throw new Error('readAttributionCookie is not exported as a function from ${specifier}')
}
readAttributionCookie('')
"
  (cd "$dir" && node --input-type=module -e "$script")
  (cd "$dir" && node --conditions=edge-light --input-type=module -e "$script")
  echo "${specifier} resolved under node and node --conditions=edge-light in ${dir}."
}

browser_entry_check() {
  local dir="$scratch/browser-only"
  mkdir -p "$dir"
  (cd "$dir" && npm init -y >/dev/null 2>&1)
  (cd "$dir" && npm install --no-audit --no-fund --legacy-peer-deps "$pack_file" >/dev/null)
  local script="
import { createEventId } from 'payload-plugin-attribution/browser'
if (typeof createEventId !== 'function') {
  throw new Error('createEventId is not exported as a function from payload-plugin-attribution/browser')
}
if (typeof createEventId() !== 'string') {
  throw new Error('createEventId() did not return a string')
}
"
  (cd "$dir" && node --input-type=module -e "$script")
  (cd "$dir" && node --conditions=edge-light --input-type=module -e "$script")
  echo "payload-plugin-attribution/browser resolved under node and node --conditions=edge-light with no peers installed in ${dir}."
}

root_and_client_check "root-dev" "$payload_dev_version"
root_and_client_check "root-floor" "$payload_floor_version"
edge_entry_check "next-only" "payload-plugin-attribution/next" "next@${next_dev_version}"
edge_entry_check "next-floor" "payload-plugin-attribution/next" "next@${next_floor_version}"
browser_entry_check

echo "Pack smoke passed on payload ${payload_dev_version} and ${payload_floor_version}, next ${next_dev_version} and ${next_floor_version}."
