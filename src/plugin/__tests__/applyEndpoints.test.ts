import type { Config, Endpoint, Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import { applyEndpoints } from '../applyEndpoints.js'
import { normalizeOptions } from '../normalizeOptions.js'

const options = normalizeOptions({ secret: 'plugin-secret' })

const hostEndpoint: Endpoint = {
  handler: () => Response.json({ host: true }),
  method: 'get',
  path: '/health',
}

const PLUGIN_ROUTES = [
  'get /attribution/google-ads/conversions.csv',
  'get /attribution/google-ads/adjustments.csv',
  'post /attribution/events/:id/redeliver',
  'get /attribution/health',
]

const routes = (config: Config): string[] =>
  (config.endpoints ?? []).map(({ method, path }) => `${method} ${path}`)

const fakeLogger = () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() })

describe('applyEndpoints', () => {
  it('appends the plugin endpoints after the host endpoints and leaves onInit alone', () => {
    const hostOnInit = vi.fn()
    const config = applyEndpoints(
      { endpoints: [hostEndpoint], onInit: hostOnInit } as unknown as Config,
      options,
    )
    expect(routes(config)).toEqual(['get /health', ...PLUGIN_ROUTES])
    expect(config.onInit).toBe(hostOnInit)
  })

  it('mounts every plugin endpoint under a custom apiBasePath', () => {
    const config = applyEndpoints(
      {} as Config,
      normalizeOptions({ apiBasePath: '/ops/conversions', secret: 'plugin-secret' }),
    )
    expect(routes(config)).toEqual(
      PLUGIN_ROUTES.map((route) => route.replace('/attribution', '/ops/conversions')),
    )
  })

  it('keeps a host endpoint on a plugin route, skips the plugin endpoint and warns at init', async () => {
    const host: Endpoint = {
      handler: () => new Response('host feed'),
      method: 'GET' as Endpoint['method'],
      path: '/attribution/google-ads/conversions.csv',
    }
    const other: Endpoint = { ...host, method: 'post' }
    const hostOnInit = vi.fn()
    const config = applyEndpoints(
      { endpoints: [host, other], onInit: hostOnInit } as unknown as Config,
      options,
    )
    expect(routes(config)).toEqual([
      'GET /attribution/google-ads/conversions.csv',
      'post /attribution/google-ads/conversions.csv',
      ...PLUGIN_ROUTES.slice(1),
    ])
    expect(config.endpoints?.[0]).toBe(host)

    const logger = fakeLogger()
    const payload = { logger } as unknown as Payload
    await config.onInit?.(payload)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith({
      msg: expect.stringContaining('GET /attribution/google-ads/conversions.csv'),
    })
    expect(hostOnInit).toHaveBeenCalledWith(payload)
  })

  it('keeps host redeliver and health endpoints and warns once for each', async () => {
    const redeliver: Endpoint = {
      handler: () => new Response('host redeliver'),
      method: 'post',
      path: '/attribution/events/:id/redeliver',
    }
    const health: Endpoint = {
      handler: () => new Response('host health'),
      method: 'get',
      path: '/attribution/health',
    }
    const config = applyEndpoints({ endpoints: [redeliver, health] } as Config, options)
    expect(routes(config)).toEqual([
      'post /attribution/events/:id/redeliver',
      'get /attribution/health',
      ...PLUGIN_ROUTES.slice(0, 2),
    ])
    expect(config.endpoints?.[0]).toBe(redeliver)
    expect(config.endpoints?.[1]).toBe(health)

    const logger = fakeLogger()
    await config.onInit?.({ logger } as unknown as Payload)
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith({
      msg: expect.stringContaining('POST /attribution/events/:id/redeliver'),
    })
    expect(logger.warn).toHaveBeenCalledWith({
      msg: expect.stringContaining('GET /attribution/health'),
    })
  })

  it('warns at init without a host onInit', async () => {
    const config = applyEndpoints(
      {
        endpoints: [{ ...hostEndpoint, path: '/attribution/google-ads/adjustments.csv' }],
      } as Config,
      options,
    )
    const logger = fakeLogger()
    await config.onInit?.({ logger } as unknown as Payload)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('adds nothing when the plugin is disabled', () => {
    const config = { endpoints: [hostEndpoint] } as Config
    expect(applyEndpoints(config, normalizeOptions({ disabled: true, secret: '' }))).toBe(config)
  })
})
