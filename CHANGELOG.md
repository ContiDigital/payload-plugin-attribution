# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-09-22

### Added

- Opt-in Data Manager value adjustments, serialized against original conversions and earlier refunds; API count retractions remain unsupported.
- Opt-in processing confirmation with durable receipts and diagnostic polling, preserving requests across worker retries.
- Browser ecommerce item arrays using the same validation as server events.

### Fixed

- Date-sensitive verification tests use a fixed clock rather than expiring over time.

## [0.1.0] - YYYY-MM-DD

### Added

- Payload plugin with a conversion ledger: `conversion-events`, `conversion-deliveries` and `conversion-delivery-claims` collections, read-only admin views, a delivery status column and a deliveries panel with resend.
- `recordConversion` with draft validation, transactional recording that joins a host transaction, revisions serialized by row locks, one purchase per transaction id, refunds tied to their purchase, lead value policies, and Google Ads conversion, restatement and retraction treatment.
- Normalization and SHA-256 hashing of buyer identifiers for Google and Meta, and an identity resolver hook for user ids, user properties and marketing consent.
- Delivery runtime with claims, leases, row-locked settlement, retries with backoff and `Retry-After`, dead and withheld states, redelivery, and a sweep that recovers leases, re-dispatches stalled rows and purges identifiers after a retention period.
- Payload Jobs dispatcher with optional sweep schedule, and a dispatcher interface for host queues.
- GA4 Measurement Protocol delivery with client id derivation, session join, consent and optional user-provided data.
- Google Ads delivery through the Data Manager API, with service account or host access tokens.
- Google Ads conversion and adjustment CSV feeds with HTTP Basic authentication, lookback windows, serving stamps and adjustment window rules.
- Meta Conversions API delivery with event mapping, action sources, Limited Data Use and test event codes.
- Per-destination consent policies.
- `verifyDestination` for validation-only checks, and `setupGa4Property` for GA4 custom dimensions and key events.
- Health and redelivery endpoints with `read`, `operate` and `pii` authorization scopes.
- `payload-plugin-attribution/next` with `attributionProxy`, `captureFromRequest` and `readAttributionCookie`: first and last touch capture with Global Privacy Control defaults, referrer classification, excluded paths and private caching.
- `payload-plugin-attribution/browser` with `captureAttribution`, `attributionForSubmit`, `consentDefaults`, `trackClient`, `createEventId` and `sanitizeAttribution`.
- `attributionField` for storing attribution on host collections.
- `collections` option to change the ledger collection slugs, with startup checks for slug and table collisions.
- A delivery reason reference in the workers guide.

### Notes

- SQLite is supported for development and tests. Plugin transactions on SQLite run one at a time per process; use Postgres or MongoDB in production.
