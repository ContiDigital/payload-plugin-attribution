import type { Payload, PayloadRequest, Where } from 'payload'

import { setTimeout as delay } from 'node:timers/promises'

import type {
  Attribution,
  ConsentState,
  ConversionDraft,
  ConversionEventDoc,
  DeliveryDoc,
  DeliverySummary,
  NormalizedOptions,
  OriginalConversion,
  ResolvedIdentity,
} from '../../types/index.js'
import type { Logger } from '../utilities/logger.js'

import {
  DEFAULT_CURRENCY,
  PLUGIN_SLUG,
  PURCHASE_CLAIM_PREFIX,
  TERMINAL_STATUSES,
  WRITE_CONFLICT_RETRY_DELAY_MS,
} from '../../constants.js'
import { googleIdentifiers } from '../../core/identifiers/google.js'
import { metaIdentifiers } from '../../core/identifiers/meta.js'
import { validName } from '../../core/names.js'
import { sanitizeAttribution } from '../../core/sanitize.js'
import { collectionSlugs, getPluginContext } from '../../plugin/getPluginContext.js'
import { planDeliveries } from '../deliveries/planDeliveries.js'
import { lockRow } from '../deliveries/store.js'
import { isMongoWriteConflict, isUniqueConflict, PluginError } from '../utilities/errors.js'
import { createLogger } from '../utilities/logger.js'
import { currentTransactionReq, withTransaction } from '../utilities/transaction.js'
import { resolveAdsTreatment } from './resolveAdsTreatment.js'
import { validateDraft, validStableID } from './validateDraft.js'
import { resolveValueCents } from './valuePolicy.js'

type Context = { log: Logger; options: NormalizedOptions; payload: Payload }
type IdentityResult = { identity: null | ResolvedIdentity; ok: true } | { ok: false }
type Outcome = { event: ConversionEventDoc | null; pending: DeliveryDoc[] }

const CONSENT_FIELDS = [
  ['adUserData', 'consentAdUserData', true],
  ['adPersonalization', 'consentAdPersonalization', true],
  ['analyticsStorage', 'consentAnalyticsStorage', false],
] as const

// Payload merges group fields on update; a revision is a full snapshot, so omitted leaves are cleared.
const REPLACED_GROUPS = ['attribution', 'context', 'identifiers', 'subject'] as const

const findEvent = async (
  payload: Payload,
  req: PayloadRequest,
  where: Where,
): Promise<ConversionEventDoc | null> => {
  const { docs } = await payload.find({
    collection: collectionSlugs(payload).events as never,
    depth: 0,
    joins: false,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where,
  })
  return (docs[0] as unknown as ConversionEventDoc | undefined) ?? null
}

const decided = (value: unknown): ConsentState | undefined =>
  value === 'granted' || value === 'denied' ? value : undefined

const resolveConsent = (
  draft: ConversionDraft,
  attribution: Attribution | null,
  identity: null | ResolvedIdentity,
): ConversionEventDoc['consent'] => {
  const marketing =
    identity?.marketingConsent === undefined
      ? undefined
      : identity.marketingConsent
        ? 'granted'
        : 'denied'
  const consent = {} as ConversionEventDoc['consent']
  for (const [field, attributionField, followsMarketing] of CONSENT_FIELDS) {
    consent[field] =
      decided(draft.consent?.[field]) ??
      decided(attribution?.[attributionField]) ??
      (followsMarketing ? marketing : undefined) ??
      'unknown'
  }
  return consent
}

const userProperties = (identity: null | ResolvedIdentity): Record<string, number | string> =>
  Object.fromEntries(
    Object.entries(identity?.userProperties ?? {}).filter(
      ([key, value]) =>
        validName(key, 24) &&
        (typeof value === 'string' ? !value.includes('@') : Number.isFinite(value)),
    ),
  )

const replacement = (
  data: Record<string, unknown>,
  previous: ConversionEventDoc,
): Record<string, unknown> => {
  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, value ?? null]),
  )
  for (const group of REPLACED_GROUPS) {
    const before = (previous[group] ?? {}) as Record<string, unknown>
    result[group] = {
      ...Object.fromEntries(Object.keys(before).map((leaf) => [leaf, null])),
      ...(data[group] as Record<string, unknown> | undefined),
    }
  }
  return result
}

