import type { Config, Payload } from 'payload'

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DeliveryDoc } from '../types/index.js'

import { CLAIMS_SLUG, DELIVERIES_SLUG, EVENTS_SLUG, LEASE_MS } from '../constants.js'
import { claimDelivery } from '../server/deliveries/claimDelivery.js'
import { isUniqueConflict } from '../server/utilities/errors.js'
import { withTransaction } from '../server/utilities/transaction.js'
import {
  bootPayload,
  databaseName,
  destroyPayloads,
  isSqlite,
  mongodbUrl,
} from './helpers/bootPayload.js'

let payload: Payload

const makeDelivery = async (eventKey: string, target = payload): Promise<DeliveryDoc> => {
  const event = (await target.create({
    collection: EVENTS_SLUG as never,
    data: { name: 'generate_lead', eventKey, occurredAt: new Date().toISOString() } as never,
    overrideAccess: true,
  })) as unknown as { id: number | string }
  return (await target.create({
    collection: DELIVERIES_SLUG as never,
    data: {
      destination: 'ga4',
      event: event.id,
      key: `${event.id}:ga4:r1:s0`,
      revision: 1,
      status: 'pending',
    } as never,
    depth: 0,
    overrideAccess: true,
  })) as unknown as DeliveryDoc
}

// The translations package is a dependency of payload, not of this package.
const germanLanguage = async (): Promise<unknown> => {
  const payloadPackage = realpathSync(
    fileURLToPath(new URL('../../node_modules/payload/package.json', import.meta.url)),
  )
  const path = createRequire(payloadPackage).resolve('@payloadcms/translations/languages/de')
  return ((await import(path)) as { de: unknown }).de
}

const countClaims = async (key: string): Promise<number> =>
  (
    await payload.count({
      collection: CLAIMS_SLUG as never,
      overrideAccess: true,
      where: { key: { equals: key } },
    })
  ).totalDocs

beforeAll(async () => {
  payload = await bootPayload({ label: 'claims', options: { secret: 'claims-test-secret' } })
})

afterAll(destroyPayloads)

