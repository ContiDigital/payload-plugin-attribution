import { describe, expect, it } from 'vitest'

import { SettingUnavailableError } from '../errors.js'
import { resolveSetting } from '../settings.js'

describe('resolveSetting', () => {
  it('returns a literal string as-is', async () => {
    await expect(resolveSetting('literal-value')).resolves.toBe('literal-value')
  })

  it('resolves a sync function', async () => {
    await expect(resolveSetting(() => 'from-sync-fn')).resolves.toBe('from-sync-fn')
  })

  it('resolves an async function', async () => {
    await expect(resolveSetting(() => Promise.resolve('from-async-fn'))).resolves.toBe(
      'from-async-fn',
    )
  })

  it('raises SettingUnavailableError, keeping the cause, when a function throws', async () => {
    const failure = new Error('boom')
    const rejection = resolveSetting(() => {
      throw failure
    })
    await expect(rejection).rejects.toBeInstanceOf(SettingUnavailableError)
    await expect(rejection).rejects.toMatchObject({ cause: failure })
  })

  it('raises SettingUnavailableError when an async function rejects', async () => {
    await expect(resolveSetting(() => Promise.reject(new Error('boom')))).rejects.toBeInstanceOf(
      SettingUnavailableError,
    )
  })

  it('returns an empty string when a function resolves to an empty value', async () => {
    await expect(resolveSetting(() => '')).resolves.toBe('')
  })

  it('returns an empty string for undefined', async () => {
    await expect(resolveSetting(undefined)).resolves.toBe('')
  })

  it('returns an empty string as-is', async () => {
    await expect(resolveSetting('')).resolves.toBe('')
  })
})
