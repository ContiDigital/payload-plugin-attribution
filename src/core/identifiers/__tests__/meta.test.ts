import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { BuyerIdentity } from '../normalize.js'

import { metaIdentifiers } from '../meta.js'

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

describe('metaIdentifiers', () => {
  const identity: BuyerIdentity = {
    name: 'Dr. Jane Q. Doe Jr.',
    country: 'us',
    email: 'Jane@Example.com',
    phone: '+1 555 123 4567',
    postalCode: '94103-1234',
    region: 'CA',
  }

  it('sends country only as a two-letter code', () => {
    expect(metaIdentifiers({ country: 'USA', email: 'jane@example.com' }).country).toBeUndefined()
    expect(metaIdentifiers({ country: 'United States' }).country).toBeUndefined()
    expect(metaIdentifiers({ country: ' US ' }).country).toBe(sha256('us'))
  })

  it('hashes em, ph, fn, ln, zp, country and st per Meta rules', () => {
    expect(metaIdentifiers(identity)).toEqual({
      country: sha256('us'),
      em: sha256('jane@example.com'),
      fn: sha256('jane'),
      ln: sha256('doe'),
      ph: sha256('15551234567'),
      st: sha256('ca'),
      zp: sha256('94103'),
    })
  })

  it('does not apply the gmail dot and plus-tag rule, unlike Google', () => {
    const gmailIdentity: BuyerIdentity = { email: ' John.Doe+ads@GoogleMail.com ' }

    // Meta's docs specify trim + lowercase only for em; the gmail-specific
    // dot/plus stripping is a Google Data Manager / GA4 rule, not Meta's.
    expect(metaIdentifiers(gmailIdentity)).toEqual({
      em: sha256('john.doe+ads@googlemail.com'),
    })
  })

  it('derives ph as digits only, with no leading plus', () => {
    expect(metaIdentifiers({ phone: '(555) 123-4567' }, { defaultCountry: 'US' })).toEqual({
      ph: sha256('15551234567'),
    })
  })

  it('omits st when region is not exactly two letters', () => {
    expect(metaIdentifiers({ region: 'California' })).toEqual({})
  })

  it('hashes ct after lowercasing and removing punctuation and spaces', () => {
    expect(metaIdentifiers({ city: 'San Francisco' })).toEqual({
      ct: sha256('sanfrancisco'),
    })
  })

  it('hashes an accented city name without transliterating', () => {
    expect(metaIdentifiers({ city: 'São Paulo' })).toEqual({
      ct: sha256('sãopaulo'),
    })
  })

  it('hashes accented name tokens without transliterating', () => {
    const accentedIdentity: BuyerIdentity = { name: 'José García-López' }

    expect(metaIdentifiers(accentedIdentity)).toEqual({
      fn: sha256('josé'),
      ln: sha256('garcíalópez'),
    })
  })

  it('hashes external_id only when externalId is provided', () => {
    expect(metaIdentifiers({ externalId: ' Cust-123 ' })).toEqual({
      external_id: sha256('cust-123'),
    })
  })

  it('omits fields for empty identities', () => {
    expect(metaIdentifiers({})).toEqual({})
  })
})
