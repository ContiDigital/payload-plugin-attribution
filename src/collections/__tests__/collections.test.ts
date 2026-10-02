import type { CollectionConfig, Field, GroupField, PayloadRequest } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { AuthorizeScope } from '../../types/index.js'

import { attributionField } from '../../fields/attributionField.js'
import { normalizeOptions } from '../../plugin/normalizeOptions.js'
import { conversionDeliveries } from '../conversionDeliveries.js'
import { conversionEvents } from '../conversionEvents.js'
import { deliveryClaims } from '../deliveryClaims.js'

const admin = { id: 1, collection: 'users' }
const req = { user: admin } as unknown as PayloadRequest

const setup = () => {
  const authorize = vi.fn(
    ({ scope }: { req: PayloadRequest; scope: AuthorizeScope }) => scope !== 'pii',
  )
  const options = normalizeOptions({ authorize, secret: 'test-secret' })
  return { authorize, options }
}

const named = (fields: Field[], name: string): Field | undefined =>
  fields.find((field) => 'name' in field && field.name === name)

const names = (fields: Field[]): string[] =>
  fields.flatMap((field) => ('name' in field ? [field.name] : []))

const callAccess = async (
  collection: CollectionConfig,
  operation: 'create' | 'delete' | 'read' | 'update',
): Promise<unknown> => {
  const access = collection.access?.[operation]
  expect(access).toBeTypeOf('function')
  return access?.({ req } as never)
}

describe('conversion-events', () => {
  it('declares every ledger field', () => {
    const { options } = setup()
    expect(names(conversionEvents(options).fields)).toEqual([
      'eventKey',
      'eventId',
      'name',
      'occurredAt',
      'revision',
      'transactionId',
      'valueCents',
      'taxCents',
      'shippingCents',
      'currency',
      'channel',
      'eventSource',
      'userId',
      'params',
      'items',
      'userProperties',
      'subject',
      'attribution',
      'consent',
      'identifiers',
      'context',
      'identifiersPurgedAt',
      'googleAdsAction',
      'googleAdsKind',
      'adjustedValueCents',
      'deliverySummary',
      'deliveriesPanel',
      'deliveries',
    ])
  })

  it('shows delivery status in the list and the deliveries panel in the edit view', () => {
    const { options } = setup()
    const fields = conversionEvents({ ...options, apiBasePath: '/ops' }).fields
    const summary = fields.find((field) => 'name' in field && field.name === 'deliverySummary')
    expect(summary?.admin?.components).toEqual({
      Cell: 'payload-plugin-attribution/client#DeliveryStatusCell',
    })
    const panel = fields.find((field) => 'name' in field && field.name === 'deliveriesPanel')
    expect(panel).toEqual({
      name: 'deliveriesPanel',
      type: 'ui',
      admin: {
        components: {
          Field: {
            clientProps: { apiBasePath: '/ops', deliveriesSlug: 'conversion-deliveries' },
            path: 'payload-plugin-attribution/client#DeliveriesPanel',
          },
        },
      },
    })
  })

  it('makes eventKey unique and required', () => {
    const { options } = setup()
    expect(named(conversionEvents(options).fields, 'eventKey')).toMatchObject({
      index: true,
      required: true,
      unique: true,
    })
  })

  it('denies writes to a logged-in admin and delegates read to authorize', async () => {
    const { authorize, options } = setup()
    const collection = conversionEvents(options)
    expect(await callAccess(collection, 'create')).toBe(false)
    expect(await callAccess(collection, 'update')).toBe(false)
    expect(await callAccess(collection, 'delete')).toBe(false)
    expect(await callAccess(collection, 'read')).toBe(true)
    expect(authorize).toHaveBeenCalledWith({ req, scope: 'read' })
  })

  it('denies collection and field reads when authorize throws, as the docs promise', async () => {
    const authorize = vi.fn(() => {
      throw new Error('session store down')
    })
    const options = normalizeOptions({ authorize, secret: 'test-secret' })
    const collection = conversionEvents(options)
    expect(await callAccess(collection, 'read')).toBe(false)
    expect(await callAccess(conversionDeliveries(options), 'read')).toBe(false)
    const context = named(collection.fields, 'context') as GroupField
    expect(await context.access?.read?.({ req } as never)).toBe(false)
    const rejecting = normalizeOptions({
      authorize: () => Promise.reject(new Error('down')),
      secret: 'test-secret',
    })
    expect(await callAccess(conversionEvents(rejecting), 'read')).toBe(false)
  })

  it('names no stored field after a Mongoose reserved path such as collection', () => {
    const { options } = setup()
    const reserved = new Set(['collection', 'db', 'errors', 'init', 'isNew', 'schema'])
    const walk = (fields: Field[], prefix: string): string[] =>
      fields.flatMap((field) => {
        const name = 'name' in field ? `${prefix}${field.name}` : prefix
        const own = 'name' in field && reserved.has(field.name) ? [name] : []
        const nested = 'fields' in field ? walk(field.fields, `${name}.`) : []
        return [...own, ...nested]
      })
    for (const collection of [
      conversionEvents(options),
      conversionDeliveries(options),
      deliveryClaims(options),
    ]) {
      expect(walk(collection.fields, ''), collection.slug).toEqual([])
    }
    expect(
      names((named(conversionEvents(options).fields, 'subject') as GroupField).fields),
    ).toEqual(['collectionSlug', 'recordId'])
  })

  it.each(['identifiers', 'context'])('gates %s reads on the pii scope', async (name) => {
    const { authorize, options } = setup()
    const field = named(conversionEvents(options).fields, name) as GroupField
    expect(await field.access?.read?.({ req } as never)).toBe(false)
    expect(authorize).toHaveBeenCalledWith({ req, scope: 'pii' })
  })

  it('joins deliveries on their event', () => {
    const { options } = setup()
    expect(named(conversionEvents(options).fields, 'deliveries')).toMatchObject({
      type: 'join',
      collection: 'conversion-deliveries',
      on: 'event',
    })
  })

  it('uses the admin group and title', () => {
    const { options } = setup()
    expect(conversionEvents(options).admin).toMatchObject({
      defaultColumns: ['name', 'occurredAt', 'transactionId', 'valueCents', 'deliverySummary'],
      group: 'Marketing',
      useAsTitle: 'eventKey',
    })
  })
})

