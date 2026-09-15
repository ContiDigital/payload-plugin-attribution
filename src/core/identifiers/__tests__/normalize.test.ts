import { describe, expect, it } from 'vitest'

import { normalizeEmail, normalizePhoneE164, splitName } from '../normalize.js'

describe('normalizeEmail', () => {
  it.each([
    [' John.Doe+ads@GoogleMail.com ', 'johndoe@googlemail.com'],
    ['a.b+c@example.com', 'a.b+c@example.com'],
    ['nope', undefined],
    [' Jane.Q+promo@GMAIL.com ', 'janeq@gmail.com'],
    [42, undefined],
  ])('normalizes %p to %p', (value, expected) => {
    expect(normalizeEmail(value)).toBe(expected)
  })
})

describe('normalizePhoneE164', () => {
  it.each([
    ['(555) 123-4567', 'US', '+15551234567'],
    ['1-555-123-4567', 'US', '+15551234567'],
    ['+44 20 7946 0958', undefined, '+442079460958'],
    ['5551234567', undefined, undefined],
    ['123', 'US', undefined],
    ['(555) 123-4567', 'CA', '+15551234567'],
    ['15551234567', 'CA', '+15551234567'],
    ['5551234567', 'GB', undefined],
  ])('normalizes %p with default country %p to %p', (value, defaultCountry, expected) => {
    expect(normalizePhoneE164(value, defaultCountry)).toBe(expected)
  })
})

describe('splitName', () => {
  it('prefers explicit firstName and lastName over name', () => {
    expect(splitName({ name: 'Someone Else', firstName: 'Jane', lastName: 'Doe' })).toEqual({
      firstName: 'jane',
      lastName: 'doe',
    })
  })

  it.each([
    ['Dr. Jane Q. Doe Jr.', { firstName: 'jane', lastName: 'doe' }],
    ['Mary Ann Smith', { firstName: 'mary', lastName: 'smith' }],
    ['Cher', { firstName: 'cher' }],
    ['Mary-Jane Watson', { firstName: 'maryjane', lastName: 'watson' }],
    ['José García-López', { firstName: 'josé', lastName: 'garcíalópez' }],
    [undefined, {}],
  ])('splits name %p into %p', (name, expected) => {
    expect(splitName({ name })).toEqual(expected)
  })
})
