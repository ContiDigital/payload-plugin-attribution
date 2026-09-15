# Workers, redelivery and backfill

Recording writes delivery rows; workers deliver them. This page covers the delivery lifecycle, the built-in Payload Jobs dispatcher, host dispatchers, the sweep, redelivery and backfill.

## Delivery lifecycle

1. `recordConversion` creates one row per planned destination: `pending`, or `withheld` with a reason when consent or configuration rules it out.
2. The dispatcher hands each `pending` row id to a worker. Inside a host transaction, it receives that `req`, so the Payload Jobs dispatcher queues its job in the same transaction. Otherwise it runs after commit, and a dispatch failure is logged for the sweep to recover.
3. The worker calls `runDelivery`. It claims the attempt with a unique claim row and a 2-minute lease in a short transaction, calls the destination with no transaction open, then settles the result under row locks.
4. The destination's outcome settles the row:

| Status       | Meaning                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| `pending`    | Waiting for its first attempt                                                                |
| `sending`    | Claimed by a worker until its lease expires                                                  |
| `retry`      | Waiting for `nextAttemptAt` after a retryable failure, or waiting for an original conversion |
| `sent`       | The provider accepted the request                                                            |
| `eligible`   | Ready for the next Google Ads feed pull                                                      |
| `served`     | Included in a feed response at least once                                                    |
| `withheld`   | Not sent, with a reason such as `consent_denied`                                             |
| `dead`       | Failed permanently, or `retry_exhausted` after `maxAttempts`                                 |
| `superseded` | Replaced by a newer revision or a redelivery                                                 |

Retries back off from 30 seconds, doubling per attempt up to 30 minutes, with 20% jitter. A provider's `Retry-After` is honored up to 6 hours. Each destination call times out after 30 seconds, or `meta.timeoutMs` for Meta. When another worker has reclaimed an expired lease, the first worker's result is discarded.

Delivery is at least once. A worker that crashes after the provider accepted a request, but before settling, leaves the row `sending`; the sweep then retries it and the provider receives the event again. The same happens to a worker that is only slow: when settling starts after the lease has expired and the sweep has already moved the row to `retry`, the late result is fenced (status, attempt and revision are re-checked under the row lock), discarded with a warning (`delivery lease was reclaimed, result discarded`), and the next attempt sends again. The plugin has no exactly-once machinery; rely on provider-side deduplication: GA4 `transaction_id` for purchases, the Google Ads order id, and Meta `event_id` within 48 hours. On MongoDB, settling retries a bounded number of times on WriteConflict, so two deliveries of one event finishing together both settle.

## Reasons

A delivery row's `reason`, shown in the deliveries panel and in `deliverySummary`, says why the row is in its status. `http_<status>` carries the provider's HTTP status code.

### Retry

| Reason                      | Destination            | Meaning                                                                           |
| --------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `network_error`             | All                    | The request did not reach the provider                                            |
| `http_<status>`             | All                    | A 429 or 5xx response; the next attempt honors `Retry-After`                      |
| `timeout`                   | All                    | The destination call exceeded its timeout                                         |
| `aborted`                   | All                    | The `signal` passed to `runDelivery` aborted the call; the attempt is not counted |
| `lease_expired`             | All                    | The worker's lease expired before it settled, and the sweep re-dispatched the row |
| `settings_unavailable`      | All                    | A setting function threw, for example during a secret manager outage              |
| `unexpected_error`          | All                    | The destination handler threw; the error is logged                                |
| `invalid_outcome`           | All                    | A handler returned a value that is not an outcome                                 |
| `auth_network_error`        | Google Ads             | The token request did not reach Google                                            |
| `auth_unavailable`          | Google Ads             | Google's token service, or the host `accessToken` function, failed temporarily    |
| `meta_transient`            | Meta                   | Meta marked the error transient or returned a rate-limit code                     |
| `awaiting_original`         | Google Ads adjustments | Waiting for the original conversion to be delivered                               |
| `adjustment_window_pending` | Google Ads adjustments | Waiting until Google accepts adjustments to the original conversion               |

