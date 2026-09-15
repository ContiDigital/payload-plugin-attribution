# Google Ads

Google Ads receives conversions through one of two transports, and adjustments through a scheduled CSV feed:

- `transport: 'dataManager'` sends each conversion to the Data Manager API as it is delivered.
- `transport: 'feed'` serves conversions as a CSV that a Google Ads scheduled upload pulls.
- `adjustments.enabled` serves restatements and retractions as a second CSV, with either transport.

<!-- sample: google-ads.ts -->

```ts
import type { GoogleAdsDestinationOptions } from 'payload-plugin-attribution'

const feedCredentials = {
  password: () => process.env.GOOGLE_ADS_FEED_PASSWORD ?? '',
  username: 'google-ads',
}

// Conversions through the Data Manager API, adjustments through the scheduled CSV feed.
export const dataManager: GoogleAdsDestinationOptions = {
  adjustments: { enabled: true },
  conversionActions: { lead: '7000000001', sale: '7000000002' },
  feed: feedCredentials,
  loginAccountId: '1234567890',
  operatingAccountId: '9876543210',
  serviceAccountJson: () => process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON ?? '',
  transport: 'dataManager',
}

// Conversions and adjustments both through scheduled CSV feeds, matched by conversion name.
export const feed: GoogleAdsDestinationOptions = {
  adjustments: { enabled: true },
  conversionActions: { lead: 'Website lead', sale: 'Website sale' },
  feed: { ...feedCredentials, lookbackDays: 30 },
  transport: 'feed',
}
```

| Option                            | Default             | Purpose                                                                                     |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `transport`                       | Required            | `'dataManager'` or `'feed'`                                                                 |
| `conversionActions.lead`, `.sale` | Required            | Data Manager: numeric conversion action ids. Feed: conversion action names                  |
| `operatingAccountId`              | Data Manager only   | Google Ads customer id, digits only                                                         |
| `loginAccountId`                  | None                | Manager account id, digits only, when access comes through a manager account                |
| `serviceAccountJson`              | Data Manager only   | Service account key JSON, unless `accessToken` is set                                       |
| `accessToken`                     | None                | Function returning a Data Manager bearer token, for hosts that mint their own tokens        |
| `feed.username`, `feed.password`  | Feed or adjustments | HTTP Basic credentials Google Ads uses to pull the CSVs                                     |
| `feed.lookbackDays`               | `90`                | Days of events each pull includes, 1 to 90                                                  |
| `adjustments.enabled`             | `false`             | Serves the adjustments CSV                                                                  |
| `allowBraidsInFeed`               | `false`             | Puts a `gbraid` or `wbraid` in the conversions CSV click id column when there is no `gclid` |
| `consentPolicy`                   | `'withhold-denied'` | Applied to `adUserData`. See [privacy](privacy.md)                                          |
| `enabled`                         | `true`              | Keeps the options without delivering                                                        |

Feed conversion names are 1 to 100 characters, with no commas, double quotes, newlines or surrounding whitespace, and cannot start with `+`, `-`, `=`, `@`, a tab or a carriage return.

## Which events reach Google Ads

A draft's `googleAds` decides its treatment; see [recording](recording.md#google-ads-treatment). Only events with `action` `lead` or `sale` and a `transactionId` are delivered: `conversion` events to the conversions transport, `restatement` and `retraction` events to the adjustments feed.

A conversion is eligible when it has at least one of:

- **A click id.** A `gclid`, `gbraid` or `wbraid` captured no more than 90 days before the conversion.
- **User data.** A hashed email or phone, with the conversion no more than 63 days old and `adUserData` not denied.

Otherwise the delivery is withheld with `no_identifiers`, `click_window_closed`, `user_data_window_closed` or `consent_denied`.

## Data Manager

Each delivery posts one event to `events:ingest` with the transaction id, value and currency, event source, consent, and identifiers:

- **One click id per event.** Data Manager rejects an event with more than one, so the plugin sends `gclid`, else `gbraid`, else `wbraid`.
- **User identifiers.** Hashed email and phone are sent unless `adUserData` is denied. Only the identifiers of the matching side are sent: a stale click id is dropped when only user data is in its window, and the reverse.
- **Address matching** requires a given name, family name, country and postal code. The names are sent hashed, the postal code as given, and the country as the ISO 3166-1 alpha-2 region code. An address missing any of the four is left out.

