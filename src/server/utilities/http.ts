import { HttpNetworkError, isAbortError } from './errors.js'

export const responseData = (result: { json: unknown; text: string }): unknown =>
  result.json !== undefined ? result.json : result.text || undefined

export async function postJson(
  url: string,
  body: unknown,
  init: { headers?: Record<string, string>; signal: AbortSignal },
): Promise<{ headers: Headers; json: unknown; status: number; text: string }> {
  let response: Response
  try {
    response = await fetch(url, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...init.headers },
      method: 'POST',
      redirect: 'error',
      signal: init.signal,
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new HttpNetworkError('payload-plugin-attribution: network request failed', {
      cause: error,
    })
  }

  const text = await response.text()
  let json: unknown
  const contentType = response.headers.get('content-type') ?? ''
  if (text && /json/i.test(contentType)) {
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
  }

  return { headers: response.headers, json, status: response.status, text }
}
