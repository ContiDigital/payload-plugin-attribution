// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { DeliveryStatusCell } from '../DeliveryStatusCell.js'

afterEach(cleanup)

describe('DeliveryStatusCell', () => {
  it('lists each destination status and reason in destination order', () => {
    render(
      <DeliveryStatusCell
        cellData={{
          ga4: { reason: null, status: 'sent' },
          googleAds: { reason: 'rate_limited', status: 'retry' },
          meta: { reason: 'consent_denied', status: 'withheld' },
        }}
      />,
    )
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'GA4: Sent',
      'Google Ads: Retrying (rate_limited)',
      'Meta: Withheld (consent_denied)',
    ])
  })

  it('reads a summary serialized as JSON text', () => {
    render(<DeliveryStatusCell cellData='{"googleAdsAdjustment":{"status":"served"}}' />)
    expect(screen.getByRole('listitem').textContent).toBe('Google Ads adjustments: Served in feed')
  })

  it('skips unknown destinations and statuses', () => {
    render(
      <DeliveryStatusCell
        cellData={{ ga4: { status: 'exploded' }, meta: 'sent', tiktok: { status: 'sent' } }}
      />,
    )
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText('No deliveries')).toBeTruthy()
  })

  it.each([undefined, null, '', 'not json', 42])('shows no deliveries for %p', (cellData) => {
    render(<DeliveryStatusCell cellData={cellData} />)
    expect(screen.getByText('No deliveries')).toBeTruthy()
  })
})
