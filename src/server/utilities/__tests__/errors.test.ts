import { ValidationError as PayloadValidationError } from 'payload'
import { describe, expect, it } from 'vitest'

import {
  ConflictError,
  ForbiddenError,
  isBusyError,
  isMalformedIdError,
  isMongoWriteConflict,
  isUniqueConflict,
  NotFoundError,
  PluginError,
  ValidationError,
} from '../errors.js'

describe('plugin errors', () => {
  it.each([
    [new ValidationError('bad'), 400, 'ValidationError'],
    [new ForbiddenError('no'), 403, 'ForbiddenError'],
    [new NotFoundError('gone'), 404, 'NotFoundError'],
    [new ConflictError('already_sent'), 409, 'ConflictError'],
    [new PluginError('boom', 500), 500, 'PluginError'],
  ])('%s carries status %i', (error, status, name) => {
    expect(error).toBeInstanceOf(PluginError)
    expect(error).toBeInstanceOf(Error)
    expect(error.status).toBe(status)
    expect(error.name).toBe(name)
  })
})

describe('isUniqueConflict', () => {
  const payloadUnique = (path: string, message = 'Value must be unique') =>
    new PayloadValidationError({
      collection: 'conversion-delivery-claims',
      errors: [{ message, path }],
    })

  it('matches a translated database unique violation by its table marker', () => {
    const translated = new PayloadValidationError({
      collection: 'conversion-delivery-claims',
      errors: [
        {
          message: 'Wert muss einzigartig sein',
          path: 'key',
          tableName: 'conversion_delivery_claims',
        } as never,
      ],
    })
    expect(isUniqueConflict(translated)).toBe(true)
    expect(isUniqueConflict(translated, 'eventKey')).toBe(false)
    const fieldValidation = new PayloadValidationError({
      collection: 'conversion-delivery-claims',
      errors: [{ label: 'Key', message: 'Dieses Feld ist erforderlich.', path: 'key' }],
    })
    expect(isUniqueConflict(fieldValidation)).toBe(false)
  })

  it('matches the requested field path', () => {
    expect(isUniqueConflict(payloadUnique('eventKey'), 'eventKey')).toBe(true)
    expect(isUniqueConflict(payloadUnique('key'), 'eventKey')).toBe(false)
  })

  it.each<[string, unknown, boolean]>([
    ['Payload ValidationError on key', payloadUnique('key'), true],
    ['Payload ValidationError on another field', payloadUnique('delivery'), false],
    [
      'Payload ValidationError on key that is not a unique violation',
      payloadUnique('key', 'This field is required.'),
      false,
    ],
    ['postgres code', Object.assign(new Error('duplicate key value'), { code: '23505' }), true],
    ['postgres code in cause', new Error('insert failed', { cause: { code: '23505' } }), true],
    ['sqlite message', new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: t.key'), true],
    ['sqlite code', { code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'x' }, true],
    ['sqlite not null', { code: 'SQLITE_CONSTRAINT_NOTNULL', message: 'NOT NULL failed' }, false],
    ['mongo code', { code: 11000, message: 'dup' }, true],
    ['mongo message', new Error('E11000 duplicate key error collection'), true],
    ['busy', new Error('SQLITE_BUSY: database is locked'), false],
    ['generic', new Error('boom'), false],
    ['null', null, false],
    ['string', 'UNIQUE constraint failed', false],
  ])('%s', (_label, error, expected) => {
    expect(isUniqueConflict(error)).toBe(expected)
  })

  it('stops following a cyclic cause chain', () => {
    const error = new Error('outer') as { cause?: unknown } & Error
    error.cause = error
    expect(isUniqueConflict(error)).toBe(false)
  })
})

describe('isBusyError', () => {
  it.each<[string, unknown, boolean]>([
    ['code', { code: 'SQLITE_BUSY', message: 'x' }, true],
    ['message', new Error('database is locked'), true],
    [
      'wrapped begin failure',
      new Error('Error: cannot begin transaction: SQLITE_BUSY: database is locked'),
      true,
    ],
    ['cause', new Error('outer', { cause: new Error('SQLITE_BUSY') }), true],
    ['unique', new Error('UNIQUE constraint failed: t.key'), false],
    ['undefined', undefined, false],
  ])('%s', (_label, error, expected) => {
    expect(isBusyError(error)).toBe(expected)
  })
})

describe('isMongoWriteConflict', () => {
  it.each([
    [{ code: 112 }, true],
    [{ code: '112' }, true],
    [
      new Error('wrapped', { cause: { code: 112, errorLabels: ['TransientTransactionError'] } }),
      true,
    ],
    [{ errorLabels: ['TransientTransactionError'] }, false],
    [{ code: 251, errorLabels: ['TransientTransactionError'] }, false],
    [{ code: 11000 }, false],
    [{ codeName: 'WriteConflict' }, false],
    [new Error('Please retry your operation or multi-document transaction.'), false],
    [null, false],
  ])('classifies %o as a write conflict: %s', (error, expected) => {
    expect(isMongoWriteConflict(error)).toBe(expected)
  })
})

describe('isMalformedIdError', () => {
  it('matches a Mongoose CastError anywhere in the cause chain', () => {
    const cast = Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError' })
    expect(isMalformedIdError(cast)).toBe(true)
    expect(isMalformedIdError(new Error('outer', { cause: cast }))).toBe(true)
    expect(isMalformedIdError(new Error('Cast to ObjectId failed'))).toBe(false)
    expect(isMalformedIdError('CastError')).toBe(false)
  })
})
