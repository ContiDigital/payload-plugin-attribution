import { isIP } from 'node:net'

import { DEFAULT_IP_HEADER, MAX_USER_AGENT_LENGTH } from '../constants.js'
import { hasControlChar } from '../core/sanitize.js'

export function requestContextFromHeaders(
  headers: Headers,
  options: { ipHeader?: string; trustProxy?: boolean } = {},
): { ipAddress?: string; userAgent?: string } {
  const context: { ipAddress?: string; userAgent?: string } = {}
  const userAgent = headers.get('user-agent')
  if (userAgent && userAgent.length <= MAX_USER_AGENT_LENGTH && !hasControlChar(userAgent)) {
    context.userAgent = userAgent
  }
  // Clients can prepend any value; only the entry appended by the nearest trusted proxy is reliable.
  if (options.trustProxy) {
    const address = headers
      .get(options.ipHeader ?? DEFAULT_IP_HEADER)
      ?.split(',')
      .at(-1)
      ?.trim()
    if (address && isIP(address)) {
      context.ipAddress = address
    }
  }
  return context
}
