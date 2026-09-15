# GA4

GA4 events go to the Measurement Protocol. The plugin can also check events against the Measurement Protocol validation server and prepare a property's custom dimensions and key events through the Admin API.

## Options

<!-- sample: ga4-options.ts -->

```ts
import type { Ga4DestinationOptions } from 'payload-plugin-attribution'

export const ga4: Ga4DestinationOptions = {
  apiSecret: () => process.env.GA4_API_SECRET ?? '',
  consentPolicy: 'ignore',
  euEndpoint: false,
  measurementId: 'G-XXXXXXXXXX',
  // Only property setup reads this.
  propertyId: '123456789',
  resendRevisions: false,
  userProvidedData: false,
}
```

| Option             | Default    | Purpose                                                                                              |
| ------------------ | ---------- | ---------------------------------------------------------------------------------------------------- |
| `measurementId`    | Required   | Web data stream measurement id                                                                       |
| `apiSecret`        | Required   | Measurement Protocol API secret for that stream                                                      |
| `propertyId`       | None       | Numeric property id; only `setupGa4Property` reads it                                                |
| `euEndpoint`       | `false`    | Sends to `region1.google-analytics.com`                                                              |
| `consentPolicy`    | `'ignore'` | `ignore`, `withhold-denied` or `require-granted`, applied to `adUserData`. See [privacy](privacy.md) |
| `userProvidedData` | `false`    | Adds hashed email, phone, name and address as `user_data` unless `adUserData` is denied              |
| `resendRevisions`  | `false`    | Sends later revisions of an event again                                                              |
| `enabled`          | `true`     | Keeps the options without delivering                                                                 |

## Event payload

- **Client id.** The captured `gaClientId`, or a pseudonymous id derived from the plugin `secret` and the event's user id, transaction id or event key.
- **User id and properties.** `user_id` and `user_properties` come from the identity resolver. Property values containing `@` are dropped.
- **Time.** Events within 71 hours of the send carry `timestamp_micros`, an hour inside Google's 72 hour limit. Older events are sent at the current time with a `sale_date` parameter.
- **Session.** `session_id` is attached when the attribution carries a GA session that started within 24 hours before the event, so the event joins that session's source.
- **Parameters.** `transaction_id`, `currency`, `value`, `tax` and `shipping` in major units, `items`, `sales_channel` from `channel`, `event_source`, `engagement_time_msec`, then host `params` up to 25 parameters in total.
- **Consent.** `ad_user_data` and `ad_personalization` are sent when known. An event whose `analyticsStorage` is `denied` is never sent: its delivery is withheld with `consent_denied`, whatever `consentPolicy` says. `unknown` analytics consent still sends.
- A refund is GA4's `refund` event with its `transaction_id` and refunded `value`.

A 2xx response settles the delivery as `sent`. The Measurement Protocol does not validate what it receives, so `sent` means receipt, not processing. A 429 or 5xx response retries, honoring `Retry-After`; any other status is `dead`. A payload of 130 kB or more is `dead` with reason `invalid_payload`.

Later revisions of an event are withheld with reason `revision_not_resent` unless `resendRevisions` is enabled; GA4 counts a resent event again.

## Verification

`verifyDestination` for GA4 posts the event to the Measurement Protocol validation server (`/debug/mp/collect`) with `validation_behavior: ENFORCE_RECOMMENDATIONS` in the request body. The validation server never ingests events. The result is `ok` only when the response has no `validationMessages`; the messages are returned in `details`.

To see events arrive, use DebugView on a test property.

## Property setup

`setupGa4Property` compares a `PropertyPlan` with the property named by `propertyId` and lists the custom dimensions and key events it is missing. It is a dry run unless `apply: true`, which creates them.

<!-- sample: ga4-setup.ts -->

```ts
import type { Payload } from 'payload'
import type { PropertyPlan } from 'payload-plugin-attribution'

import { setupGa4Property } from 'payload-plugin-attribution'

export const plan: PropertyPlan = {
  eventDimensions: ['sales_channel', 'event_source'],
  keyEvents: ['generate_lead', { countingMethod: 'ONCE_PER_EVENT', eventName: 'purchase' }],
}

// Lists what is missing and changes nothing.
export const previewProperty = (payload: Payload, serviceAccountJson: string) =>
  setupGa4Property({ payload, plan, serviceAccountJson })

// Creates the missing custom dimensions and key events.
export const applyProperty = (payload: Payload, serviceAccountJson: string) =>
  setupGa4Property({ apply: true, payload, plan, serviceAccountJson })
```

- Key events use `ONCE_PER_EVENT` unless the plan sets `countingMethod: 'ONCE_PER_SESSION'`.
- Dimension names follow GA4 parameter rules: 40 characters for event and item dimensions, 24 for user dimensions. A property holds at most 50 event, 10 item and 25 user custom dimensions and 30 key events; a plan that would exceed a limit throws before anything is created.
- Existing dimensions and key events are never changed or archived.
- Authentication is a service account JSON with `analytics.readonly` for a dry run and `analytics.edit` with `apply`, or an `accessToken` function for hosts that mint their own tokens. Grant the service account access to the property.

The result lists `manualSteps` the Admin API does not cover: data retention for your property tier, the reporting identity, BigQuery export, Google Ads links and key event import, and consent settings.

## Command line

The repository's `dev/scripts/attribution.ts` wraps property setup and verification. Copy it into your project and point its config import at your Payload config. `payload run` needs `--` before the script's own flags:

```bash
pnpm payload run scripts/attribution.ts -- setup-ga4 --plan ga4-plan.json
pnpm payload run scripts/attribution.ts -- setup-ga4 --plan ga4-plan.json --apply
pnpm payload run scripts/attribution.ts -- verify --destination ga4 --event 42
```

`setup-ga4` is a dry run unless `--apply` is passed. It reads the service account JSON from `GOOGLE_SERVICE_ACCOUNT_JSON`, or from the variable named by `--service-account-json-env`; `--access-token-env` names a variable holding a bearer token instead. `verify` accepts `ga4`, `googleAds`, `googleAdsAdjustment` and `meta`. Both print JSON.

A plan file:

```json
{
  "eventDimensions": ["sales_channel", "event_source"],
  "keyEvents": ["generate_lead", "purchase"]
}
```
