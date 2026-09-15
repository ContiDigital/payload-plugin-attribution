// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ id: 'event/1' as string | undefined }))
vi.mock('@payloadcms/ui', () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-useless-custom-hooks
  useConfig: () => ({ config: { routes: { api: '/custom-api' } } }),
  // eslint-disable-next-line @eslint-react/hooks-extra/no-useless-custom-hooks
  useDocumentInfo: () => ({ id: state.id }),
}))

import { DeliveriesPanel } from '../DeliveriesPanel.js'

const LIST_URL =
  '/custom-api/conversion-deliveries?where[event][equals]=event%2F1&sort=-createdAt&depth=0&limit=100'
const REDELIVER_URL = '/custom-api/attribution/events/event%2F1/redeliver'

const rows = [
  {
    id: 3,
    attempt: 1,
    createdAt: '2026-09-14T11:00:00.000Z',
    destination: 'ga4',
    reason: null,
    sentAt: '2026-09-14T11:00:05.000Z',
    status: 'sent',
  },
  {
    id: 2,
    attempt: 2,
    createdAt: '2026-09-14T10:30:00.000Z',
    destination: 'meta',
    nextAttemptAt: '2026-09-14T12:00:00.000Z',
    reason: 'rate_limited',
    status: 'retry',
  },
  {
    id: 1,
    attempt: 0,
    createdAt: '2026-09-14T10:00:00.000Z',
    destination: 'ga4',
    reason: 'redelivered',
    status: 'superseded',
  },
]

type Handler = (url: string, init?: RequestInit) => Promise<Response>

