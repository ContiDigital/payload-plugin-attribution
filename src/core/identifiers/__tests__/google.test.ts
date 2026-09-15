import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { BuyerIdentity } from '../normalize.js'

import { googleIdentifiers } from '../google.js'

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

describe('googleIdentifiers', () => {
  it('hashes email, phone and name, and passes location fields through per Google rules', () => {
    const identity: BuyerIdentity = {
      name: 'Dr. Jane Q. Doe Jr.',
      country: 'us',
      email: 'Jane@Example.com',
      phone: '+1 555 123 4567',
      postalCode: '94103-1234',
      region: 'CA',
    }

    expect(googleIdentifiers(identity)).toEqual({
      country: 'US',
      emailSha256: sha256('jane@example.com'),
      firstNameSha256: sha256('jane'),
      lastNameSha256: sha256('doe'),
      phoneSha256: sha256('+15551234567'),
      postalCode: '94103-1234',
      region: 'CA',
    })
  })

  it('applies the gmail dot and plus-tag rule before hashing email', () => {
    const identity: BuyerIdentity = { email: ' John.Doe+ads@GoogleMail.com ' }

    expect(googleIdentifiers(identity)).toEqual({
      emailSha256: sha256('johndoe@googlemail.com'),
    })
  })

  it('hashes street after lowercasing, trimming and collapsing whitespace', () => {
    const identity: BuyerIdentity = { street: '  123  Main   St.  ' }

    expect(googleIdentifiers(identity)).toEqual({
      streetSha256: sha256('123 main st.'),
    })
  })

  it('hashes accented name tokens without transliterating', () => {
    const identity: BuyerIdentity = { name: 'José García-López' }

    expect(googleIdentifiers(identity)).toEqual({
      firstNameSha256: sha256('josé'),
      lastNameSha256: sha256('garcíalópez'),
    })
  })

  it('passes city through as plain text, unhashed', () => {
    expect(googleIdentifiers({ city: 'San Francisco' })).toEqual({ city: 'San Francisco' })
  })

  it('omits fields for empty identities', () => {
    expect(googleIdentifiers({})).toEqual({})
  })

  it('drops an invalid email and phone rather than hashing garbage', () => {
    expect(googleIdentifiers({ email: 'nope', phone: '123' })).toEqual({})
  })
})
