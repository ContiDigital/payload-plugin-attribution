import type { NextRequest } from 'next/server.js'

import { NextResponse } from 'next/server.js'

import type { CaptureOptions } from './capture.js'

import { captureWithOptions, resolveCaptureOptions } from './capture.js'
import { serializeCookie } from './cookie.js'

const PRIVATE_DIRECTIVE = /(?:^|,)\s*private\s*(?:,|$)/i

function withAppendedHeader(base: Response, setCookie: string): Response {
  try {
    base.headers.append('set-cookie', setCookie)
    return base
  } catch {
    // Response.redirect() and fetch responses have immutable headers.
    const headers = new Headers(base.headers)
    headers.append('set-cookie', setCookie)
    return new NextResponse(base.body, {
      headers,
      status: base.status,
      statusText: base.statusText,
    })
  }
}

/**
 * Pass the host's response to keep its redirects, rewrites, headers and cookies. Host cookies set
 * through response.cookies after this call rewrite the whole Set-Cookie list, so set them first.
 */
export function attributionProxy(
  options: CaptureOptions = {},
): (request: NextRequest, response?: Response) => Promise<Response> {
  const resolved = resolveCaptureOptions(options)
  return async (request, response) => {
    const captured = await captureWithOptions(request, resolved, new Date())
    const base = response ?? NextResponse.next()
    if (!captured) {
      return base
    }
    // ResponseCookies.set re-serializes every Set-Cookie by name, dropping same-named host cookies.
    const target = withAppendedHeader(base, serializeCookie(captured.cookie))
    if (!PRIVATE_DIRECTIVE.test(target.headers.get('cache-control') ?? '')) {
      target.headers.set('cache-control', 'private, no-store')
    }
    return target
  }
}
