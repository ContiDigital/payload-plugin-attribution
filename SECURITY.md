# Security policy

## Supported versions

| Version        | Supported |
| -------------- | --------- |
| latest `0.1.x` | Yes       |

## Reporting a vulnerability

Do not open a public issue for a security problem.

Report it privately through GitHub's "Report a vulnerability" flow on the repository's Security tab, which opens an advisory visible only to the maintainers. Include the affected version, a description and a reproduction if you have one. We acknowledge reports within a few business days and ship a fix or mitigation as quickly as the severity warrants.

## Secrets

- **Never stored.** Provider credentials, feed credentials and the plugin `secret` live in the host's configuration. The plugin does not write them to the database.
- **Resolved at use.** A function setting is called when a delivery needs it, so credentials can come from a secrets manager and rotate without a restart. A failing or empty setting withholds the delivery.
- **Redacted logs.** Log data passes through a redactor that masks secret-named keys, bearer and Basic credentials, `api_secret` and `access_token` query values, Meta and Google token shapes and private keys. The plugin never writes to the console.
- **Sanitized provider errors.** Google authentication and Admin API failures are reduced to a status and Google's message; request objects carrying tokens or keys are never logged or rethrown.
- **Feed authentication.** The CSV endpoints compare SHA-256 digests of the supplied and configured Basic credentials with `timingSafeEqual`, reject oversized headers and respond with `Cache-Control: no-store`.
- **Provider endpoint overrides** accept only `https` URLs, or `http` on loopback addresses, without embedded credentials.

## Personal data

- **Hashing.** Buyer emails, phone numbers, names and other identifiers are normalized and SHA-256 hashed when an event is recorded; the raw buyer object is not stored. Google postal code, city, region and country are stored as given. Hashed identifiers are still personal data.
- **Retention.** The sweep clears identifiers, request context and provider request bodies once an event is older than `privacy.identifierRetentionDays` (90 by default) and has no open deliveries. Attribution fields such as click ids are kept.
- **Access.** Identifiers, request context and provider request bodies require the `pii` authorization scope, which no one has by default. Ledger rows cannot be created, edited or deleted through Payload access control.
- **Consent.** Each destination applies a consent policy to ad user data. Meta never receives an event whose ad user data consent is denied, and Google destinations drop user identifiers when it is denied.
- **Capture.** The attribution cookie holds marketing parameters only, never identity. Global Privacy Control removes ad identifiers from it unless the host supplies its own consent decision.

See [docs/privacy.md](docs/privacy.md) for the details.

## What the host is responsible for

- Protecting provider credentials, feed credentials and the plugin `secret`, and keeping the `secret` stable.
- An `authorize` function that grants `read`, `operate` and especially `pii` only to the right users.
- A lawful basis for processing, a privacy notice, and a consent platform whose decisions reach `recordConversion`, the proxy `consent` hook and the browser helper.
- Honoring erasure and access requests, including attribution fields the purge keeps.
- Running the sweep, without which identifiers are never purged.
- Setting `trustProxy` only behind a proxy that overwrites `X-Forwarded-For`, and `trustForwardedHost` only behind one that sets `X-Forwarded-Host` and `X-Forwarded-Proto`.
- Serving the feed endpoints over HTTPS only.
- Monitoring `dead` deliveries through the health endpoint.
