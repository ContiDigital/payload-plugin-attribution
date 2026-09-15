import { createEventId } from 'payload-plugin-attribution/browser'

type Fbq = (command: 'track', event: string, params: object, options: { eventID: string }) => void

// The pixel and the server event share one id; send it with the form and record it as the
// draft's eventId.
export function trackLeadInPixel(fbq: Fbq): string {
  const eventId = createEventId()
  fbq('track', 'Lead', {}, { eventID: eventId })
  return eventId
}
