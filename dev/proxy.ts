import type { NextRequest } from 'next/server.js'

import { NextResponse } from 'next/server.js'
import { attributionProxy } from 'payload-plugin-attribution/next'

const attribution = attributionProxy()

export async function proxy(request: NextRequest): Promise<Response> {
  const response = NextResponse.next()
  if (request.cookies.has('session')) {
    response.headers.append('set-cookie', 'session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax')
  }
  // Runs last: a later response.cookies.set would re-serialize Set-Cookie and drop attr_touch.
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