describe(`claimDelivery on ${databaseName}`, () => {
  it(
    !isSqlite
      ? `lets exactly one of 20 concurrent claims win (a true race on ${databaseName})`
      : 'lets exactly one of 20 claims win (run sequentially under the SQLite serializer, a true race only on Postgres and MongoDB)',
    async () => {
      const delivery = await makeDelivery('claim-race')
      const now = new Date('2026-09-14T12:00:00.000Z')
      // Every loser returns null on every adapter, including MongoDB write conflicts.
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          claimDelivery(payload, delivery, now, { clock: () => now }),
        ),
      )
      const winners = results.filter((result): result is DeliveryDoc => result !== null)
      expect(winners).toHaveLength(1)
      expect(winners[0]).toMatchObject({ id: delivery.id, attempt: 1, status: 'sending' })
      expect(Date.parse(winners[0].leaseExpiresAt ?? '')).toBe(now.getTime() + LEASE_MS)
      expect(await countClaims(`${delivery.id}:1`)).toBe(1)

      const stored = (await payload.findByID({
        id: delivery.id,
        collection: DELIVERIES_SLUG as never,
        depth: 0,
        overrideAccess: true,
      })) as unknown as DeliveryDoc
      expect(stored).toMatchObject({ attempt: 1, status: 'sending' })

      const later = await makeDelivery('after-claim-race')
      const persisted = await payload.findByID({
        id: later.id,
        collection: DELIVERIES_SLUG as never,
        depth: 0,
        disableErrors: true,
        overrideAccess: true,
      })
      expect(persisted).not.toBeNull()
    },
  )

  it('refuses a stale snapshot and a live lease, then admits the next attempt', async () => {
    const delivery = await makeDelivery('claim-sequence')
    const now = new Date()
    const first = await claimDelivery(payload, delivery, now, { clock: () => now })
    expect(first?.attempt).toBe(1)
    expect(await claimDelivery(payload, delivery, now)).toBeNull()
    expect(await claimDelivery(payload, first as DeliveryDoc, now)).toBeNull()
    const leaseExpired = new Date(now.getTime() + LEASE_MS)
    const second = await claimDelivery(payload, first as DeliveryDoc, leaseExpired)
    expect(second).toMatchObject({ attempt: 2, status: 'sending' })
  })

  it('computes the lease from a clock read at claim time', async () => {
    const past = new Date(Date.now() - 10 * 60_000)
    const before = Date.now()
    const claimed = await claimDelivery(payload, await makeDelivery('claim-clock'), past)
    expect(Date.parse(claimed?.leaseExpiresAt ?? '')).toBeGreaterThanOrEqual(before + LEASE_MS)
    const fixed = new Date('2026-09-14T12:00:00.000Z')
    const injected = await claimDelivery(payload, await makeDelivery('claim-clock-fixed'), past, {
      clock: () => fixed,
    })
    expect(Date.parse(injected?.leaseExpiresAt ?? '')).toBe(fixed.getTime() + LEASE_MS)
  })

  it('surfaces a duplicate claim key as a unique conflict', async () => {
    const data = { claimedAt: new Date().toISOString(), delivery: 'x', key: 'duplicate-key' }
    await payload.create({ collection: CLAIMS_SLUG as never, data: data as never })
    const error: unknown = await payload
      .create({ collection: CLAIMS_SLUG as never, data: data as never })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(isUniqueConflict(error)).toBe(true)
    expect(error).toMatchObject({ data: { errors: [{ path: 'key' }] }, status: 400 })
  })

  it(
    !isSqlite
      ? 'commits a claim made inside a plugin-owned transaction independently'
      : 'refuses an independent claim inside a plugin-owned SQLite transaction without deadlocking',
    { timeout: 5000 },
    async () => {
      const delivery = await makeDelivery('claim-fresh')
      const stored = async () =>
        (await payload.findByID({
          id: delivery.id,
          collection: DELIVERIES_SLUG as never,
          depth: 0,
          overrideAccess: true,
        })) as unknown as DeliveryDoc
      if (isSqlite) {
        await expect(
          withTransaction(payload, undefined, () => claimDelivery(payload, delivery, new Date())),
        ).rejects.toThrow(/independent transaction/)
        expect(await stored()).toMatchObject({ attempt: 0, status: 'pending' })
        expect(await claimDelivery(payload, delivery, new Date())).toMatchObject({ attempt: 1 })
        return
      }
      const failure = new Error('outer transaction rolls back')
      await expect(
        withTransaction(payload, undefined, async (req) => {
          await payload.create({
            collection: EVENTS_SLUG as never,
            data: {
              name: 'generate_lead',
              eventKey: 'claim-fresh-outer',
              occurredAt: new Date().toISOString(),
            } as never,
            overrideAccess: true,
            req,
          })
          expect(await claimDelivery(payload, delivery, new Date())).toMatchObject({ attempt: 1 })
          throw failure
        }),
      ).rejects.toBe(failure)
      expect(await stored()).toMatchObject({ attempt: 1, status: 'sending' })
      expect(await countClaims(`${delivery.id}:1`)).toBe(1)
      const { totalDocs } = await payload.count({
        collection: EVENTS_SLUG as never,
        overrideAccess: true,
        where: { eventKey: { equals: 'claim-fresh-outer' } },
      })
      expect(totalDocs).toBe(0)
    },
  )

  it('detects unique conflicts under a non-English fallback language', async () => {
    const german = await bootPayload({
      config: {
        i18n: {
          fallbackLanguage: 'de',
          supportedLanguages: { de: (await germanLanguage()) as never },
        } as Config['i18n'],
      },
      label: 'claims_de',
      options: { secret: 'claims-test-secret' },
    })
    const data = { claimedAt: new Date().toISOString(), delivery: 'x', key: 'german-duplicate' }
    await german.create({ collection: CLAIMS_SLUG as never, data: data as never })
    const error: unknown = await german
      .create({ collection: CLAIMS_SLUG as never, data: data as never })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(error).toMatchObject({
      data: { errors: [{ message: 'Wert muss einzigartig sein', path: 'key' }] },
    })
    // Documented MongoDB limitation: its unique errors carry no table name, so only the
    // English default message identifies them and a translated one does not.
    expect(isUniqueConflict(error)).toBe(!mongodbUrl)

    const delivery = await makeDelivery('claim-german', german)
    const now = new Date()
    expect(await claimDelivery(german, delivery, now)).toMatchObject({ attempt: 1 })
    expect(await claimDelivery(german, delivery, now)).toBeNull()
  })
})