**Authentication.** When both `accessToken` and `serviceAccountJson` are set, the access token wins. Service account tokens use the `datamanager` scope and are cached in the process until a minute before they expire.

| Response                       | Outcome                                           |
| ------------------------------ | ------------------------------------------------- |
| 2xx                            | `sent`, with the returned `requestId`             |
| 429, 5xx, token service outage | `retry`, honoring `Retry-After`                   |
| 401, 403                       | `dead`, `permission_denied`                       |
| 400                            | `dead`, `invalid_argument`, with Google's message |
| Rejected credentials           | `dead`, `auth_error`                              |

## Feeds

Schedule uploads in Google Ads from these HTTPS URLs, using the feed username and password:

- `GET /api/attribution/google-ads/conversions.csv`, served when `transport` is `feed`.
- `GET /api/attribution/google-ads/adjustments.csv`, served when `adjustments.enabled` is set.

A request without valid credentials gets 401 and logs a warning, `feed authentication failed`, without the submitted credentials. The plugin does not rate-limit these URLs; limit them in your proxy or CDN. A file that is not enabled returns 404. Responses are `Cache-Control: no-store`, start with `Parameters:TimeZone=UTC`, and report their row count in `X-Conversion-Rows`.

```text
Parameters:TimeZone=UTC
Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Order ID,Ad User Data,Ad Personalization
Order ID,Conversion Name,Adjustment Time,Adjustment Type,Adjusted Value,Adjusted Value Currency
```

The first header belongs to the conversions file and the second to the adjustments file.

- **Rows.** Each pull includes eligible and served rows for events that occurred within `lookbackDays`, on their current revision. Google Ads deduplicates repeated rows by order id, so every pull returns the whole window.
- **Conversions need a click id.** The feed has no user data columns. A conversion with only user data, or only a braid without `allowBraidsInFeed`, is withheld with `feed_requires_click_id`.
- **Blank values.** Retraction rows, and conversions without a value, leave value and currency blank. Google Ads then applies the conversion action's default value to such a conversion.
- **Serving.** A pull stamps `firstServedAt` on a row the first time it is served; later pulls write nothing, so `lastServedAt` equals the first serve. Rows are stamped before the response is sent, which is safe because the next pull serves them again.
- **Leaving the file.** An unserved row that becomes ineligible is withheld. A served row that becomes ineligible only leaves the file.
- Cells that a spreadsheet would evaluate as a formula are prefixed with `'`.

## Adjustments

Restatements (`RESTATE`) set a conversion to a new value: `adjustedValueCents`, else `valueCents`. Retractions (`RETRACT`) remove it and leave value and currency blank. The adjustment time is the event's `occurredAt`.

An adjustment waits for its original conversion:

- The original must reach Google: any delivery of the original conversion, across its revisions and redeliveries, `sent` through Data Manager or served at least once through the feed. A later revision whose row is withheld, dead or superseded does not take that back, and the adjustment windows run from the earliest such delivery. When no delivery of the original ever reached Google, the adjustment is withheld with `original_not_delivered`.
- While the original is still on its way, the adjustment checks again every 6 hours for up to 7 days after the original's row was created, then is withheld.
- The adjustment becomes eligible 24 hours after the original reached Google, and is withheld with `adjustment_window_closed` 54 days after.
- Adjustments after a served retraction of the same order and action are withheld with `retracted`, because Google ignores them. Rows served before the retraction stay in the file.
- A restatement without any value is withheld with `missing_value`.

Whether a file adjustment applies to a conversion ingested through Data Manager is not confirmed in Google's documentation; it is on the live canary checklist in [RELEASING.md](../RELEASING.md).

## Verification

`verifyDestination` for `googleAds` on Data Manager evaluates eligibility, mints a token and posts the event with `validateOnly: true`, which Google validates without ingesting. On the feed transport, and for `googleAdsAdjustment`, it renders the CSV row locally, applying the same original, window and retraction rules, and makes no request.
