import type { MetaDestinationOptions } from 'payload-plugin-attribution'

export const meta: MetaDestinationOptions = {
  accessToken: () => process.env.META_ACCESS_TOKEN ?? '',
  // Replaces the default mapping: list every event Meta should receive.
  events: {
    generate_lead: 'Lead',
    purchase: 'Purchase',
    walk_in_sale: { name: 'Purchase', actionSource: 'physical_store' },
  },
  limitedDataUse: false,
  pixelId: '100000000000001',
  resendRevisions: false,
  // Set only while testing: events then appear in Test Events.
  testEventCode: () => process.env.META_TEST_EVENT_CODE ?? '',
}
