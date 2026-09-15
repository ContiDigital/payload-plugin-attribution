import { createHash, timingSafeEqual } from 'node:crypto'

import type { NormalizedGoogleAdsOptions } from '../../types/index.js'

import { MAX_BASIC_AUTH_HEADER_LENGTH } from '../../constants.js'
import { resolveSetting } from '../utilities/settings.js'

const BASIC_HEADER = /^Basic [A-Z0-9+/]+=*$/i

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

// Digests have a fixed length, so timingSafeEqual compares without revealing the credential length.
export function feedAuthorized(header: null | string, username: string, password: string): boolean {
  let supplied = ''
  if (header && header.length <= MAX_BASIC_AUTH_HEADER_LENGTH && BASIC_HEADER.test(header)) {
    supplied = Buffer.from(header.slice(6), 'base64').toString('utf8')
  }
  const matches = timingSafeEqual(digest(supplied), digest(`${username}:${password}`))
  return matches && Boolean(username && password)
}

export const feedCredentials = async (
  googleAds: NormalizedGoogleAdsOptions | undefined,
): Promise<{ password: string; username: string }> => {
  const [username, password] = await Promise.all([
    resolveSetting(googleAds?.feed?.username),
    resolveSetting(googleAds?.feed?.password),
  ])
  return { password, username }
}
