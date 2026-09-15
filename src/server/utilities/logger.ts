import type { Payload } from 'payload'

import { PLUGIN_SLUG } from '../../constants.js'

const SECRET_KEY = /secret|token|password|authorization|api_?key|private_?key|access_?token|cookie/i
const SECRET_VALUE = /\bEAA[A-Z0-9]{10,}|\bya29\.|-----BEGIN/i
const REDACTED = '[redacted]'
// Credentials embedded in a longer string (a request URL or an error message) lose only their
// value, so the rest of the text stays useful. The minimum lengths keep prose such as
// "Basic plan" intact.
const SECRET_QUERY_PARAMETER = /\b(api_secret|access_token)=[^\s&#"']+/gi
const AUTHORIZATION_CREDENTIALS = /\b(Basic|Bearer)\s+[\w+./~-]{8,}=*/gi

const redactString = (value: string): string =>
  SECRET_VALUE.test(value)
    ? REDACTED
    : value
        .replace(SECRET_QUERY_PARAMETER, `$1=${REDACTED}`)
        .replace(AUTHORIZATION_CREDENTIALS, `$1 ${REDACTED}`)

const redactValue = (value: unknown, ancestors: WeakSet<object>): unknown => {
  if (typeof value === 'string') {
    return redactString(value)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (ancestors.has(value)) {
    return '[circular]'
  }
  ancestors.add(value)
  try {
    if (value instanceof Error) {
      const { code, data } = value as { code?: unknown; data?: unknown } & Error
      return redactValue(
        {
          name: value.name,
          message: value.message,
          stack: value.stack,
          ...(code === undefined ? {} : { code }),
          ...(data === undefined ? {} : { data }),
          ...(value.cause === undefined ? {} : { cause: value.cause }),
        },
        ancestors,
      )
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => redactValue(item, ancestors))
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? REDACTED : redactValue(item, ancestors),
      ]),
    )
  } finally {
    ancestors.delete(value)
  }
}

export const redact = (value: unknown): unknown => redactValue(value, new WeakSet())

type LogMethod = (message: string, data?: unknown) => void

export type Logger = { debug: LogMethod; error: LogMethod; info: LogMethod; warn: LogMethod }

export function createLogger(payload: Pick<Payload, 'logger'>): Logger {
  const method =
    (level: keyof Logger): LogMethod =>
    (message, data) => {
      const msg = `${PLUGIN_SLUG}: ${message}`
      payload.logger[level](data === undefined ? { msg } : { data: redact(data), msg })
    }
  return {
    debug: method('debug'),
    error: method('error'),
    info: method('info'),
    warn: method('warn'),
  }
}
