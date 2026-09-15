import type { NextRequest } from 'next/server.js'

import { NextResponse } from 'next/server.js'
import { attributionProxy } from 'payload-plugin-attribution/next'

const attribution = attributionProxy({ excludePaths: ['/reset-password', '/pay'] })

// Next 15 runs middleware.ts and loads only an export named middleware (or a default export);
// an export named proxy builds and type-checks, then fails every matched request with HTTP 500.
export async function middleware(request: NextRequest): Promise<Response> {
  // Host logic runs first: redirects, rewrites, headers and cookies.
  const response = NextResponse.next()
  response.headers.set('x-frame-options', 'DENY')
  // Attribution runs last: a later response.cookies.set would drop its Set-Cookie header.
  return attribution(request, response)
}

export const config = {
  matcher: [
    {
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'rsc' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
        { type: 'header', key: 'sec-purpose', value: '.*prefetch.*' },
      ],
      source: '/((?!api|admin|_next|favicon.ico).*)',
    },
  ],
}
