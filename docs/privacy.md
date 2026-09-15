# Privacy

This page covers what the ledger stores, how consent controls delivery, how identifiers are hashed, when they are purged and who can read them. The host remains responsible for its legal basis, privacy notice and consent platform.

## What is stored

| Where                             | Data                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| Attribution cookie                | Click ids, UTM parameters, `fbc`/`fbp`, landing path, external referrer host, capture times  |
| Event `attribution`               | The recorded touch: the cookie fields plus GA client and session ids and consent state       |
| Event `consent`                   | `adUserData`, `adPersonalization` and `analyticsStorage`: `granted`, `denied` or `unknown`   |
| Event `identifiers`               | Hashed buyer identifiers for Google and Meta                                                 |
| Event `context`                   | Client IP address, user agent and page URL                                                   |
| Event fields                      | `userId`, `userProperties`, `transactionId`, values, items and host `params`                 |
| Delivery `request` and `response` | The provider request body, which carries the hashed identifiers, and the provider's response |

Draft validation rejects `params`, items and channels containing `@`, and user properties containing `@` are dropped, so email addresses do not travel in those fields.

## Consent

An event's consent is resolved per signal, first match wins:

1. The draft's `consent`.
2. The consent fields in the draft's `attribution`, as captured by the browser helper.
3. For `adUserData` and `adPersonalization`, the identity resolver's `marketingConsent`.
4. `unknown`.

Each destination applies its `consentPolicy` to `adUserData` when planning a delivery:

| Policy            | `granted` | `unknown`                   | `denied`                   |
| ----------------- | --------- | --------------------------- | -------------------------- |
| `ignore`          | Sent      | Sent                        | Sent                       |
| `withhold-denied` | Sent      | Sent                        | Withheld, `consent_denied` |
| `require-granted` | Sent      | Withheld, `consent_missing` | Withheld, `consent_denied` |

GA4 defaults to `ignore`; Google Ads and Meta default to `withhold-denied`. Independently of the policy:

- GA4 is withheld with `consent_denied` when `analyticsStorage` is `denied`, whatever its `consentPolicy`. `unknown` analytics consent still sends.
- GA4 sends the consent state and omits `user_data` when `adUserData` is denied.
- Data Manager sends the consent state and omits user identifiers when `adUserData` is denied.
- Meta never sends an event whose `adUserData` is denied.

### Consent mode defaults

`consentDefaults` queues Google consent mode defaults on `dataLayer` before `gtag.js` loads, using the same `arguments` shape as Google's own snippet:

<!-- sample: browser-consent.ts -->

```ts
import { consentDefaults, trackClient } from 'payload-plugin-attribution/browser'

// Call before gtag.js loads; the consent platform later sends gtag('consent', 'update', ...).
consentDefaults({
  adPersonalization: 'denied',
  adStorage: 'denied',
  adUserData: 'denied',
  analyticsStorage: 'denied',
  region: ['AT', 'BE', 'DE', 'FR', 'GB', 'IE', 'NL'],
  waitForUpdateMs: 500,
})

// Browser-only interactions; conversions are recorded on the server.
export const trackQuoteClick = (productId: string): null | string =>
  trackClient('quote_click', { product_id: productId }, { measurementId: 'G-XXXXXXXXXX' })
```

### Global Privacy Control

Both the proxy and the browser helper honor Global Privacy Control by default, and a host consent hook or callback replaces that default. [Web capture](web-capture.md#global-privacy-control) describes exactly what each one removes. For delivery, the plugin does not see the visitor's request, so a GPC visitor's event records `adUserData` and `adPersonalization` as denied only when the host passes that consent to `recordConversion`: through the attribution posted by the browser helper, or in the draft's `consent`. The host's server handler should also derive it from `Sec-GPC: 1` on the submitting request, as the [server handler](web-capture.md#server-handler) sample does, because the helper cannot post it when JavaScript fails. With that consent and default policies, Google Ads and Meta withhold the event and GA4 receives it with ad consent denied.

## Hashing

Buyer fields are normalized and hashed with SHA-256 (hex) when the event is recorded. The draft's raw `buyer` object is not stored.

| Field       | Google                                                              | Meta                             |
| ----------- | ------------------------------------------------------------------- | -------------------------------- |
| Email       | Trimmed and lowercased; dots and `+` tags removed for Gmail, hashed | Trimmed and lowercased, hashed   |
| Phone       | E.164, hashed                                                       | E.164 digits without `+`, hashed |
| Name        | First and last name, hashed                                         | First and last name, hashed      |
| Street      | Hashed                                                              | Not used                         |
| City        | Stored as given                                                     | Letters only, hashed             |
| Region      | Stored as given                                                     | Two-letter code only, hashed     |
| Postal code | Stored as given                                                     | Hashed; five digits in the US    |
| Country     | Uppercased, stored as given                                         | Hashed                           |
| External id | Not used                                                            | Hashed                           |

A phone number without a leading `+` is normalized only when `identity.defaultPhoneCountry` is `US` or `CA`; other numbers need the `+` country code.

Hashing is pseudonymization: a hashed email still identifies a person to anyone who holds the same email. Treat identifiers as personal data.

## Retention and purge

The sweep purges an event once both its `occurredAt` and its last update are older than `privacy.identifierRetentionDays` (90 by default) and none of its deliveries are still open (`pending`, `sending` or `retry`). Purging:

- Clears `identifiers.google` and `identifiers.meta`.
- Clears `context.ipAddress`, `context.userAgent` and `context.url`.
- Clears the online identifiers in the `attribution` group: every click id (`gclid`, `gbraid`, `wbraid`, `dclid`, `srsltid`, `fbclid`, `msclkid`, `ttclid`, `twclid`, `li_fat_id`), `clickCapturedAt`, `fbc`, `fbp` and the GA client id, session id, session number and session start.
- Clears the `request` body of every delivery of the event.
- Sets `identifiersPurgedAt`.

A revision renews the retention period. Purging needs the sweep to run; see [workers](workers.md#the-sweep).

Purging keeps the rest of the `attribution` group (UTM parameters, the landing path, the referrer host, `gad_source`, `gad_campaignid`, consent and capture times), as well as `userId`, `transactionId`, values and delivery responses. Google Ads adjustments match on `transactionId`, so they keep working after a purge; a conversion row not yet served by the feed when it is purged loses its click id and is withheld. An erasure request for a person must be handled by the host, deleting or editing their events with `overrideAccess` through Payload's Local API.

## Who can read personal data

The `identifiers` and `context` fields of events and the `request` field of deliveries require the `pii` scope of `authorize`. Without a custom `authorize`, nobody has it, including admins. The rest of the ledger requires `read`. See [authorization](installation.md#authorization).

The plugin's log messages redact secret-named keys, bearer and Basic credentials, `api_secret` and `access_token` query values, Meta and Google token shapes and private keys.