const guardExisting = (
  found: ConversionEventDoc,
  draft: ConversionDraft,
  log: Logger,
): 'identity_changed' | 'replay' | undefined => {
  if (found.revision >= (draft.revision ?? 1)) {
    return 'replay'
  }
  if (
    found.name !== draft.name ||
    (found.transactionId ?? undefined) !== draft.transactionId ||
    Date.parse(found.occurredAt) !== Date.parse(draft.occurredAt)
  ) {
    log.warn('event identity cannot change on revision', { eventKey: draft.eventKey })
    return 'identity_changed'
  }
}

const resolveIdentity = async (
  { log, options, payload }: Context,
  draft: ConversionDraft,
  req: PayloadRequest | undefined,
): Promise<IdentityResult> => {
  if (draft.customerId === undefined || !options.identity.resolve) {
    return { identity: null, ok: true }
  }
  const identity = await options.identity.resolve({ customerId: draft.customerId, payload, req })
  if (identity && !validStableID(identity.userId, 256)) {
    log.warn('identity resolver returned an invalid user id', { eventKey: draft.eventKey })
    return { ok: false }
  }
  return { identity, ok: true }
}

const findOriginal = async (
  payload: Payload,
  req: PayloadRequest,
  draft: ConversionDraft,
): Promise<OriginalConversion> => {
  const action = draft.googleAds?.action ?? 'none'
  if (!draft.transactionId || action === 'none') {
    return null
  }
  const original = await findEvent(payload, req, {
    and: [
      { transactionId: { equals: draft.transactionId } },
      { googleAdsAction: { equals: action } },
      { googleAdsKind: { equals: 'conversion' } },
    ],
  })
  return original
    ? { name: original.name, eventKey: original.eventKey, occurredAt: original.occurredAt }
    : null
}

const writeDeliveries = async (
  payload: Payload,
  req: PayloadRequest,
  event: ConversionEventDoc,
  previous: ConversionEventDoc | null,
  plan: ReturnType<typeof planDeliveries>,
): Promise<DeliveryDoc[]> => {
  if (previous) {
    const superseded = await payload.update({
      collection: collectionSlugs(payload).deliveries as never,
      data: { reason: 'revision_superseded', status: 'superseded' } as never,
      depth: 0,
      overrideAccess: true,
      req,
      where: {
        and: [{ event: { equals: event.id } }, { status: { not_in: [...TERMINAL_STATUSES] } }],
      },
    })
    if (superseded.errors.length > 0) {
      throw new Error(`could not supersede deliveries: ${superseded.errors[0].message}`)
    }
  }
  const pending: DeliveryDoc[] = []
  for (const row of plan) {
    const delivery = (await payload.create({
      collection: collectionSlugs(payload).deliveries as never,
      data: {
        attempt: 0,
        destination: row.destination,
        event: event.id,
        key: `${event.id}:${row.destination}:r${event.revision}:s0`,
        lastDispatchedAt: row.status === 'pending' ? new Date().toISOString() : undefined,
        reason: row.reason,
        revision: event.revision,
        sequence: 0,
        status: row.status,
      } as never,
      depth: 0,
      overrideAccess: true,
      req,
    })) as unknown as DeliveryDoc
    if (delivery.status === 'pending') {
      pending.push(delivery)
    }
  }
  return pending
}

const findPurchase = (
  payload: Payload,
  req: PayloadRequest,
  transactionId: string,
): Promise<ConversionEventDoc | null> =>
  findEvent(payload, req, {
    and: [{ name: { equals: 'purchase' } }, { transactionId: { equals: transactionId } }],
  })

const alreadyRecorded = (
  log: Logger,
  draft: ConversionDraft,
  purchase: ConversionEventDoc,
): Outcome => {
  log.warn('purchase already recorded for transaction', { eventKey: draft.eventKey })
  return { event: purchase, pending: [] }
}

