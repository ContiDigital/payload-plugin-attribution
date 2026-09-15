'use server'

import type { Attribution } from 'payload-plugin-attribution/browser'

import { headers } from 'next/headers.js'
import { randomUUID } from 'node:crypto'
import {
  commitTransaction,
  createLocalReq,
  getPayload,
  initTransaction,
  killTransaction,
} from 'payload'
import { recordConversion, requestContextFromHeaders } from 'payload-plugin-attribution'
import { sanitizeAttribution } from 'payload-plugin-attribution/browser'
import { readAttributionCookie } from 'payload-plugin-attribution/next'

import config from '../../../payload.config.js'

export type LeadState =
  { message: string; status: 'error' } | { reference: string; status: 'sent' } | { status: 'idle' }

const field = (formData: FormData, name: string, maxLength: number): string => {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

// Only values the browser alone can know. Click ids, fbc, UTMs, referrer and landing data come
// from the proxy cookie, which the proxy strips under Global Privacy Control and the reader
// re-sanitizes; posted copies could restore ids the proxy removed.
const BROWSER_ONLY_KEYS = [
  'gaClientId',
  'gaSessionId',
  'gaSessionNumber',
  'fbp',
  'consentAdUserData',
  'consentAdPersonalization',
  'consentAnalyticsStorage',
] as const satisfies readonly (keyof Attribution)[]

const browserOnly = (posted: unknown): Attribution => {
  const sanitized = sanitizeAttribution(posted) ?? {}
  return Object.fromEntries(
    BROWSER_ONLY_KEYS.flatMap((key) =>
      sanitized[key] === undefined ? [] : [[key, sanitized[key]]],
    ),
  ) as Attribution
}

const postedAttribution = (raw: FormDataEntryValue | null): unknown => {
  if (typeof raw !== 'string') {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// The full referrer can carry click ids and other query values; Meta only needs the page.
const pageUrl = (referer: null | string): string | undefined => {
  if (!referer) {
    return undefined
  }
  try {
    const url = new URL(referer)
    return `${url.origin}${url.pathname}`
  } catch {
    return undefined
  }
}

export async function submitLead(_previous: LeadState, formData: FormData): Promise<LeadState> {
  const name = field(formData, 'name', 200)
  const email = field(formData, 'email', 320)
  if (!name || !email) {
    return { message: 'Enter your name and email.', status: 'error' }
  }

  const requestHeaders = await headers()
  const touches = readAttributionCookie(requestHeaders.get('cookie'))
  // The proxy cookie wins where both carry a value.
  const attribution = sanitizeAttribution({
    ...browserOnly(postedAttribution(formData.get('attribution'))),
    ...touches?.last,
  })
  const firstCampaign = touches?.first.utmCampaign
  const url = pageUrl(requestHeaders.get('referer'))
  const reference = `lead-${randomUUID().slice(0, 12)}`
  // The form post carries Sec-GPC too. Unless the visitor's own consent choice was posted, it
  // denies ad consent, so Google Ads and Meta never receive this visitor's identifiers.
  const consent =
    requestHeaders.get('sec-gpc')?.trim() === '1' && attribution?.consentAdUserData === undefined
      ? ({ adPersonalization: 'denied', adUserData: 'denied' } as const)
      : undefined

  const payload = await getPayload({ config })
  const req = await createLocalReq({}, payload)
  await initTransaction(req)
  try {
    const lead = await payload.create({
      collection: 'leads',
      data: {
        name,
        attribution,
        email,
        message: field(formData, 'message', 2000),
        reference,
      },
      req,
    })
    await recordConversion({
      draft: {
        name: 'generate_lead',
        attribution,
        buyer: { name, email },
        ...(consent ? { consent } : {}),
        context: { ...requestContextFromHeaders(requestHeaders), ...(url ? { url } : {}) },
        eventKey: `lead:${reference}`,
        eventSource: 'WEB',
        googleAds: { action: 'lead', kind: 'conversion' },
        occurredAt: new Date().toISOString(),
        ...(firstCampaign ? { params: { first_campaign: firstCampaign } } : {}),
        subject: { id: lead.id, collectionSlug: 'leads' },
        transactionId: reference,
      },
      payload,
      req,
    })
    await commitTransaction(req)
  } catch (error) {
    await killTransaction(req)
    throw error
  }
  return { reference, status: 'sent' }
}
