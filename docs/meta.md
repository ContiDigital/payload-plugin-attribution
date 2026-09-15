# Meta

Meta receives server events through the Conversions API, one event per delivery.

<!-- sample: meta.ts -->

```ts
import type { MetaDestinationOptions } from 'payload-plugin-attribution'

export const meta: MetaDestinationOptions = {
  accessToken: () => process.env.META_ACCESS_TOKEN ?? '',
  // Replaces the default mapping: list every event Meta should receive.
  events: {
    generate_lead: 'Lead',
    purchase: 'Purchase',
    walk_in_sale: { name: 'Purchase', actionSource: 'physical_store' },
  },
  limitedDataUse: false,
  pixelId: '100000000000001',
  resendRevisions: false,
  // Set only while testing: events then appear in Test Events.
  testEventCode: () => process.env.META_TEST_EVENT_CODE ?? '',
}
```

| Option            | Default               | Purpose                                                                             |
| ----------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `pixelId`         | Required              | Dataset (pixel) id                                                                  |
| `accessToken`     | Required              | Conversions API access token, sent as a bearer token                                |
| `events`          | Default mapping below | Event name to Meta event, or `{ name, actionSource }`; replaces the default mapping |
| `apiVersion`      | `'v26.0'`             | Graph API version                                                                   |
| `consentPolicy`   | `'withhold-denied'`   | Applied to `adUserData`. See [privacy](privacy.md)                                  |
| `limitedDataUse`  | `false`               | Boolean, or a function of the event, that adds Limited Data Use processing options  |
| `testEventCode`   | None                  | Sends events to Test Events instead of production                                   |
| `resendRevisions` | `false`               | Sends later revisions of an event again                                             |
| `timeoutMs`       | `5000`                | Request timeout, at most 60,000 ms                                                  |
| `enabled`         | `true`                | Keeps the options without delivering                                                |

The default mapping sends `generate_lead` as `Lead`, `purchase` as `Purchase`, `appointment_booked` as `Schedule` and `sign_up` as `CompleteRegistration`. Events without a mapping are not planned for Meta, and retractions are never sent.

## Event payload

- **Action source** follows the draft's `eventSource`: `WEB` is `website`, `PHONE` is `phone_call`, `IN_STORE` is `physical_store`, and `OTHER` (the default) is `system_generated`. A mapping's `actionSource` overrides it.
- **User data.** Hashed email, phone, first and last name, city, two-letter state, postal code (five digits in the US), country and `external_id` (the buyer's `externalId`, else the hashed `userId`). The client IP and user agent are sent as captured. `fbc` is the captured `_fbc`, or rebuilt from a captured `fbclid` and its capture time; `fbp` is the captured `_fbp`.
- **Custom data.** `value` and `currency` in major units, `order_id` from `transactionId`, and `contents` from items.
- `event_source_url` is the origin and path of `context.url`; the query string and fragment are never sent, and a token-shaped path is reduced to the origin. With `limitedDataUse`, the event carries `data_processing_options: ['LDU']` with country and state `0`, so Meta geolocates the request.

## Eligibility

A delivery is withheld when:

- `adUserData` is denied (`consent_denied`), whatever the consent policy.
- The event is not mapped (`event_not_mapped`).
- The event is more than 7 days old, or 62 days for `physical_store` (`event_too_old`).
- A `website` event lacks `context.url` or `context.userAgent` (`missing_web_context`).
- There is no customer information: no email, phone, `external_id`, `fbc`, `fbp`, or IP address together with user agent (`no_user_data`).

A response with `events_received` of at least 1 is `sent`. A 429 or 5xx response, or a Meta error marked transient or carrying a rate-limit code, retries. Token and permission errors are `dead` with `auth_error`; other errors are `dead` with `invalid_request`.

## Deduplication with the pixel

When the browser pixel reports the same conversion, Meta pairs the two events by event name and `event_id`. The server event's `event_id` is the draft's `eventId`, or its `eventKey` when `eventId` is not set. Generate one id in the browser, pass it to the pixel as `eventID`, post it with the form, and record it as `eventId`:

<!-- sample: pixel-dedupe.ts -->

```ts
import { createEventId } from 'payload-plugin-attribution/browser'

type Fbq = (command: 'track', event: string, params: object, options: { eventID: string }) => void

// The pixel and the server event share one id; send it with the form and record it as the
// draft's eventId.
export function trackLeadInPixel(fbq: Fbq): string {
  const eventId = createEventId()
  fbq('track', 'Lead', {}, { eventID: eventId })
  return eventId
}
```

## Revisions

A later revision of an event is withheld with `revision_not_resent` unless `resendRevisions` is enabled. Meta deduplicates events with the same `event_id` and `event_name` received within 48 hours, so a resent revision is dropped inside that window and counted as a second conversion after it. That is why `resendRevisions` is off by default.

## Verification

`verifyDestination` for Meta sends the event with `testEventCode` and is `ok` when Meta reports it received. Without a `testEventCode` it sends nothing and returns reason `test_event_code_required`, because a send without one creates a real conversion. Check the result in Events Manager under Test Events.