// Recordings of one order under different eventKeys all pass the purchase lookup before either
// commits. This unique key lets only one commit: a winner still open makes the insert wait and
// then conflict, and the outer retry replays. A committed key means a racing recording finished
// after the early lookup (READ COMMITTED reads each statement afresh), so its purchase is looked
// up again; a committed key with no purchase event is an orphan the host must remove.
const claimPurchase = async (
  payload: Payload,
  req: PayloadRequest,
  transactionId: string,
): Promise<ConversionEventDoc | null> => {
  const key = `${PURCHASE_CLAIM_PREFIX}${transactionId}`
  const collection = collectionSlugs(payload).claims
  if (await payload.db.findOne({ collection, req, where: { key: { equals: key } } })) {
    const purchase = await findPurchase(payload, req, transactionId)
    if (purchase) {
      return purchase
    }
    throw new PluginError(
      `${PLUGIN_SLUG}: purchase claim "${key}" exists in ${collection} but no purchase event was recorded for it; delete that claim row to record this order`,
      409,
    )
  }
  await payload.db.create({ collection, data: { key }, req })
  return null
}

const recordInTransaction = async (
  context: Context,
  draft: ConversionDraft,
  req: PayloadRequest,
  identityFor: () => Promise<IdentityResult>,
): Promise<Outcome> => {
  const { log, options, payload } = context
  const none: Outcome = { event: null, pending: [] }
  const snapshot = await findEvent(payload, req, { eventKey: { equals: draft.eventKey } })
  // Revisions of one eventKey wait here for each other, so an older revision recorded while a
  // newer one is still uncommitted replays the newer one instead of overwriting it.
  if (snapshot) {
    await lockRow(payload, collectionSlugs(payload).events, snapshot.id, req)
  }
  const found = snapshot ? await findEvent(payload, req, { id: { equals: snapshot.id } }) : null
  const existing = found ? guardExisting(found, draft, log) : undefined
  if (existing === 'replay') {
    return { event: found, pending: [] }
  }
  if (existing === 'identity_changed') {
    return none
  }

  const purchase = draft.transactionId
    ? await findPurchase(payload, req, draft.transactionId)
    : null
  if (draft.name === 'purchase' && purchase && purchase.eventKey !== draft.eventKey) {
    return alreadyRecorded(log, draft, purchase)
  }
  if (
    draft.name === 'refund' &&
    (!purchase || Date.parse(purchase.occurredAt) > Date.parse(draft.occurredAt))
  ) {
    log.warn('refund requires an earlier purchase', { eventKey: draft.eventKey })
    return none
  }

  const resolved = await identityFor()
  if (!resolved.ok) {
    return none
  }
  const { identity } = resolved

  const sanitized = sanitizeAttribution(draft.attribution)
  const attribution =
    draft.name === 'refund' && !sanitized?.gaClientId && purchase?.attribution?.gaClientId
      ? { ...sanitized, gaClientId: purchase.attribution.gaClientId }
      : sanitized
  const buyer = { ...identity, ...draft.buyer }
  const identifierOptions = { defaultCountry: options.identity.defaultPhoneCountry }
  const treatment = resolveAdsTreatment(draft, await findOriginal(payload, req, draft))
  const revision = draft.revision ?? 1
  const consent = resolveConsent(draft, attribution, identity)
  const plan = planDeliveries(
    {
      name: draft.name,
      consent,
      googleAdsAction: treatment.action,
      googleAdsKind: treatment.kind,
      revision,
    },
    options,
    draft.destinations,
  )
  const deliverySummary: DeliverySummary = Object.fromEntries(
    plan.map(({ destination, reason, status }) => [
      destination,
      reason ? { reason, status } : { status },
    ]),
  )

  const data: Record<string, unknown> = {
    name: draft.name,
    adjustedValueCents: draft.googleAds?.adjustedValueCents,
    attribution: attribution ?? {},
    channel: draft.channel,
    consent,
    context: draft.context ?? {},
    currency: draft.currency ?? DEFAULT_CURRENCY,
    deliverySummary,
    eventId: draft.eventId ?? draft.eventKey,
    eventKey: draft.eventKey,
    eventSource: draft.eventSource ?? 'OTHER',
    googleAdsAction: treatment.action,
    googleAdsKind: treatment.kind,
    identifiers: {
      google: googleIdentifiers(buyer, identifierOptions),
      meta: metaIdentifiers(buyer, identifierOptions),
    },
    items: draft.items,
    occurredAt: new Date(draft.occurredAt).toISOString(),
    params: draft.params,
    revision,
    shippingCents: draft.shippingCents,
    subject: draft.subject
      ? { id: String(draft.subject.id), collectionSlug: draft.subject.collectionSlug }
      : {},
    taxCents: draft.taxCents,
    transactionId: draft.transactionId,
    userId: identity?.userId,
    userProperties: userProperties(identity),
    valueCents: resolveValueCents(draft, treatment.kind, options.policy),
  }

  if (draft.name === 'purchase' && draft.transactionId && !found) {
    const recorded = await claimPurchase(payload, req, draft.transactionId)
    if (recorded) {
      // No claim was written, so returning here leaves nothing behind.
      return alreadyRecorded(log, draft, recorded)
    }
  }
  // Nothing between the purchase claim and the event write may return without throwing, or a
  // committed claim would be left with no purchase behind it.
  const event = (found
    ? await payload.update({
        id: found.id,
        collection: collectionSlugs(payload).events as never,
        data: replacement({ ...data, identifiersPurgedAt: null }, found) as never,
        depth: 0,
        overrideAccess: true,
        req,
      })
    : await payload.create({
        collection: collectionSlugs(payload).events as never,
        data: data as never,
        depth: 0,
        overrideAccess: true,
        req,
      })) as unknown as ConversionEventDoc

  return { event, pending: await writeDeliveries(payload, req, event, found, plan) }
}

