import type { Payload } from 'payload'

import { GoogleAuth } from 'google-auth-library'

import type { Ga4KeyEventCountingMethod, PropertyPlan } from '../../types/index.js'

import {
  DEFAULT_GA4_KEY_EVENT_COUNTING_METHOD,
  GA4_DIMENSION_LIMITS,
  GA4_DIMENSION_NAME_MAX,
  GA4_KEY_EVENT_COUNTING_METHODS,
  GA4_KEY_EVENT_LIMIT,
  GA4_USER_DIMENSION_NAME_MAX,
} from '../../constants.js'
import { validEventName, validName } from '../../core/names.js'
import { getPluginContext } from '../../plugin/getPluginContext.js'
import { resolveSetting } from '../utilities/settings.js'

type AdminRow = Record<string, unknown>
type AdminTransport = (path: string, body?: AdminRow) => Promise<AdminRow>

type MissingDimension = {
  displayName: string
  parameterName: string
  scope: 'EVENT' | 'ITEM' | 'USER'
}
type MissingKeyEvent = { countingMethod: Ga4KeyEventCountingMethod; eventName: string }

type SetupResult = {
  apply: boolean
  manualSteps: string[]
  missingDimensions: MissingDimension[]
  missingKeyEvents: MissingKeyEvent[]
}

const MANUAL_STEPS: readonly string[] = Object.freeze([
  'Review data retention available for your property tier.',
  'Select Observed reporting identity.',
  'Enable BigQuery daily export.',
  'Link Ads and import key events with deliberate primary/secondary settings.',
  'Review consent settings.',
])

// The Admin API paginates with pageToken; a token repeating itself would loop forever.
async function listAll(
  transport: AdminTransport,
  path: string,
  field: string,
): Promise<AdminRow[]> {
  const rows: AdminRow[] = []
  let token = ''
  const seen = new Set<string>()
  do {
    const query = token ? `?pageSize=200&pageToken=${encodeURIComponent(token)}` : '?pageSize=200'
    const response = await transport(`${path}${query}`)
    rows.push(...((response[field] as AdminRow[] | undefined) ?? []))
    token = typeof response.nextPageToken === 'string' ? response.nextPageToken : ''
    if (token && seen.has(token)) {
      throw new Error('payload-plugin-attribution: repeated GA4 property page token')
    }
    seen.add(token)
  } while (token)
  return rows
}

function normalizeKeyEvents(
  entries: PropertyPlan['keyEvents'],
): Map<string, Ga4KeyEventCountingMethod> {
  const events = new Map<string, Ga4KeyEventCountingMethod>()
  for (const entry of entries ?? []) {
    const eventName = typeof entry === 'string' ? entry : entry.eventName
    const countingMethod = typeof entry === 'string' ? undefined : entry.countingMethod
    if (!validEventName(eventName)) {
      throw new TypeError('payload-plugin-attribution: invalid GA4 key event name')
    }
    if (
      countingMethod !== undefined &&
      !(GA4_KEY_EVENT_COUNTING_METHODS as readonly string[]).includes(countingMethod)
    ) {
      throw new TypeError('payload-plugin-attribution: invalid GA4 key event counting method')
    }
    events.set(eventName, countingMethod ?? DEFAULT_GA4_KEY_EVENT_COUNTING_METHOD)
  }
  return events
}

const DIMENSION_PLAN_KEYS = [
  ['eventDimensions', 'EVENT'],
  ['itemDimensions', 'ITEM'],
  ['userDimensions', 'USER'],
] as const

type DimensionPlan = { maxAllowed: number; names: string[]; scope: 'EVENT' | 'ITEM' | 'USER' }

