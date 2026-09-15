import { afterEach, describe, expect, it, vi } from 'vitest'

import { HttpNetworkError } from '../errors.js'
import { postJson, responseData } from '../http.js'

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('postJson', () => {
  it('posts JSON with the given headers, redirect: error, and parses a JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    const result = await postJson(
      'https://example.test/collect',
      { hello: 'world' },
      { headers: { 'x-extra': '1' }, signal: controller.signal },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.test/collect')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBe(controller.signal)
    expect(init.body).toBe(JSON.stringify({ hello: 'world' }))
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect((init.headers as Record<string, string>)['x-extra']).toBe('1')

    expect(result.status).toBe(200)
    expect(result.json).toStrictEqual({ ok: true })
    expect(result.text).toBe(JSON.stringify({ ok: true }))
    expect(result.headers).toBeInstanceOf(Headers)
  })

  it('leaves json undefined when the response body is not JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('not json', { headers: { 'content-type': 'text/plain' }, status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await postJson(
      'https://example.test/collect',
      {},
      { signal: new AbortController().signal },
    )
    expect(result.status).toBe(200)
    expect(result.json).toBeUndefined()
    expect(result.text).toBe('not json')
  })

  it('does not parse a JSON-looking body when Content-Type is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'text/plain' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await postJson(
      'https://example.test/collect',
      {},
      { signal: new AbortController().signal },
    )
    expect(result.json).toBeUndefined()
    expect(result.text).toBe(JSON.stringify({ ok: true }))
  })

  it('parses JSON when Content-Type carries a charset parameter, case-insensitively', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'Application/JSON; charset=utf-8' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await postJson(
      'https://example.test/collect',
      {},
      { signal: new AbortController().signal },
    )
    expect(result.json).toStrictEqual({ ok: true })
  })

  it('wraps a network failure in HttpNetworkError, keeping the cause', async () => {
    const cause = new TypeError('fetch failed')
    const fetchMock = vi.fn().mockRejectedValue(cause)
    vi.stubGlobal('fetch', fetchMock)

    const promise = postJson(
      'https://example.test/collect',
      {},
      { signal: new AbortController().signal },
    )
    await expect(promise).rejects.toBeInstanceOf(HttpNetworkError)
    await expect(promise).rejects.toMatchObject({ cause })
  })

  it('rethrows an AbortError without wrapping it', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    const fetchMock = vi.fn().mockRejectedValue(abortError)
    vi.stubGlobal('fetch', fetchMock)

    const promise = postJson(
      'https://example.test/collect',
      {},
      { signal: new AbortController().signal },
    )
    await expect(promise).rejects.toBe(abortError)
  })

  it('never logs the request or response body', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const errorSpy = vi.spyOn(console, 'error')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ secret: 'shh' }, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await postJson(
      'https://example.test/collect',
      { secret: 'shh' },
      { signal: new AbortController().signal },
    )

    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

describe('responseData', () => {
  it.each([
    ['parsed JSON over text', { json: { ok: true }, text: '{"ok":true}' }, { ok: true }],
    ['a falsy parsed JSON value', { json: 0, text: '0' }, 0],
    ['the text when there is no JSON', { json: undefined, text: 'plain' }, 'plain'],
    ['undefined for an empty body', { json: undefined, text: '' }, undefined],
  ])('returns %s', (_label, result, expected) => {
    expect(responseData(result)).toStrictEqual(expected)
  })
})