export async function recordConversion(args: {
  draft: ConversionDraft
  payload: Payload
  req?: PayloadRequest
}): Promise<ConversionEventDoc | null> {
  const { payload } = args
  const { options } = getPluginContext(payload)
  const log = createLogger(payload)
  if (options.disabled) {
    log.debug('plugin disabled, conversion not recorded')
    return null
  }
  const validated = validateDraft(args.draft)
  if (!validated.ok) {
    log.warn(`invalid conversion draft (${validated.reason})`)
    return null
  }
  const draft = validated.draft
  const context: Context = { log, options, payload }

  const joined =
    args.req && (await args.req.transactionID) ? args.req : currentTransactionReq(payload)
  if (joined) {
    const outcome = await recordInTransaction(context, draft, joined, () =>
      resolveIdentity(context, draft, joined),
    )
    for (const delivery of outcome.pending) {
      await options.dispatcher.dispatch({ deliveryId: delivery.id, payload, req: joined })
    }
    return outcome.event
  }

  // Host callbacks run outside the plugin-owned transaction so they never hold the SQLite
  // serializer or a database transaction.
  const identity = await resolveIdentity(context, draft, args.req)
  if (!identity.ok) {
    return null
  }
  const attempt = () =>
    withTransaction(payload, args.req, (req) =>
      recordInTransaction(context, draft, req, () => Promise.resolve(identity)),
    )
  let outcome: Outcome
  try {
    outcome = await attempt()
  } catch (error) {
    const writeConflict = isMongoWriteConflict(error)
    if (!writeConflict && !isUniqueConflict(error, 'eventKey') && !isUniqueConflict(error, 'key')) {
      throw error
    }
    if (writeConflict) {
      const { max, min } = WRITE_CONFLICT_RETRY_DELAY_MS
      await delay(min + Math.random() * (max - min))
    }
    // A concurrent recording of this eventKey or of this order's purchase got there first (a
    // unique conflict, or a MongoDB WriteConflict on the event, its lock key or the purchase key);
    // the retry replays, revises or returns it.
    outcome = await attempt()
  }
  for (const delivery of outcome.pending) {
    try {
      await options.dispatcher.dispatch({ deliveryId: delivery.id, payload })
    } catch (error) {
      log.error('dispatch failed after commit, the sweep re-dispatches pending deliveries', {
        deliveryId: delivery.id,
        error,
      })
    }
  }
  return outcome.event
}