const stubFetch = (
  redeliver: Handler = () => Promise.resolve(Response.json({ deliveries: [] })),
  list: () => unknown[] = () => rows,
) => {
  const fetch = vi.fn((url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? redeliver(url, init)
      : Promise.resolve(Response.json({ docs: list() })),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const posts = (fetch: ReturnType<typeof stubFetch>) =>
  fetch.mock.calls.filter(([, init]) => init?.method === 'POST')

const listReads = (fetch: ReturnType<typeof stubFetch>) =>
  fetch.mock.calls.filter(([url]) => url === LIST_URL)

const renderLoaded = async (props: { apiBasePath?: string } = {}) => {
  render(<DeliveriesPanel {...props} />)
  await screen.findByRole('table')
}

// jsdom has no top layer, so showModal and close only toggle the open attribute.
const showModal = vi.fn(function (this: HTMLDialogElement) {
  this.setAttribute('open', '')
})
const close = vi.fn(function (this: HTMLDialogElement) {
  this.removeAttribute('open')
})

beforeEach(() => {
  state.id = 'event/1'
  HTMLDialogElement.prototype.showModal = showModal
  HTMLDialogElement.prototype.close = close
  showModal.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DeliveriesPanel', () => {
  it('explains that deliveries appear after saving and fetches nothing', () => {
    state.id = undefined
    const fetch = stubFetch()
    render(<DeliveriesPanel />)
    expect(screen.getByText('Deliveries appear once the event is saved.')).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches the event deliveries and renders one row per delivery', async () => {
    const fetch = stubFetch()
    await renderLoaded()
    expect(fetch.mock.calls[0]).toEqual([LIST_URL, { credentials: 'same-origin' }])
    const table = screen.getByRole('table', { name: 'Deliveries' })
    const bodyRows = within(table).getAllByRole('row').slice(1)
    expect(bodyRows).toHaveLength(3)
    expect(within(bodyRows[0]).getByRole('rowheader').textContent).toBe('GA4')
    expect(bodyRows[0].textContent).toContain('Sent')
    expect(bodyRows[1].textContent).toContain('Retrying')
    expect(bodyRows[1].textContent).toContain('rate_limited')
    expect(bodyRows[1].textContent).toContain('2')
    expect(bodyRows[1].querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-09-14T12:00:00.000Z',
    )
    expect(bodyRows[2].textContent).toContain('Superseded')
  })

  it('marks the panel root with a stable class for host styling and scoped checks', async () => {
    stubFetch()
    await renderLoaded()
    const table = screen.getByRole('table', { name: 'Deliveries' })
    expect(table.closest('.attribution-deliveries-panel')).not.toBeNull()
  })

  it('offers Send again only on the latest delivery for each destination', async () => {
    stubFetch()
    await renderLoaded()
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Send GA4 again', 'Send Meta again'])
  })

  it('shows an empty state and announces a load failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ docs: [] })))
    render(<DeliveriesPanel />)
    expect(await screen.findByText('No deliveries recorded for this event.')).toBeTruthy()
    cleanup()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })))
    render(<DeliveriesPanel />)
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Could not load deliveries.'),
    )
  })

  it('confirms a sent resend in a native modal dialog and restores focus on cancel', async () => {
    const fetch = stubFetch()
    await renderLoaded()
    const trigger = screen.getByRole('button', { name: 'Send GA4 again' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('alertdialog', { name: 'Send GA4 again?' })
    expect(dialog.tagName).toBe('DIALOG')
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(showModal.mock.contexts[0]).toBe(dialog)
    expect(within(dialog).getByText(/already reached GA4/)).toBeTruthy()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))

    // Escape on a modal dialog fires a cancelable cancel event.
    const cancelEvent = new Event('cancel', { cancelable: true })
    fireEvent(dialog, cancelEvent)
    expect(cancelEvent.defaultPrevented).toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(posts(fetch)).toHaveLength(0)
  })

  it('force-resends after confirmation, keeps focus on the status and reloads the rows', async () => {
    const fetch = stubFetch()
    await renderLoaded()
    fireEvent.click(screen.getByRole('button', { name: 'Send GA4 again' }))
    const dialog = screen.getByRole('alertdialog')
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send again' }))
    })

    const status = screen.getByRole('status')
    expect(document.activeElement).toBe(status)
    expect(posts(fetch)).toEqual([
      [
        REDELIVER_URL,
        {
          body: JSON.stringify({ destinations: ['ga4'], force: true }),
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      ],
    ])
    await waitFor(() => expect(status.textContent).toBe('GA4 delivery queued.'))
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(listReads(fetch)).toHaveLength(2)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(status)
  })

  it('confirms before resending a delivery a feed already served', async () => {
    const fetch = stubFetch(undefined, () => [
      {
        id: 5,
        attempt: 0,
        createdAt: '2026-09-14T11:00:00.000Z',
        destination: 'googleAds',
        firstServedAt: '2026-09-14T12:00:00.000Z',
        lastServedAt: '2026-09-14T12:00:00.000Z',
        reason: null,
        status: 'served',
      },
    ])
    render(<DeliveriesPanel />)
    await screen.findByRole('button', { name: 'Send Google Ads again' })
    fireEvent.click(screen.getByRole('button', { name: 'Send Google Ads again' }))
    expect(screen.getByRole('alertdialog', { name: 'Send Google Ads again?' })).toBeTruthy()
    expect(posts(fetch)).toHaveLength(0)
  })

  it('resends an unsent delivery without confirmation on a custom api base path', async () => {
    const fetch = stubFetch()
    await renderLoaded({ apiBasePath: '/ops/conversions' })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Send Meta again' }))
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('status'))
    expect(posts(fetch)[0][0]).toBe('/custom-api/ops/conversions/events/event%2F1/redeliver')
    expect(posts(fetch)[0][1]?.body).toBe(JSON.stringify({ destinations: ['meta'], force: false }))
  })

  it('reloads the rows after already_sent so the destination asks for confirmation', async () => {
    let reads = 0
    const fetch = stubFetch(
      () => Promise.resolve(Response.json({ error: 'already_sent' }, { status: 409 })),
      () => {
        reads += 1
        return reads === 1
          ? rows
          : rows.map((row) => (row.destination === 'meta' ? { ...row, status: 'sent' } : row))
      },
    )
    await renderLoaded()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Send Meta again' }))
    })
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Meta was already sent. Use Send again to confirm a resend.',
      ),
    )
    expect(listReads(fetch)).toHaveLength(2)
    await waitFor(() => expect(screen.getAllByRole('row')[2].textContent).toContain('Sent'))
    fireEvent.click(screen.getByRole('button', { name: 'Send Meta again' }))
    expect(screen.getByRole('alertdialog', { name: 'Send Meta again?' })).toBeTruthy()
    expect(posts(fetch)).toHaveLength(1)
  })

  it('disables the button while sending so a double click posts once', async () => {
    let resolve!: (response: Response) => void
    const fetch = stubFetch(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    )
    await renderLoaded()
    const button = screen.getByRole('button', { name: 'Send Meta again' })
    fireEvent.click(button)
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('Sending Meta delivery...')
    fireEvent.click(button)
    expect(posts(fetch)).toHaveLength(1)
    await act(async () => {
      resolve(Response.json({ deliveries: [] }))
      await Promise.resolve()
    })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  })

  it.each([
    [
      'an in-flight delivery',
      () => Promise.resolve(Response.json({ error: 'delivery_in_progress' }, { status: 409 })),
      'Meta is already being sent. Try again in a few minutes.',
    ],
    [
      'a forbidden request',
      () => Promise.resolve(Response.json({ error: 'forbidden' }, { status: 403 })),
      'You do not have permission to resend deliveries.',
    ],
    [
      'a server error',
      () => Promise.resolve(new Response('oops', { status: 500 })),
      'Could not queue the Meta delivery.',
    ],
    [
      'a network failure',
      () => Promise.reject(new Error('offline')),
      'Could not queue the Meta delivery.',
    ],
  ])('announces %s and allows a retry', async (_label, redeliver, message) => {
    stubFetch(redeliver)
    await renderLoaded()
    const button = screen.getByRole('button', { name: 'Send Meta again' })
    act(() => {
      fireEvent.click(button)
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(message))
    expect(button.hasAttribute('disabled')).toBe(false)
  })
})
