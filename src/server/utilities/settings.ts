import type { Setting } from '../../types/index.js'

import { SettingUnavailableError } from './errors.js'

/**
 * A Setting may be a literal string or a sync/async function. An empty value means the setting
 * is not configured; a function that throws raises SettingUnavailableError, which delivery treats
 * as a retryable infrastructure failure.
 */
export const resolveSetting = async (setting: Setting | undefined): Promise<string> => {
  if (typeof setting !== 'function') {
    return typeof setting === 'string' ? setting : ''
  }
  let value: unknown
  try {
    value = await setting()
  } catch (error) {
    throw new SettingUnavailableError({ cause: error })
  }
  return typeof value === 'string' ? value : ''
}
