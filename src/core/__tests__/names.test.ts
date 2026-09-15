import { describe, expect, it } from 'vitest'

import { RESERVED_EVENT_NAMES, validEventName, validName } from '../names.js'

describe('validEventName', () => {
  it.each([...RESERVED_EVENT_NAMES])('rejects the reserved event name %s', (name) => {
    expect(validEventName(name)).toBe(false)
  })

  it('accepts a non-reserved event name', () => {
    expect(validEventName('generate_lead')).toBe(true)
  })

  it('rejects a name over the 40 character default limit', () => {
    expect(validEventName('a'.repeat(41))).toBe(false)
  })

  it('rejects a name that starts with a digit', () => {
    expect(validEventName('1abc')).toBe(false)
  })
})

describe('validName', () => {
  it('rejects names reserved by Firebase, GA, Google Ads and gtag.js prefixes', () => {
    expect(validName('firebase_x')).toBe(false)
    expect(validName('ga_x')).toBe(false)
    expect(validName('google_x')).toBe(false)
    expect(validName('gtag.x')).toBe(false)
  })

  it('honors a caller-supplied max length', () => {
    expect(validName('a'.repeat(24), 24)).toBe(true)
    expect(validName('a'.repeat(25), 24)).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(validName(42)).toBe(false)
    expect(validName(undefined)).toBe(false)
  })
})
