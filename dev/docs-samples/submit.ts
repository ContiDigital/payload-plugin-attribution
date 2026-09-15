import type { BrowserOptions } from 'payload-plugin-attribution/browser'

import { attributionForSubmit } from 'payload-plugin-attribution/browser'

export async function submitLead(
  form: { email: string; message: string; name: string },
  consent?: BrowserOptions['consent'],
): Promise<Response> {
  // Resolves within about half a second and never throws; an empty object is a valid result.
  const attribution = await attributionForSubmit({ consent, measurementId: 'G-XXXXXXXXXX' })
  return fetch('/api/leads', {
    body: JSON.stringify({ ...form, attribution }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
}
