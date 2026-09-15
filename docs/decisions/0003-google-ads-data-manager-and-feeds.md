# ADR 0003: Google Ads through Data Manager for conversions and scheduled feeds for adjustments

- Status: Accepted
- Date: 2026-09-15
- Owners: Maintainers

## Context

Google Ads accepts offline conversions through several channels: the Google Ads API, the Data Manager API, and scheduled uploads that pull a CSV from an HTTPS URL. Conversions can carry click ids, hashed user data or both. Businesses with deposits, balances and refunds also need restatements and retractions after the original conversion.

The Google Ads API requires a developer token and client library upkeep. The Data Manager API ingests conversions with a service account, but does not document conversion adjustments. Scheduled uploads handle both conversions and adjustments, need no API access, and are pulled on Google's schedule rather than pushed.

## Decision

1. Send conversions through the Data Manager API when `transport` is `dataManager`, authenticated by a service account or a host-supplied access token.
2. Serve conversions as a Basic-authenticated CSV for scheduled uploads when `transport` is `feed`.
3. Serve restatements and retractions as a second CSV, `adjustments.csv`, with either transport.
4. Gate adjustments on the original having reached Google, a 24-hour settling delay, a closing window and prior retractions, and record per row when Google first pulled it.
5. Keep the Google Ads API out of scope.

## Rationale

- Data Manager gives immediate, per-event outcomes for conversions with both click ids and user data, without a developer token.
- Scheduled uploads are the documented path for adjustments and work for accounts without API access.
- Recording feed serving as delivery state lets the adjustment rules treat both transports the same way.
- Avoiding the Google Ads API removes a heavy dependency and an access approval process from every host.

## Consequences

- Hosts using adjustments configure feed credentials and a scheduled upload even with the Data Manager transport.
- A feed row counts as delivered when first served, not when Google imports it; Google deduplicates repeated rows by order id.
- The conversions feed cannot carry user data, so user-data-only conversions need the Data Manager transport.
- Whether a file adjustment applies to a Data Manager conversion is not confirmed by Google's documentation and is tracked as a pending live canary.

## Alternatives rejected

- **Google Ads API for everything:** requires a developer token, approval and a large client dependency.
- **Feeds only:** loses user-data matching and immediate per-event errors.
- **Data Manager only:** has no documented adjustment support.
- **Pushing files to Google:** needs SFTP or storage credentials the host would have to provision and rotate.