A waiting row that reaches its deadline becomes `withheld`. When the worker finds it past the deadline, the row keeps its waiting reason, `awaiting_original` or `adjustment_window_pending`. When the sweep or a later attempt finds it first, the reason is `deadline_passed`.

### Withheld

| Reason                     | Destination                     | Meaning                                                                                                                     |
| -------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `consent_denied`           | All                             | `adUserData` is denied under the consent policy, or `analyticsStorage` is denied for GA4. See [privacy](privacy.md#consent) |
| `consent_missing`          | All                             | `require-granted` and consent is `unknown`                                                                                  |
| `not_configured`           | All                             | The destination is disabled or a required setting is empty                                                                  |
| `revision_not_resent`      | GA4, Meta                       | A later revision, and `resendRevisions` is off                                                                              |
| `deadline_passed`          | All                             | A waiting row reached its deadline                                                                                          |
| `no_handler`               | All                             | No handler is registered for the destination                                                                                |
| `event_not_mapped`         | Meta                            | The event name is no longer in `meta.events`                                                                                |
| `event_too_old`            | Meta                            | Older than 7 days, or 62 days for `physical_store`                                                                          |
| `missing_web_context`      | Meta                            | A `website` event without `context.url` or `context.userAgent`                                                              |
| `no_user_data`             | Meta                            | No customer information to match                                                                                            |
| `no_identifiers`           | Google Ads                      | No click id and no hashed email or phone                                                                                    |
| `click_window_closed`      | Google Ads                      | The click is older than 90 days and user data cannot match instead                                                          |
| `user_data_window_closed`  | Google Ads                      | No click id, and the event is older than 63 days                                                                            |
| `feed_requires_click_id`   | Google Ads feed                 | The feed has no user data columns, so it needs a `gclid`, or a braid with `allowBraidsInFeed`                               |
| `not_applicable`           | Google Ads feed and adjustments | The event is not a conversion or adjustment the feed can serve                                                              |
| `missing_value`            | Google Ads adjustments          | A restatement without any value                                                                                             |
| `original_not_delivered`   | Google Ads adjustments          | The original conversion was withheld, dead or superseded, so Google never received it                                       |
| `retracted`                | Google Ads adjustments          | The order was already retracted                                                                                             |
| `adjustment_window_closed` | Google Ads adjustments          | Google no longer accepts adjustments to the original conversion                                                             |

### Dead

| Reason              | Destination      | Meaning                                                                      |
| ------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `retry_exhausted`   | All              | `maxAttempts` attempts were used, including rows left over after lowering it |
| `event_not_found`   | All              | The event was deleted                                                        |
| `http_<status>`     | All              | Any other unsuccessful response without a more specific reason               |
| `invalid_payload`   | GA4, Google Ads  | The provider request could not be built from the event                       |
| `auth_error`        | Google Ads, Meta | The credentials or token were rejected                                       |
| `permission_denied` | Google Ads       | Data Manager answered 401 or 403                                             |
| `invalid_argument`  | Google Ads       | Data Manager answered 400; the response keeps its error message              |
| `invalid_request`   | Meta             | Meta rejected the event; the response keeps its message and `fbtrace_id`     |
| `invalid_response`  | Meta             | A 2xx response without `events_received`                                     |

### Superseded

| Reason                | Destination | Meaning                                    |
| --------------------- | ----------- | ------------------------------------------ |
| `revision_superseded` | All         | A newer revision of the event was recorded |
| `redelivered`         | All         | A redelivery replaced the row              |

### Results that are not stored on a row

| Reason                     | Where               | Meaning                                                                              |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `plugin_disabled`          | `runDelivery`       | The plugin is disabled; the row is unchanged                                         |
| `not_eligible`             | `verifyDestination` | The event would produce no feed row                                                  |
| `test_event_code_required` | `verifyDestination` | Meta verification needs `testEventCode`, so it never creates a real conversion event |

## Payload Jobs

The default `payloadJobsDispatcher()` registers two tasks, `attributionDeliver` and `attributionSweep`, and queues one `attributionDeliver` job per row on the plugin's `queue` (`attribution` by default). Retries are queued as new jobs with `waitUntil`. `payloadJobsDispatcher({ queue })` uses another queue for delivery jobs.

The plugin never runs the queue. Configure `jobs.autoRun` for that queue in your Payload config, as in the [README](../README.md#minimal-configuration), or run a worker process from your scheduler:

<!-- sample: jobs-worker.ts -->

```ts
import { getPayload } from 'payload'

import config from './payload.config.js'

// A worker process run by an external scheduler instead of jobs.autoRun in the web process.
const payload = await getPayload({ config, cron: false })
try {
  await payload.jobs.handleSchedules({ queue: 'attribution' })
  await payload.jobs.run({ limit: 100, queue: 'attribution' })
} finally {
  await payload.destroy()
}
```

`sweep.cron` adds a schedule to the sweep task on `sweep.queue`, or the plugin queue. `jobs.autoRun` for that queue enqueues it; a separate worker calls `payload.jobs.handleSchedules()` first, as above.

A host task registered under `attributionDeliver` or `attributionSweep` wins over the plugin's, and the plugin logs a warning. If that leaves `sweep.cron` without a sweep task carrying it, the config throws.

## Host dispatchers

An `AttributionDispatcher` has a `name`, a `dispatch({ deliveryId, notBefore, payload, req })` function, and an optional `install(config, options)` hook for registering what it needs. Pass one as the `dispatcher` option:

<!-- sample: host-dispatcher.ts -->

```ts
import type { Payload } from 'payload'
import type { AttributionDispatcher } from 'payload-plugin-attribution'

import { runDelivery, sweepDeliveries } from 'payload-plugin-attribution'

export type DeliveryMessage = { deliveryId: string }
export type DeliveryQueue = {
  send: (message: DeliveryMessage, options: { delaySeconds: number }) => Promise<void>
}

const delaySeconds = (notBefore?: Date): number =>
  notBefore ? Math.max(0, Math.ceil((notBefore.getTime() - Date.now()) / 1000)) : 0

export const queueDispatcher = (queue: DeliveryQueue): AttributionDispatcher => ({
  name: 'host-queue',
  dispatch: ({ deliveryId, notBefore }) =>
    queue.send({ deliveryId: String(deliveryId) }, { delaySeconds: delaySeconds(notBefore) }),
})

// One message is one attempt. A retry dispatches a new message with its own notBefore.
export async function handleDeliveryMessage(
  payload: Payload,
  queue: DeliveryQueue,
  message: DeliveryMessage,
): Promise<void> {
  const deliveryId =
    payload.db.defaultIDType === 'number' ? Number(message.deliveryId) : message.deliveryId
  const result = await runDelivery({ deliveryId, payload })
  // Queues cap their delay; a message that arrives early goes back until the attempt is due.
  if (result.status === 'not_due' && result.nextAttemptAt) {
    await queue.send(message, { delaySeconds: delaySeconds(new Date(result.nextAttemptAt)) })
  }
}

// Run every few minutes: a custom dispatcher gets no scheduled sweep task.
export const onSchedule = (payload: Payload) => sweepDeliveries({ payload })
```

- **Transactions.** `req` is set when the recording joined a host transaction. A queue outside the database can receive a message for a row that is not committed yet, or never will be. `runDelivery` then returns `not_found`, and the sweep re-dispatches committed rows that were not delivered. A transactional outbox table avoids that gap; `dev/hostDispatcher.ts` in this repository is one.
- **Ids.** `deliveryId` is a number on Postgres and SQLite with numeric ids, and a string on MongoDB. Convert text ids back with `payload.db.defaultIDType`.
- **Results.** `runDelivery` returns `{ deliveryId, status, reason, nextAttemptAt }`. Besides the row statuses, `not_due` means the attempt is scheduled later, `claimed_elsewhere` means another worker holds it, and `not_found` means no such row. A retry calls `dispatch` again with `notBefore`.
- **Aborts.** Pass `signal` to `runDelivery` to cancel a destination call; an aborted attempt is released without counting.
- **Duplicates.** One delivery can be dispatched more than once: a retry dispatches again, and the sweep re-dispatches due rows it has not seen dispatched in the last 5 minutes. A queue that deduplicates should key messages on `deliveryId` together with `notBefore`, not `deliveryId` alone, or it can drop a retry. A duplicate message is harmless: `runDelivery` claims each attempt once and returns `claimed_elsewhere` or `not_due` for the other.
- **Sweep.** A custom dispatcher gets no sweep task. Call `sweepDeliveries({ payload })` every few minutes.

## The sweep

`sweepDeliveries({ payload, limit })` handles up to `limit` rows (100 by default) in each of four passes:

1. Rows `sending` past their lease go back to `retry` and are re-dispatched, or become `dead` when their attempts are used up.
2. Rows waiting past their deadline become `withheld` with `deadline_passed`.
3. `pending` and `retry` rows that are due and were not dispatched in the last 5 minutes are re-dispatched.
4. Events past `privacy.identifierRetentionDays` have their identifiers purged. See [privacy](privacy.md#retention-and-purge).

It returns `{ recovered, redispatched, purged }`. Run it every few minutes.

`GET /api/attribution/health` (scope `read`) reports counts per status, rows `sending` past their lease, rows that went `dead` in the last 24 hours, and the oldest `pending` row's creation time.

## Redelivery

`redeliverConversion({ payload, eventId, destinations, force, req })` creates a new attempt sequence for the event's current revision:

<!-- sample: redeliver.ts -->

```ts
import type { Payload } from 'payload'

import { redeliverConversion } from 'payload-plugin-attribution'

// Sends one event to Meta again, for example after replacing an expired access token.
// force is required only when the latest Meta delivery was already sent.
export async function resendToMeta(payload: Payload, eventId: number | string, force = false) {
  const rows = await redeliverConversion({ destinations: ['meta'], eventId, force, payload })
  return rows.map(({ id, destination, status }) => ({ id, destination, status }))
}
```

- Without `destinations`, it redelivers every destination that already has a row on the current revision.
- Delivery planning runs again, so current consent and configuration apply, and a new row can be `withheld`.
- An earlier row that is still open becomes `superseded`.
- It throws `event_not_found` (404), `already_sent` (409) unless `force` is set, `identifiers_purged` (409) unless `force` is set, `delivery_in_progress` (409) while a lease is live, and `destination_not_applicable` (400) when the destination would not be planned for this event.
- `already_sent` covers a sent row and a feed row Google already pulled. `identifiers_purged` means the sweep removed the event's identifiers, so a forced resend carries less than the original delivery.

`POST /api/attribution/events/:id/redeliver` (scope `operate`) takes `{ "destinations": [...], "force": true }` and returns the new rows. The deliveries panel's resend action calls it.

## Backfill

Events recorded before a destination was configured, or with it turned off in the draft, have no row for it. `redeliverConversion` with an explicit destination creates the first row for such an event:

<!-- sample: backfill.ts -->

```ts
import type { Payload } from 'payload'
import type { ConversionEventDoc } from 'payload-plugin-attribution'

import { redeliverConversion } from 'payload-plugin-attribution'

// Creates Google Ads deliveries for conversions recorded before the destination was enabled.
export async function backfillGoogleAds(payload: Payload, since: string): Promise<number> {
  let created = 0
  for (let page = 1; ; page += 1) {
    const result = await payload.find({
      // The default slug; use your `collections.events.slug` if you changed it.
      collection: 'conversion-events',
      depth: 0,
      joins: false,
      limit: 100,
      overrideAccess: true,
      page,
      sort: 'occurredAt',
      where: {
        and: [
          { occurredAt: { greater_than_equal: since } },
          { googleAdsKind: { equals: 'conversion' } },
          { googleAdsAction: { in: ['lead', 'sale'] } },
        ],
      },
    })
    for (const event of result.docs as unknown as ConversionEventDoc[]) {
      if (!event.deliverySummary?.googleAds) {
        const rows = await redeliverConversion({
          destinations: ['googleAds'],
          eventId: event.id,
          payload,
        })
        created += rows.length
      }
    }
    if (!result.hasNextPage) {
      return created
    }
  }
}
```

The destination's own windows still apply: Google Ads withholds clicks older than 90 days and user data older than 63 days, and Meta withholds events older than 7 days.