// Name validity and a plan's own size against GA4's fixed limit never depend on what already
// exists on the property, so both are checked locally before any Admin API call. Whether that
// plan can still fit alongside what already exists can only be known after listing, so that
// count-dependent check stays below, after the listing calls.
function planDimensions(plan: PropertyPlan): DimensionPlan[] {
  return DIMENSION_PLAN_KEYS.map(([key, scope]) => {
    const names = [...new Set(plan[key] ?? [])]
    const maxLength = scope === 'USER' ? GA4_USER_DIMENSION_NAME_MAX : GA4_DIMENSION_NAME_MAX
    if (!names.every((name) => validName(name, maxLength))) {
      throw new TypeError('payload-plugin-attribution: invalid GA4 dimension name')
    }
    const maxAllowed = GA4_DIMENSION_LIMITS[scope]
    if (names.length > maxAllowed) {
      throw new RangeError(`payload-plugin-attribution: GA4 ${scope} dimension limit exceeded`)
    }
    return { maxAllowed, names, scope }
  })
}

// Wraps an apply-time create failure with the item it was creating, since a plan can create many
// dimensions and key events in sequence and the sanitized Admin API message alone does not say
// which one failed.
function createFailure(kind: string, label: string, error: unknown): Error {
  if (!(error instanceof AdminApiError)) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const statusText = typeof error.status === 'number' ? ` (${error.status})` : ''
  const detail = error.googleMessage ? `: ${error.googleMessage}` : ''
  return new Error(
    `payload-plugin-attribution: creating ${kind} ${label} failed${statusText}${detail}`,
  )
}

export async function applyPropertyPlan(
  plan: PropertyPlan,
  transport: AdminTransport,
  apply: boolean,
): Promise<SetupResult> {
  const dimensionPlans = planDimensions(plan)
  const keyEvents = normalizeKeyEvents(plan.keyEvents)
  if (keyEvents.size > GA4_KEY_EVENT_LIMIT) {
    throw new RangeError('payload-plugin-attribution: GA4 key event limit exceeded')
  }

  const [dimensions, keyEventRows] = await Promise.all([
    listAll(transport, 'customDimensions', 'customDimensions'),
    listAll(transport, 'keyEvents', 'keyEvents'),
  ])

  const missingDimensions: MissingDimension[] = []
  for (const { maxAllowed, names, scope } of dimensionPlans) {
    const existing = dimensions.filter((row) => row.scope === scope)
    const missing = names.filter((name) => !existing.some((row) => row.parameterName === name))
    if (existing.length + missing.length > maxAllowed) {
      throw new RangeError(`payload-plugin-attribution: GA4 ${scope} dimension limit exceeded`)
    }
    missingDimensions.push(
      ...missing.map((parameterName) => ({
        displayName: parameterName.replaceAll('_', ' '),
        parameterName,
        scope,
      })),
    )
  }

  const missingKeyEvents: MissingKeyEvent[] = [...keyEvents.entries()]
    .filter(([eventName]) => !keyEventRows.some((row) => row.eventName === eventName))
    .map(([eventName, countingMethod]) => ({ countingMethod, eventName }))
  if (keyEventRows.length + missingKeyEvents.length > GA4_KEY_EVENT_LIMIT) {
    throw new RangeError('payload-plugin-attribution: GA4 key event limit exceeded')
  }

  if (apply) {
    for (const dimension of missingDimensions) {
      try {
        await transport('customDimensions', dimension)
      } catch (error) {
        throw createFailure('dimension', `"${dimension.parameterName}"`, error)
      }
    }
    for (const keyEvent of missingKeyEvents) {
      try {
        // countingMethod is required by the Admin API; omitting it makes every apply fail.
        await transport('keyEvents', keyEvent)
      } catch (error) {
        throw createFailure('key event', `"${keyEvent.eventName}"`, error)
      }
    }
  }

  return { apply, manualSteps: [...MANUAL_STEPS], missingDimensions, missingKeyEvents }
}

type ServiceAccountCredentials = { client_email: string; private_key: string }

function parseServiceAccountJson(json: string): ServiceAccountCredentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('payload-plugin-attribution: invalid service account JSON')
  }
  const record = parsed as { client_email?: unknown; private_key?: unknown } | null
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.client_email !== 'string' ||
    typeof record.private_key !== 'string'
  ) {
    throw new Error(
      'payload-plugin-attribution: service account JSON requires client_email and private_key',
    )
  }
  return { client_email: record.client_email, private_key: record.private_key }
}

