# Contributing

This guide covers the local setup, the verification gate and the conventions the codebase follows.

## Setup

Use Node 24 and pnpm 11.

```bash
pnpm install
PLAYWRIGHT_SKIP_BROWSER_GC=1 pnpm exec playwright install chromium
```

The repository ships a development harness under `dev/`: a Payload and Next.js app with generic `orders` and `leads` collections, a lead form, the attribution proxy and a local SQLite database. Copy `dev/.env.example` to `dev/.env`, then:

```bash
ATTRIBUTION_SEED=true pnpm dev
```

Destinations stay unconfigured unless you point the harness at the local mock providers, which record every request instead of forwarding it:

```bash
pnpm dev:mock-providers
ATTRIBUTION_MOCK_PROVIDERS_URL=http://127.0.0.1:3199 ATTRIBUTION_RUN_JOBS=true pnpm dev
```

Never point the harness at live credentials, and never send its synthetic click ids to Google.

## The verification gate

Before opening a pull request, run:

```bash
pnpm release:check # repository rules, format, lint, types, coverage, build, tarball smoke, package checks, audit
pnpm test:e2e      # Chromium, Firefox and WebKit against a production build and mock providers
```

`pnpm test:e2e` uses port 3198 for the app and 3199 for the mock providers; set `PLAYWRIGHT_PORT` and `PLAYWRIGHT_MOCK_PORT` to move them. `PLAYWRIGHT_NEXT_MODE=dev` runs `next dev` instead, which replaces the proxy's `Cache-Control` header.

The integration suites run on SQLite by default. Set `ATTRIBUTION_TEST_POSTGRES_URL` to a dedicated Postgres database, or `ATTRIBUTION_TEST_MONGODB_URL` to a dedicated MongoDB replica set, to run them there. `scripts/ci/start-database.sh` starts a disposable container:

```bash
bash ./scripts/ci/start-database.sh postgres postgres:17-alpine
ATTRIBUTION_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/attribution_test pnpm exec vitest run src/__tests__/*.int.test.ts
```

CI runs the integration suites on Postgres 17 and MongoDB 8, `release:check` on Node 22.12.0 and Node 24, and the browser suite on Node 24.

`pnpm test:live` sends validation-only requests to real providers: the GA4 validation server, a Data Manager `validateOnly` request and Meta test events. Each group runs only when all its `ATTRIBUTION_LIVE_*` variables in `dev/.env.example` are set. See [RELEASING.md](RELEASING.md).

## Conventions

- **ESM only.** Relative imports use the `.js` extension in `.ts` source.
- **Strict TypeScript**, and no `enum`: use `as const` arrays with derived union types.
- **Constants live in `src/constants.ts`**, and public and internal types in `src/types/index.ts`.
- **No `console`** in `src/`. Log through the plugin logger, which redacts secrets.
- **Edge and browser entry points stay dependency-free.** `src/web/` and the shared core modules never import `payload`, `@payloadcms/*`, `react` or `node:*`.
- **No transaction around network I/O.** Destination calls happen between the claim and the settlement transactions.
- **Documentation code is compiled.** Every TypeScript block in `README.md` and `docs/` follows a `<!-- sample: name.ts -->` marker and matches that file in `dev/docs-samples/`, which the typecheck compiles. `pnpm check:repository` fails on drift, unmarked blocks and unused samples.
- **No U+2013 or U+2014 dashes** in any tracked file.
- **No private names.** `pnpm check:repository` also applies an optional, gitignored `.leak-patterns` file at the repository root (one case-insensitive regular expression per line, `#` for comments), so maintainers can scan for names that must never be published without listing them in the repository.
- **Tests for the logic you touch.** Destination handlers are tested against mocked `fetch`; recording and delivery are tested against a real Payload instance.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). Keep each commit to one coherent change, and add consumer-facing changes to `CHANGELOG.md` under `[Unreleased]`.

## Provider contracts

Destination handlers follow the published GA4 Measurement Protocol, Google Data Manager API, Google Ads offline conversion import and Meta Conversions API contracts. Confirm the current contract in the provider's documentation before changing a handler, and note version-specific details in the change.
