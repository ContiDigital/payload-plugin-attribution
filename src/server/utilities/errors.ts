export class PluginError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = new.target.name
    this.status = status
  }
}

export class ValidationError extends PluginError {
  constructor(message: string) {
    super(message, 400)
  }
}

export class ForbiddenError extends PluginError {
  constructor(message: string) {
    super(message, 403)
  }
}

export class NotFoundError extends PluginError {
  constructor(message: string) {
    super(message, 404)
  }
}

export class ConflictError extends PluginError {
  constructor(message: string) {
    super(message, 409)
  }
}

/** Wraps a fetch-level failure (DNS, TLS, connection reset) so destination handlers can tell it apart from an HTTP error response. */
export class HttpNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** A function Setting threw or rejected, for example during a secret manager outage. */
export class SettingUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('a function setting could not be resolved', options)
    this.name = new.target.name
  }
}

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')

const MAX_CAUSE_DEPTH = 5

const causeChain = (error: unknown): Record<string, unknown>[] => {
  const chain: Record<string, unknown>[] = []
  let current = error
  while (
    typeof current === 'object' &&
    current !== null &&
    chain.length < MAX_CAUSE_DEPTH &&
    !chain.includes(current as Record<string, unknown>)
  ) {
    const entry = current as Record<string, unknown>
    chain.push(entry)
    current = entry.cause
  }
  return chain
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : ''

// Drizzle turns sqlite and postgres unique violations into a Payload ValidationError on the
// field path, translating the message with req.t but always tagging the item with its table
// name, which field validation errors never carry. Mongo tags nothing, so its untranslated
// default message is the fallback. Raw driver shapes carry no field and match any field.
const payloadUniqueOn = (entry: Record<string, unknown>, field: string): boolean => {
  const data = entry.data as { errors?: unknown } | undefined
  return (
    entry.name === 'ValidationError' &&
    entry.status === 400 &&
    Array.isArray(data?.errors) &&
    data.errors.some((item: unknown) => {
      const detail = item as { message?: unknown; path?: unknown; tableName?: unknown } | null
      return (
        detail?.path === field &&
        (typeof detail.tableName === 'string' || /unique/i.test(text(detail.message)))
      )
    })
  )
}

export const isUniqueConflict = (error: unknown, field = 'key'): boolean =>
  causeChain(error).some((entry) => {
    const code = text(entry.code)
    const message = text(entry.message)
    return (
      payloadUniqueOn(entry, field) ||
      code === '23505' ||
      code === '11000' ||
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      /UNIQUE constraint failed|E11000/.test(message)
    )
  })

// MongoDB aborts a transaction that writes a document another open transaction already wrote
// (such as a lock key) with WriteConflict, code 112. Only that code means contention: the
// TransientTransactionError label alone also marks network errors, stepdowns and
// NoSuchTransaction, which are infrastructure failures and must propagate.
export const isMongoWriteConflict = (error: unknown): boolean =>
  causeChain(error).some((entry) => text(entry.code) === '112')

// Mongoose rejects an id that is not a valid ObjectId with a CastError before querying.
export const isMalformedIdError = (error: unknown): boolean =>
  causeChain(error).some((entry) => entry.name === 'CastError')

export const isBusyError = (error: unknown): boolean =>
  causeChain(error).some(
    (entry) =>
      text(entry.code) === 'SQLITE_BUSY' ||
      /SQLITE_BUSY|database is locked/i.test(text(entry.message)),
  )