// Never read `.config` here: gaxios errors attach the full request, including the bearer token.
function adminApiErrorDetail(error: unknown): { message?: string; status?: number } {
  const response =
    error && typeof error === 'object' && 'response' in error
      ? (error as { response?: unknown }).response
      : undefined
  const status =
    response && typeof response === 'object' ? (response as { status?: unknown }).status : undefined
  const data =
    response && typeof response === 'object' ? (response as { data?: unknown }).data : undefined
  const googleError =
    data && typeof data === 'object' && 'error' in data
      ? (data as { error?: { message?: unknown } }).error
      : undefined
  const message = typeof googleError?.message === 'string' ? googleError.message : undefined
  return { message, status: typeof status === 'number' ? status : undefined }
}

/** Carries only the sanitized status and Google message; never the request config or credentials. */
class AdminApiError extends Error {
  readonly googleMessage?: string
  readonly status?: number

  constructor(status: number | undefined, googleMessage: string | undefined) {
    const statusText = typeof status === 'number' ? ` (${status})` : ''
    const detail = googleMessage ? `: ${googleMessage}` : ''
    super(`payload-plugin-attribution: GA4 Admin API request failed${statusText}${detail}`)
    this.name = new.target.name
    this.googleMessage = googleMessage
    this.status = status
  }
}

const ADMIN_TIMEOUT_MS = 10000

function tokenTransport(
  base: string,
  accessToken: () => Promise<string> | string,
  signal: AbortSignal | undefined,
): AdminTransport {
  return async (path, body) => {
    let response: Response
    try {
      const token = await accessToken()
      response = await fetch(`${base}/${path}`, {
        ...(body ? { body: JSON.stringify(body) } : {}),
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      })
    } catch {
      throw new AdminApiError(undefined, undefined)
    }
    const data: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const { message } = adminApiErrorDetail({ response: { data, status: response.status } })
      throw new AdminApiError(response.status, message)
    }
    return data && typeof data === 'object' ? (data as AdminRow) : {}
  }
}

export async function setupGa4Property(args: {
  /** Supplies a bearer token instead of serviceAccountJson, for hosts with their own token source and for mock providers. */
  accessToken?: () => Promise<string> | string
  apply?: boolean
  payload: Payload
  plan: PropertyPlan
  serviceAccountJson?: string
  signal?: AbortSignal
}): Promise<SetupResult> {
  const { accessToken, apply = false, payload, plan, serviceAccountJson, signal } = args
  const { options } = getPluginContext(payload)
  const propertyId = await resolveSetting(options.destinations.ga4?.propertyId)
  if (!/^\d+$/.test(propertyId)) {
    throw new Error('payload-plugin-attribution: a numeric GA4 propertyId is required')
  }
  const base = `${options.endpoints.ga4Admin}/properties/${propertyId}`
  if (accessToken) {
    return applyPropertyPlan(plan, tokenTransport(base, accessToken, signal), apply)
  }
  if (serviceAccountJson === undefined) {
    throw new Error(
      'payload-plugin-attribution: setupGa4Property requires serviceAccountJson or accessToken',
    )
  }
  const credentials = parseServiceAccountJson(serviceAccountJson)
  const auth = new GoogleAuth({
    credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
    scopes: [
      apply
        ? 'https://www.googleapis.com/auth/analytics.edit'
        : 'https://www.googleapis.com/auth/analytics.readonly',
    ],
  })

  const transport: AdminTransport = async (path, body) => {
    try {
      const client = await auth.getClient()
      const response = await client.request<AdminRow>({
        method: body ? 'POST' : 'GET',
        url: `${base}/${path}`,
        ...(body ? { data: body } : {}),
        signal,
        timeout: ADMIN_TIMEOUT_MS,
      })
      return response.data
    } catch (error) {
      const { message, status } = adminApiErrorDetail(error)
      throw new AdminApiError(status, message)
    }
  }

  return applyPropertyPlan(plan, transport, apply)
}
