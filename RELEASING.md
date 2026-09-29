# Releasing

This is the runbook for a public release. Never publish from a dirty working tree or from a commit without the matching annotated `vX.Y.Z` tag.

## 1. Preflight the release commit

Confirm the version in `package.json`, date the `CHANGELOG.md` section, and make sure CI is green on the exact commit to tag. From a clean checkout of that commit:

```bash
test -z "$(git status --porcelain)"
pnpm install --frozen-lockfile
pnpm release:check
pnpm test:e2e
npm pack --dry-run
```

Run the preflight with the maintainer's local `.leak-patterns` file in place; see [CONTRIBUTING.md](CONTRIBUTING.md#conventions). Do not continue if a command fails or if the package contains anything outside `dist/`, `docs/`, `LICENSE`, `README.md`, `CHANGELOG.md` and `SECURITY.md`.

## 2. Run live validation

`pnpm test:live` records one event in a temporary database and sends validation-only requests: the GA4 validation server, a Data Manager `validateOnly` request and a Meta event with a test event code. It never dispatches deliveries. Set the `ATTRIBUTION_LIVE_*` variables listed in `dev/.env.example`; groups with missing variables are skipped.

## 3. Record live canary evidence

A destination's readiness in the README stays "live canary pending" until its canary is recorded below. Use accounts you control, test properties and datasets where the provider offers them, and never customer data.

- [ ] **GA4:** send a conversion to a test property with the validation server clean, and confirm it in DebugView.
- [ ] **Google Ads Data Manager:** send a `validateOnly` request for the operating account and conversion actions, then one real conversion for a test order, and confirm it in the conversion action's diagnostics.
- [ ] **Google Ads feeds:** load `conversions.csv` and `adjustments.csv` in the Google Ads upload preview, including a blank-value `RETRACT` row, and confirm both parse without errors.
- [ ] **Google Ads adjustments on Data Manager:** confirm a file adjustment applies to a conversion ingested through Data Manager. Google's documentation does not state this; it stays pending until recorded.
- [ ] **Meta:** send an event with a `test_event_code` and confirm it in Test Events, including deduplication against a browser pixel event with the same `event_id`.

Record each canary in this table before tagging. Add one row per destination and check, with the date, the account or property type (never its id when it identifies a customer), what was confirmed, and who confirmed it.

| Date (UTC) | Destination             | Check                                                                               | Evidence                                                                                                                                        | Confirmed by                    |
| ---------- | ----------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 2026-09-29 | GA4                     | Validation endpoint, existing web property                                          | Strict validation returned no messages. Collection and report visibility on a separate validation property remain pending.                      | Maintainer release verification |
| 2026-09-29 | Google Ads Data Manager | Validation-only request, operating account with an existing offline purchase action | The real API accepted the plugin-built request with `validateOnly`; no conversion was ingested. Processing and matching remain separate checks. | Maintainer release verification |

## 4. One-time npm bootstrap

Skip this section once the package exists on npm.

npm requires an existing package before a trusted publisher can be configured. Do not consume the real release version during bootstrap. From a temporary detached worktree at the verified release commit:

1. Make the GitHub repository public.
2. Change the worktree version to `0.0.0-bootstrap.0`, update the lockfile, commit that change, and create the annotated tag `v0.0.0-bootstrap.0`. Do not merge the bootstrap commit.
3. Run the preflight from that clean, tagged commit.
4. Create a narrowly scoped npm granular access token, require 2FA on the npm account, and run `npm publish --access public --tag bootstrap`.
5. Push the bootstrap tag so the published artifact has source provenance.
6. In npm, configure the trusted publisher for organization `ContiDigital`, repository `payload-plugin-attribution`, workflow `release.yml` and environment `npm`.
7. Delete the token. It must not be kept as a repository secret.

## 5. Tag and publish

Create an annotated tag on the verified commit and push it:

```bash
git tag -a vX.Y.Z -m "payload-plugin-attribution vX.Y.Z"
git push origin vX.Y.Z
```

Create a GitHub release from the tag with the matching `CHANGELOG.md` section as its notes. Publishing the release runs `.github/workflows/release.yml`, which checks that the tag matches the package version, re-runs `release:check` and the browser suite, and publishes to npm through trusted publishing with provenance.
