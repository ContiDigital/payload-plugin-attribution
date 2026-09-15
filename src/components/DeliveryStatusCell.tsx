'use client'

import type { DeliveryStatus, Destination } from '../types/index.js'

import { DELIVERY_STATUSES, DESTINATIONS } from '../constants.js'
import { labels } from './labels.js'

type Entry = { destination: Destination; reason?: string; status: DeliveryStatus }

const isStatus = (value: unknown): value is DeliveryStatus =>
  typeof value === 'string' && (DELIVERY_STATUSES as readonly string[]).includes(value)

// List cells can hand a json field over as serialized text.
const summaryOf = (cellData: unknown): Record<string, unknown> => {
  let value = cellData
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

const entriesOf = (cellData: unknown): Entry[] => {
  const summary = summaryOf(cellData)
  return DESTINATIONS.flatMap((destination): Entry[] => {
    const entry = summary[destination]
    if (typeof entry !== 'object' || entry === null) {
      return []
    }
    const { reason, status } = entry as { reason?: unknown; status?: unknown }
    if (!isStatus(status)) {
      return []
    }
    return [{ destination, status, ...(typeof reason === 'string' && reason ? { reason } : {}) }]
  })
}

export function DeliveryStatusCell({ cellData }: { cellData?: unknown }) {
  const entries = entriesOf(cellData)
  if (entries.length === 0) {
    return <span>{labels.cell.empty}</span>
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {entries.map(({ destination, reason, status }) => (
        <li key={destination}>
          {`${labels.destinations[destination]}: ${labels.statuses[status]}${reason ? ` (${reason})` : ''}`}
        </li>
      ))}
    </ul>
  )
}
