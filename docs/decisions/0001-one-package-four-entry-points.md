# ADR 0001: One package with four entry points

- Status: Accepted
- Date: 2026-09-15
- Owners: Maintainers

## Context

Attribution spans three runtimes. The Payload server records and delivers conversions, the Next.js edge runtime captures touches on every storefront request, and the browser adds GA identity and consent at submit time. The admin components run in Payload's React client bundle. Each runtime tolerates a different set of dependencies: an edge proxy cannot import `payload` or `node:` modules, and a browser bundle should not pull in Next.js.

The cookie format, attribution sanitizer and consent vocabulary must be identical across all of them. A mismatch silently loses click ids.

## Decision

1. Publish one npm package, `payload-plugin-attribution`, ESM only.
2. Expose four entry points: `.` for the server plugin and API, `./client` for admin components, `./next` for request capture, and `./browser` for browser helpers.
3. Keep shared cookie, sanitizer and touch logic in dependency-free core modules that every entry point imports.
4. Enforce the boundaries mechanically: the repository check bans `payload`, `@payloadcms/*`, `react` and `node:` imports in web and core modules, an export surface test bundles each entry and inspects its imports, and the tarball smoke test imports `./next` and `./browser` with only their allowed peers installed.

## Rationale

- One version number guarantees that the cookie written by `./next` is the cookie `recordConversion` reads.
- Hosts install and upgrade one package with one changelog.
- Payload, Next.js and React are optional peers, so an entry point costs nothing in runtimes that do not use it.
- Mechanical checks catch a stray import before release, when a separate package would catch it only in a consumer's build.

## Consequences

- A change to a shared core module is a change to every runtime and is tested in all of them.
- `./next` imports `next/server`, so it needs `next` installed even for `captureFromRequest` outside Next.js.
- Types shared by the browser and server, such as `Attribution` and `ConsentState`, are exported from both entries.
- Bundler-only `./client` code is resolved, not executed, by the tarball smoke test.

## Alternatives rejected

- **Separate packages per runtime:** version skew between the capture and recording packages would corrupt attribution without an error.
- **A single entry with conditional exports:** makes the dependency boundary depend on each bundler's condition handling.
- **Browser helpers that depend on Next.js:** would exclude non-Next storefronts and enlarge client bundles.
