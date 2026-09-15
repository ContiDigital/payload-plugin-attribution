'use client'

import { useConfig, useDocumentInfo } from '@payloadcms/ui'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { DeliveryDoc } from '../types/index.js'

import { DEFAULT_API_BASE, DELIVERIES_PANEL_LIMIT, DELIVERIES_SLUG } from '../constants.js'
import { labels } from './labels.js'

type DeliveryRow = Pick<
  DeliveryDoc,
  | 'attempt'
  | 'destination'
  | 'firstServedAt'
  | 'id'
  | 'lastServedAt'
  | 'nextAttemptAt'
  | 'reason'
  | 'sentAt'
  | 'status'
>

const JSON_HEADERS = { 'Content-Type': 'application/json' }

const COLUMNS = [
  'destination',
  'status',
  'reason',
  'attempt',
  'nextAttemptAt',
  'sentAt',
  'firstServedAt',
  'lastServedAt',
  'actions',
] as const satisfies ReadonlyArray<keyof typeof labels.panel.columns>

const destinationLabel = (destination: string): string =>
  (labels.destinations as Record<string, string>)[destination] ?? destination

const statusLabel = (status: string): string =>
  (labels.statuses as Record<string, string>)[status] ?? status

const errorCode = async (response: Response): Promise<unknown> => {
  try {
    return ((await response.json()) as { error?: unknown }).error
  } catch {
    return undefined
  }
}

const failureMessage = (code: unknown, status: number, destination: string): string => {
  if (code === 'delivery_in_progress') {
    return labels.panel.inProgress(destination)
  }
  if (code === 'already_sent') {
    return labels.panel.alreadySent(destination)
  }
  return status === 403 ? labels.panel.forbidden : labels.panel.failed(destination)
}

function Timestamp({ value }: { value?: null | string }) {
  return value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : null
}

