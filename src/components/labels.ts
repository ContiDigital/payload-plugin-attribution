import type { DeliveryStatus, Destination } from '../types/index.js'

export const labels = {
  cell: { empty: 'No deliveries' },
  destinations: {
    ga4: 'GA4',
    googleAds: 'Google Ads',
    googleAdsAdjustment: 'Google Ads adjustments',
    meta: 'Meta',
  } satisfies Record<Destination, string>,
  panel: {
    alreadySent: (destination: string) =>
      `${destination} was already sent. Use Send again to confirm a resend.`,
    cancel: 'Cancel',
    columns: {
      actions: 'Actions',
      attempt: 'Attempt',
      destination: 'Destination',
      firstServedAt: 'First served',
      lastServedAt: 'Last served',
      nextAttemptAt: 'Next attempt',
      reason: 'Reason',
      sentAt: 'Sent',
      status: 'Status',
    },
    confirm: 'Send again',
    confirmBody: (destination: string) =>
      `This event already reached ${destination}. Sending it again can count the conversion twice.`,
    confirmTitle: (destination: string) => `Send ${destination} again?`,
    empty: 'No deliveries recorded for this event.',
    failed: (destination: string) => `Could not queue the ${destination} delivery.`,
    forbidden: 'You do not have permission to resend deliveries.',
    inProgress: (destination: string) =>
      `${destination} is already being sent. Try again in a few minutes.`,
    loadFailed: 'Could not load deliveries.',
    loading: 'Loading deliveries...',
    queued: (destination: string) => `${destination} delivery queued.`,
    sendAgain: 'Send again',
    sendAgainLabel: (destination: string) => `Send ${destination} again`,
    sending: (destination: string) => `Sending ${destination} delivery...`,
    title: 'Deliveries',
    unsaved: 'Deliveries appear once the event is saved.',
  },
  statuses: {
    dead: 'Failed',
    eligible: 'Eligible for feed',
    pending: 'Pending',
    retry: 'Retrying',
    sending: 'Sending',
    sent: 'Sent',
    served: 'Served in feed',
    superseded: 'Superseded',
    withheld: 'Withheld',
  } satisfies Record<DeliveryStatus, string>,
} as const
