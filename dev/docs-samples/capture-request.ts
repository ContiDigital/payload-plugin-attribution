import { captureFromRequest } from 'payload-plugin-attribution/next'

// For a fetch-style handler outside Next: capture, then add the cookie to the response.
export async function withAttribution(request: Request, response: Response): Promise<Response> {
  const { setCookie } = await captureFromRequest(request, { siteHosts: ['.example.com'] })
  if (!setCookie) {
    return response
  }
  const headers = new Headers(response.headers)
  headers.append('set-cookie', setCookie)
  headers.set('cache-control', 'private, no-store')
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}