export function DeliveriesPanel({
  apiBasePath = DEFAULT_API_BASE,
  deliveriesSlug = DELIVERIES_SLUG,
}: {
  apiBasePath?: string
  deliveriesSlug?: string
}) {
  const { id } = useDocumentInfo()
  const { config } = useConfig()
  const apiRoute = typeof config.routes?.api === 'string' ? config.routes.api : '/api'
  const eventId = id === undefined || id === null ? undefined : encodeURIComponent(String(id))

  const [rows, setRows] = useState<DeliveryRow[] | null>(null)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState<null | string>(null)
  const [confirming, setConfirming] = useState<DeliveryRow | null>(null)
  const sendingRef = useRef(false)
  const returnFocusRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const titleId = useId()
  const bodyId = useId()

  const load = useCallback(async () => {
    if (!eventId) {
      return
    }
    try {
      const response = await fetch(
        `${apiRoute}/${deliveriesSlug}?where[event][equals]=${eventId}&sort=-createdAt&depth=0&limit=${DELIVERIES_PANEL_LIMIT}`,
        { credentials: 'same-origin' },
      )
      if (!response.ok) {
        throw new Error(`deliveries request failed with ${response.status}`)
      }
      const { docs } = (await response.json()) as { docs?: unknown }
      setRows(Array.isArray(docs) ? (docs as DeliveryRow[]) : [])
    } catch {
      setMessage(labels.panel.loadFailed)
    }
  }, [apiRoute, deliveriesSlug, eventId])

  useEffect(() => {
    void load()
  }, [load])

  // showModal contains focus and makes the rest of the page inert while the dialog is open.
  useEffect(() => {
    if (confirming && dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal()
      cancelRef.current?.focus()
    }
  }, [confirming])

  const send = async (row: DeliveryRow, force: boolean): Promise<void> => {
    if (!eventId || sendingRef.current) {
      return
    }
    const label = destinationLabel(row.destination)
    sendingRef.current = true
    setSending(row.destination)
    setMessage(labels.panel.sending(label))
    // The clicked button is disabled while sending and may be replaced by the reload.
    statusRef.current?.focus()
    try {
      const response = await fetch(`${apiRoute}${apiBasePath}/events/${eventId}/redeliver`, {
        body: JSON.stringify({ destinations: [row.destination], force }),
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        method: 'POST',
      })
      if (response.ok) {
        setMessage(labels.panel.queued(label))
        await load()
      } else {
        const code = await errorCode(response)
        setMessage(failureMessage(code, response.status, label))
        if (code === 'already_sent') {
          await load()
        }
      }
    } catch {
      setMessage(labels.panel.failed(label))
    } finally {
      sendingRef.current = false
      setSending(null)
    }
  }

  const hideDialog = (): DeliveryRow | null => {
    const row = confirming
    dialogRef.current?.close()
    setConfirming(null)
    return row
  }

  const cancelDialog = (): void => {
    hideDialog()
    returnFocusRef.current?.focus()
  }

  const confirmResend = (): void => {
    const row = hideDialog()
    if (row) {
      void send(row, true)
    }
  }

  const offered = new Set<string>()

  return (
    <div
      className="field-type attribution-deliveries-panel"
      style={{ marginBottom: 'var(--base, 1.5rem)' }}
    >
      {!eventId ? <p>{labels.panel.unsaved}</p> : null}
      {eventId && rows === null ? <p>{labels.panel.loading}</p> : null}
      {rows?.length === 0 ? <p>{labels.panel.empty}</p> : null}
      {rows && rows.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <caption style={{ fontWeight: 600, textAlign: 'left' }}>{labels.panel.title}</caption>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column} scope="col">
                    {labels.panel.columns[column]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const label = destinationLabel(row.destination)
                const latest = !offered.has(row.destination)
                offered.add(row.destination)
                return (
                  <tr key={row.id}>
                    <th scope="row">{label}</th>
                    <td>{statusLabel(row.status)}</td>
                    <td>{row.reason ?? ''}</td>
                    <td>{row.attempt ?? 0}</td>
                    <td>
                      <Timestamp value={row.nextAttemptAt} />
                    </td>
                    <td>
                      <Timestamp value={row.sentAt} />
                    </td>
                    <td>
                      <Timestamp value={row.firstServedAt} />
                    </td>
                    <td>
                      <Timestamp value={row.lastServedAt} />
                    </td>
                    <td>
                      {latest ? (
                        <button
                          aria-label={labels.panel.sendAgainLabel(label)}
                          className="btn btn--style-secondary btn--size-small"
                          disabled={sending !== null}
                          onClick={(event) => {
                            if (
                              row.status === 'sent' ||
                              row.status === 'served' ||
                              Boolean(row.firstServedAt)
                            ) {
                              returnFocusRef.current = event.currentTarget
                              setConfirming(row)
                            } else {
                              void send(row, false)
                            }
                          }}
                          type="button"
                        >
                          {labels.panel.sendAgain}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <p aria-live="polite" ref={statusRef} role="status" tabIndex={-1}>
        {message}
      </p>
      {confirming ? (
        <dialog
          aria-describedby={bodyId}
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault()
            cancelDialog()
          }}
          ref={dialogRef}
          role="alertdialog"
          style={{
            background: 'var(--theme-elevation-0, #fff)',
            border: 'none',
            borderRadius: 'var(--style-radius-m, 4px)',
            color: 'var(--theme-text, inherit)',
            maxWidth: '28rem',
            padding: 'var(--base, 1.5rem)',
          }}
        >
          <h4 id={titleId}>
            {labels.panel.confirmTitle(destinationLabel(confirming.destination))}
          </h4>
          <p id={bodyId}>{labels.panel.confirmBody(destinationLabel(confirming.destination))}</p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button
              className="btn btn--style-secondary btn--size-small"
              onClick={cancelDialog}
              ref={cancelRef}
              type="button"
            >
              {labels.panel.cancel}
            </button>
            <button
              className="btn btn--style-primary btn--size-small"
              onClick={confirmResend}
              type="button"
            >
              {labels.panel.confirm}
            </button>
          </div>
        </dialog>
      ) : null}
    </div>
  )
}
