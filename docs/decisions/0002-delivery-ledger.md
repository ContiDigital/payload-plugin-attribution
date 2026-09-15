# ADR 0002: A delivery ledger with claims, row locks and no handler I/O inside transactions

- Status: Accepted
- Date: 2026-09-15
- Owners: Maintainers

## Context

A conversion is a business fact that must reach several providers, each with its own availability, rate limits, eligibility windows and consent rules. The fact and the promise to deliver it must survive crashes, retries, concurrent workers and host transactions that roll back. Providers do not offer exactly-once ingestion, and Payload offers no portable `SELECT ... FOR UPDATE` across Postgres, SQLite and MongoDB.

Holding a database transaction open across a provider request would pin connections for seconds, block SQLite's single writer, and turn a slow provider into database contention.

## Decision

1. Record each conversion in `conversion-events`, unique by `eventKey`, and plan one row per destination in `conversion-deliveries`, in the same transaction as the host's own writes when a host transaction exists.
2. Revise an event by recording the same `eventKey` with a higher `revision`. Serialize concurrent recordings of one key with a row lock, supersede open delivery rows, and plan new ones.
3. Lock rows by inserting and deleting a unique lock key in `conversion-delivery-claims` within the transaction, which makes competing lockers wait on the unique index (or fail with a write conflict on MongoDB).
4. Claim each delivery attempt with a unique claim row and a lease in a short transaction, confirm the claim token after commit, then call the destination with no transaction open.
5. Settle the outcome in a second short transaction under event and delivery row locks, and discard it if the lease was reclaimed or the revision changed.
6. Recover with a sweep: expired leases, expired waits, stalled dispatches and identifier purges.

## Rationale

- Recording inside the host transaction means a rolled-back order never produces a conversion, and a committed order always has its delivery rows.
- Unique claim rows and lease fencing let any number of workers run without coordinating, on every supported database.
- Short transactions around network calls keep provider latency out of the database.
- A durable row per attempt sequence gives operators an audit trail, redelivery and health reporting without external tooling.

## Consequences

- Delivery is at least once. A crash after a provider accepts a request and before settlement resends the event after the lease expires.
- Every supported database must have transactions enabled; SQLite serializes plugin transactions within a process, and MongoDB turns lock contention into errors instead of waits.
- Dispatch is decoupled from recording through the dispatcher interface, so Payload Jobs and host queues share the same guarantees.
- The ledger grows with every attempt sequence; identifier purges bound personal data, not row counts.

## Alternatives rejected

- **Sending from `afterChange` hooks:** loses conversions when the process dies and sends conversions for transactions that later roll back.
- **Provider calls inside the recording transaction:** holds locks and connections across the network and couples host writes to provider availability.
- **Payload job retries as the only state:** job rows do not record per-destination outcomes, consent decisions or feed serving, and differ between dispatchers.
- **Database-specific locking:** `FOR UPDATE` and advisory locks do not exist across all three adapters.