describe('conversion-deliveries', () => {
  it('declares every delivery field', () => {
    const { options } = setup()
    expect(names(conversionDeliveries(options).fields)).toEqual([
      'event',
      'destination',
      'revision',
      'sequence',
      'key',
      'status',
      'reason',
      'attempt',
      'nextAttemptAt',
      'leaseExpiresAt',
      'lastDispatchedAt',
      'deadlineAt',
      'sentAt',
      'firstServedAt',
      'lastServedAt',
      'request',
      'response',
    ])
  })

  it('makes key unique and indexes status with nextAttemptAt', () => {
    const { options } = setup()
    const collection = conversionDeliveries(options)
    expect(named(collection.fields, 'key')).toMatchObject({ required: true, unique: true })
    expect(collection.indexes).toContainEqual({ fields: ['status', 'nextAttemptAt'] })
    expect(collection.indexes).toContainEqual({ fields: ['status', 'updatedAt'] })
  })

  it('denies writes to a logged-in admin', async () => {
    const { authorize, options } = setup()
    const collection = conversionDeliveries(options)
    expect(await callAccess(collection, 'create')).toBe(false)
    expect(await callAccess(collection, 'update')).toBe(false)
    expect(await callAccess(collection, 'delete')).toBe(false)
    expect(await callAccess(collection, 'read')).toBe(true)
    expect(authorize).toHaveBeenCalledWith({ req, scope: 'read' })
  })

  it('gates request reads on the pii scope', async () => {
    const { authorize, options } = setup()
    const field = named(conversionDeliveries(options).fields, 'request')
    expect(field && 'access' in field ? await field.access?.read?.({ req } as never) : null).toBe(
      false,
    )
    expect(authorize).toHaveBeenCalledWith({ req, scope: 'pii' })
  })
})

describe('conversion-delivery-claims', () => {
  it('is hidden with every operation denied', async () => {
    const collection = deliveryClaims(normalizeOptions({ secret: 'test-secret' }))
    expect(collection.admin?.hidden).toBe(true)
    expect(names(collection.fields)).toEqual(['key', 'delivery', 'token', 'claimedAt'])
    expect(named(collection.fields, 'key')).toMatchObject({ required: true, unique: true })
    for (const operation of ['create', 'read', 'update', 'delete'] as const) {
      expect(await callAccess(collection, operation)).toBe(false)
    }
  })
})

describe('schema-only collections', () => {
  it('hides the ledger, denies every operation and registers no hooks', async () => {
    const { authorize, options } = setup()
    for (const collection of [
      conversionEvents(options, { schemaOnly: true }),
      conversionDeliveries(options, { schemaOnly: true }),
    ]) {
      expect(collection.admin?.hidden).toBe(true)
      expect(collection.hooks).toBeUndefined()
      for (const operation of ['create', 'read', 'update', 'delete'] as const) {
        expect(await callAccess(collection, operation)).toBe(false)
      }
    }
    expect(authorize).not.toHaveBeenCalled()
  })
})

describe('attributionField', () => {
  it('sanitizes the group value before validation', async () => {
    const field = attributionField()
    const hook = field.hooks?.beforeValidate?.[0]
    expect(hook).toBeTypeOf('function')
    const gclid = 'G'.repeat(20)
    expect(await hook?.({ value: { gclid, utmSource: 'a@b.co' } } as never)).toEqual({ gclid })
    expect(await hook?.({ value: 'not an object' } as never)).toEqual({})
  })

  it('keeps explicit null leaves so a replacement clears them', async () => {
    const hook = attributionField().hooks?.beforeValidate?.[0]
    const gclid = 'G'.repeat(20)
    expect(
      await hook?.({
        value: { fbclid: null, gclid, notAField: null, utmSource: 'a@b.co' },
      } as never),
    ).toEqual({ fbclid: null, gclid })
  })

  it('is read-only in admin and accepts a custom name', () => {
    const field = attributionField('firstTouch')
    expect(field.name).toBe('firstTouch')
    expect(field.admin?.readOnly).toBe(true)
  })

  it('stores every sanitized attribution key', () => {
    expect(names(attributionField().fields).sort()).toEqual(
      [
        'capturedAt',
        'clickCapturedAt',
        'consentAdPersonalization',
        'consentAdUserData',
        'consentAnalyticsStorage',
        'dclid',
        'fbc',
        'fbclid',
        'fbp',
        'firstSeenAt',
        'gaClientId',
        'gadCampaignId',
        'gadSource',
        'gaSessionId',
        'gaSessionNumber',
        'gaSessionStartedAt',
        'gbraid',
        'gclid',
        'landingPath',
        'liFatId',
        'msclkid',
        'referrerHost',
        'source',
        'srsltid',
        'ttclid',
        'twclid',
        'utmCampaign',
        'utmContent',
        'utmCreativeFormat',
        'utmId',
        'utmMarketingTactic',
        'utmMedium',
        'utmSource',
        'utmSourcePlatform',
        'utmTerm',
        'wbraid',
      ].sort(),
    )
  })
})
