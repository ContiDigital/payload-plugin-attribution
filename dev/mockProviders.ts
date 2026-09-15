import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const MOCK_DATA_MANAGER_TOKEN = 'mock-data-manager-token'
export const MOCK_META_TOKEN = 'mock-meta-access-token'
export const MOCK_ADMIN_TOKEN = 'mock-ga4-admin-token'

export const MOCK_PROVIDERS = [
  'dataManager',
  'dataManagerToken',
  'ga4',
  'ga4Admin',
  'ga4Debug',
  'meta',
] as const
export type MockProvider = (typeof MOCK_PROVIDERS)[number]

export type RecordedRequest = {
  authorization?: string
  body: unknown
  method: string
  path: string
  provider: MockProvider
  query: Record<string, string>
}

// GA4's recommended parameters for these events, checked only in ENFORCE_RECOMMENDATIONS mode.
const RECOMMENDED_PARAMS: Record<string, readonly string[]> = {
  generate_lead: ['currency', 'lead_source', 'value'],
  purchase: ['currency', 'transaction_id', 'value'],
}

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

const send = (response: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) {
    response.writeHead(status).end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

type Ga4Body = {
  events?: Array<{ name?: string; params?: Record<string, unknown> }>
  validation_behavior?: string
}

const validationMessages = (body: Ga4Body) => {
  if (body.validation_behavior !== 'ENFORCE_RECOMMENDATIONS') {
    return []
  }
  return (body.events ?? []).flatMap((event, index) =>
    (RECOMMENDED_PARAMS[event.name ?? ''] ?? [])
      .filter((param) => event.params?.[param] === undefined)
      .map((param) => ({
        description: `Recommended parameter ${param} is missing for event ${event.name}.`,
        fieldPath: `events[${index}].params.${param}`,
        validationCode: 'VALUE_REQUIRED',
      })),
  )
}

const bearer = (request: IncomingMessage, token: string): boolean =>
  request.headers.authorization === `Bearer ${token}`

const ADMIN_PATH = /^\/v1beta\/properties\/\d+\/(?:customDimensions|keyEvents)$/
const META_PATH = /^\/v\d+\.\d+\/[^/]+\/events$/

export function createMockProviders(): {
  requests: RecordedRequest[]
  server: Server
} {
  const requests: RecordedRequest[] = []

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://mock.invalid')
      const method = request.method ?? 'GET'
      const path = url.pathname

      if (path === '/__health') {
        send(response, 200, { ok: true })
        return
      }
      if (path === '/__requests') {
        if (method === 'DELETE') {
          requests.splice(0)
          send(response, 204)
        } else {
          send(response, 200, { requests })
        }
        return
      }

      const body = await readBody(request)
      const record = (provider: MockProvider): void => {
        requests.push({
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          body,
          method,
          path,
          provider,
          query: Object.fromEntries(url.searchParams),
        })
      }

      if (method === 'POST' && path === '/mp/collect') {
        record('ga4')
        send(response, 204)
      } else if (method === 'POST' && path === '/debug/mp/collect') {
        record('ga4Debug')
        send(response, 200, { validationMessages: validationMessages((body ?? {}) as Ga4Body) })
      } else if (method === 'POST' && path === '/token') {
        record('dataManagerToken')
        send(response, 200, {
          access_token: MOCK_DATA_MANAGER_TOKEN,
          expires_in: 3600,
          token_type: 'Bearer',
        })
      } else if (method === 'POST' && path === '/v1/events:ingest') {
        record('dataManager')
        if (bearer(request, MOCK_DATA_MANAGER_TOKEN)) {
          send(response, 200, { requestId: `mock-request-${requests.length}` })
        } else {
          send(response, 401, { error: { message: 'Request had invalid credentials.' } })
        }
      } else if (ADMIN_PATH.test(path)) {
        record('ga4Admin')
        if (!bearer(request, MOCK_ADMIN_TOKEN)) {
          send(response, 401, { error: { message: 'Request had invalid credentials.' } })
        } else if (method === 'GET') {
          send(
            response,
            200,
            path.endsWith('customDimensions')
              ? { customDimensions: [{ parameterName: 'lead_source', scope: 'EVENT' }] }
              : { keyEvents: [{ eventName: 'purchase' }] },
          )
        } else {
          send(response, 403, { error: { message: 'Writes are disabled in the mock Admin API.' } })
        }
      } else if (method === 'POST' && META_PATH.test(path)) {
        record('meta')
        const data = (body as { data?: unknown[] } | undefined)?.data
        if (!bearer(request, MOCK_META_TOKEN)) {
          send(response, 400, {
            error: { type: 'OAuthException', code: 190, message: 'Invalid OAuth access token.' },
          })
        } else {
          send(response, 200, {
            events_received: Array.isArray(data) ? data.length : 0,
            fbtrace_id: 'mock-trace',
          })
        }
      } else {
        send(response, 404, { error: { message: `No mock provider for ${method} ${path}` } })
      }
    })().catch(() => {
      send(response, 500, { error: { message: 'mock provider failure' } })
    })
  })

  return { requests, server }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PROVIDERS_PORT ?? '3199')
  createMockProviders().server.listen(port, '127.0.0.1')
}
