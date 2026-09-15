import type { APIRequestContext, Page } from '@playwright/test'

import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type { RecordedRequest } from './mockProviders.js'

import {
  DEFAULT_E2E_PORT,
  DEFAULT_MOCK_PROVIDERS_PORT,
  E2E_DATABASE_FILE,
  E2E_FEED_CREDENTIALS,
  E2E_USER,
} from './e2eConstants.js'
import { MOCK_ADMIN_TOKEN } from './mockProviders.js'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const mockProvidersURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_MOCK_PORT ?? DEFAULT_MOCK_PROVIDERS_PORT}`
const campaign = 'fall-exhibition-2026-email'
const clickIdKeys = ['gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'fbc', 'fbp', 'msclkid']
const duplicateContextErrors =
  /useConfig|ConfigProvider|must be used within|Invalid hook call|more than one copy of React/i

type LedgerEvent = {
  attribution?: Record<string, unknown>
  consent: Record<string, string>
  deliverySummary?: Record<string, { reason?: null | string; status: string }>
  eventKey: string
  id: number | string
  transactionId?: string
}

// 20 characters, distinct per browser so every project records its own click.
const gclidFor = (project: string): string => `Cj0KCQjwe2e${project.padEnd(9, '0').slice(0, 9)}`

const runJobs = async (request: APIRequestContext, task: 'deliver' | 'sweep'): Promise<void> => {
  const response = await request.post('/api/dev/run-jobs', { data: { task } })
  expect(response.ok()).toBe(true)
}

const recordedRequests = async (request: APIRequestContext): Promise<RecordedRequest[]> => {
  const response = await request.get(`${mockProvidersURL}/__requests`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { requests: RecordedRequest[] }).requests
}

const login = async (request: APIRequestContext): Promise<void> => {
  const response = await request.post('/api/users/login', { data: E2E_USER })
  expect(response.ok()).toBe(true)
}

const ledgerEvent = async (
  request: APIRequestContext,
  field: 'eventKey' | 'transactionId',
  value: string,
): Promise<LedgerEvent> => {
  const response = await request.get('/api/conversion-events', {
    params: { [`where[${field}][equals]`]: value, depth: 0 },
  })
  expect(response.ok()).toBe(true)
  const { docs } = (await response.json()) as { docs: LedgerEvent[] }
  expect(docs).toHaveLength(1)
  return docs[0]
}

const submitLead = async (page: Page, name: string, email: string): Promise<string> => {
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Message').fill('Please call me back about pricing.')
  await page.getByRole('button', { name: 'Send request' }).click()
  const status = page.getByRole('status')
  await expect(status).toContainText('Thanks, we received request')
  const reference = /request (lead-[\da-f-]+)\./.exec((await status.textContent()) ?? '')?.[1]
  expect(reference).toBeDefined()
  return reference ?? ''
}

// Payload core admin views fail rules the plugin cannot fix (landmarks, list header contrast,
// unlabeled row checkboxes), so admin checks use WCAG A and AA and, on core list and edit views,
// cover only what the plugin renders. The harness storefront runs every rule on the whole page.
const expectAccessible = async (
  page: Page,
  scope: 'admin' | 'storefront',
  include?: string,
): Promise<void> => {
  const builder = new AxeBuilder({ page })
  if (include) {
    builder.include(include)
  }
  const results = await (
    scope === 'admin' ? builder.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']) : builder
  ).analyze()
  expect(
    results.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target.join(' ')),
    })),
  ).toEqual([])
}

test.describe.serial('capture, record and deliver', () => {
  let reference = ''
  let gclid = ''

  test('captures a paid click through the host proxy chain', async ({
    context,
    page,
  }, testInfo) => {
    gclid = gclidFor(testInfo.project.name)
    const port = process.env.PLAYWRIGHT_PORT ?? DEFAULT_E2E_PORT
    await context.addCookies([
      { name: 'session', domain: '127.0.0.1', path: '/', value: 'stale-session' },
    ])

    const landing = await page.goto(`/?gclid=${gclid}&utm_campaign=${campaign}`)
    expect(landing).not.toBeNull()
    const setCookies = ((await landing?.headersArray()) ?? [])
      .filter(({ name }) => name.toLowerCase() === 'set-cookie')
      .map(({ value }) => value)
    // Chromium does not expose Set-Cookie on this navigation's headers; its cookie jar below still proves both.
    if (testInfo.project.name !== 'chromium') {
      expect(setCookies).toEqual([
        'session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
        expect.stringMatching(/^attr_touch=[^;]+; Path=\/; Max-Age=\d+; SameSite=Lax$/),
      ])
    }
    if (process.env.PLAYWRIGHT_NEXT_MODE === 'dev') {
      testInfo.annotations.push({
        type: 'cache-control',
        description: 'skipped under next dev, which replaces Cache-Control on rendered pages',
      })
    } else {
      const cacheControl = landing?.headers()['cache-control'] ?? ''
      expect(cacheControl).toContain('private')
      expect(cacheControl).toContain('no-store')
    }

    const cookies = await context.cookies(`http://127.0.0.1:${port}`)
    expect(cookies.find(({ name }) => name === 'session')).toBeUndefined()
    expect(cookies.find(({ name }) => name === 'attr_touch')?.value).toBeTruthy()

    await page.goto('/', { referer: 'https://www.google.com/' })
    await expectAccessible(page, 'storefront')
    reference = await submitLead(page, 'Paid Visitor', `paid-${testInfo.project.name}@example.com`)
  })

  test('delivers the lead to GA4, Google Ads and Meta through Payload Jobs', async ({ page }) => {
    await runJobs(page.request, 'deliver')
    await runJobs(page.request, 'sweep')

    const requests = await recordedRequests(page.request)
    const ga4 = requests.filter(
      (entry) =>
        entry.provider === 'ga4' &&
        JSON.stringify(entry.body).includes(`"transaction_id":"${reference}"`),
    )
    expect(ga4).toHaveLength(1)
    expect(ga4[0].query).toEqual({ api_secret: 'mock-api-secret', measurement_id: 'G-MOCK000000' })
    expect(ga4[0].body).toMatchObject({
      events: [
        {
          name: 'generate_lead',
          params: { first_campaign: campaign, transaction_id: reference },
        },
      ],
    })

    const dataManager = requests.filter(
      (entry) =>
        entry.provider === 'dataManager' &&
        JSON.stringify(entry.body).includes(`"transactionId":"${reference}"`),
    )
    expect(dataManager).toHaveLength(1)
    expect(dataManager[0].authorization).toBe('Bearer mock-data-manager-token')
    expect(dataManager[0].body).toMatchObject({
      events: [{ adIdentifiers: { gclid }, transactionId: reference }],
      validateOnly: false,
    })
    expect(requests.some((entry) => entry.provider === 'dataManagerToken')).toBe(true)

    const meta = requests.filter(
      (entry) =>
        entry.provider === 'meta' &&
        JSON.stringify(entry.body).includes(`"order_id":"${reference}"`),
    )
    expect(meta).toHaveLength(1)
    expect(meta[0].body).toMatchObject({
      data: [
        {
          action_source: 'website',
          event_id: `lead:${reference}`,
          event_name: 'Lead',
          user_data: { em: expect.stringMatching(/^[\da-f]{64}$/) },
        },
      ],
      test_event_code: 'TEST00000',
    })

    await login(page.request)
    const event = await ledgerEvent(page.request, 'transactionId', reference)
    expect(event.attribution).toMatchObject({
      gclid,
      referrerHost: 'www.google.com',
      source: 'web',
    })
    expect(event.deliverySummary).toMatchObject({
      ga4: { status: 'sent' },
      googleAds: { status: 'sent' },
      meta: { status: 'sent' },
    })
  })

  test('shows deliveries in the admin and confirms before resending', async ({ page }) => {
    const consoleMessages: string[] = []
    page.on('console', (message) => consoleMessages.push(message.text()))
    page.on('pageerror', (error) => consoleMessages.push(error.message))

    await page.goto('/admin/login')
    await expectAccessible(page, 'admin')
    await page.getByLabel('Email').fill(E2E_USER.email)
    await page.getByLabel('Password', { exact: true }).fill(E2E_USER.password)
    await page.getByRole('button', { name: 'Login', exact: true }).click()
    await page.waitForURL((url) => !url.pathname.includes('/login'))

    await page.goto('/admin/collections/conversion-events')
    await expect(page.getByRole('heading', { name: 'Conversion events' })).toBeVisible()
    await expectAccessible(page, 'admin', '.cell-deliverySummary')

    const event = await ledgerEvent(page.request, 'transactionId', reference)
    await page.goto(`/admin/collections/conversion-events/${event.id}`)
    // The event view also renders the deliveries join field as a table, so scope to the plugin panel.
    const deliveries = page.locator('.attribution-deliveries-panel').getByRole('table', {
      name: 'Deliveries',
    })
    const ga4Row = deliveries
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: 'GA4', exact: true }) })
    await expect(ga4Row).toContainText('Sent')
    await expectAccessible(page, 'admin', '.attribution-deliveries-panel')

    const redeliveries: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/redeliver')) {
        redeliveries.push(request.postData() ?? '')
      }
    })

    const sendAgain = page.getByRole('button', { name: 'Send GA4 again' })
    await sendAgain.click()
    const dialog = page.getByRole('alertdialog', { name: 'Send GA4 again?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('can count the conversion twice')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    expect(redeliveries).toEqual([])

    await sendAgain.click()
    const resend = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().includes('/redeliver'),
    )
    await dialog.getByRole('button', { name: 'Send again' }).click()
    expect((await resend).status()).toBe(200)
    expect(JSON.parse(redeliveries[0] ?? '{}')).toEqual({ destinations: ['ga4'], force: true })
    await expect(page.getByText('GA4 delivery queued.')).toBeVisible()

    expect(consoleMessages.filter((text) => duplicateContextErrors.test(text))).toEqual([])
  })
})

test('protects the Google Ads feed with basic authentication', async ({ request }) => {
  const anonymous = await request.get('/api/attribution/google-ads/adjustments.csv')
  expect(anonymous.status()).toBe(401)
  expect(anonymous.headers()['www-authenticate']).toContain('Basic realm="attribution"')

  const credentials = Buffer.from(
    `${E2E_FEED_CREDENTIALS.username}:${E2E_FEED_CREDENTIALS.password}`,
  ).toString('base64')
  const authorized = await request.get('/api/attribution/google-ads/adjustments.csv', {
    headers: { authorization: `Basic ${credentials}` },
  })
  expect(authorized.status()).toBe(200)
  expect(authorized.headers()['content-type']).toContain('text/csv')
  expect(authorized.headers()['cache-control']).toContain('no-store')
  const [parameters, header] = (await authorized.text()).split('\n')
  expect(parameters).toBe('Parameters:TimeZone=UTC')
  expect(header).toBe(
    'Order ID,Conversion Name,Adjustment Time,Adjustment Type,Adjusted Value,Adjusted Value Currency',
  )
})

test.describe('Global Privacy Control', () => {
  test.use({ extraHTTPHeaders: { 'Sec-GPC': '1' } })

  test('records a lead without ad identifiers and with ad consent denied', async ({
    context,
    page,
  }, testInfo) => {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
        configurable: true,
        get: () => true,
      })
    })
    const port = process.env.PLAYWRIGHT_PORT ?? DEFAULT_E2E_PORT
    await context.addCookies([
      {
        name: '_fbp',
        domain: '127.0.0.1',
        path: '/',
        value: 'fb.1.1757000000000.1234567890',
      },
    ])

    const gclid = gclidFor(`g${testInfo.project.name}`)
    await page.goto(`/?gclid=${gclid}&fbclid=IwAR0e2eGpcClick&utm_campaign=${campaign}`)
    expect(
      await page.evaluate(
        () => (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl,
      ),
    ).toBe(true)
    const reference = await submitLead(
      page,
      'Private Visitor',
      `private-${testInfo.project.name}@example.com`,
    )

    await runJobs(page.request, 'deliver')
    await login(page.request)
    const event = await ledgerEvent(page.request, 'transactionId', reference)
    for (const key of clickIdKeys) {
      expect(event.attribution?.[key] ?? null, key).toBeNull()
    }
    expect(event.attribution?.utmCampaign).toBe(campaign)
    expect(event.consent).toMatchObject({ adPersonalization: 'denied', adUserData: 'denied' })
    expect(event.deliverySummary).toMatchObject({
      ga4: { status: 'sent' },
      googleAds: { reason: 'consent_denied', status: 'withheld' },
      meta: { reason: 'consent_denied', status: 'withheld' },
    })

    const requests = await recordedRequests(page.request)
    const mentions = requests.filter((entry) =>
      JSON.stringify(entry.body ?? null).includes(reference),
    )
    expect(mentions.map(({ provider }) => provider)).toEqual(['ga4'])
    expect(mentions[0].body).toMatchObject({
      consent: { ad_personalization: 'DENIED', ad_user_data: 'DENIED' },
    })
    expect(port).toBeTruthy()
  })

  test('denies ad consent from the Sec-GPC request header when the browser reports no GPC', async ({
    page,
  }, testInfo) => {
    await page.goto(`/?utm_campaign=${campaign}`)
    expect(
      await page.evaluate(
        () => (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl ?? false,
      ),
    ).toBe(false)
    const reference = await submitLead(
      page,
      'Header Only Visitor',
      `header-gpc-${testInfo.project.name}@example.com`,
    )

    await login(page.request)
    const event = await ledgerEvent(page.request, 'transactionId', reference)
    expect(event.consent).toMatchObject({ adPersonalization: 'denied', adUserData: 'denied' })
    expect(event.deliverySummary).toMatchObject({
      googleAds: { reason: 'consent_denied', status: 'withheld' },
      meta: { reason: 'consent_denied', status: 'withheld' },
    })
  })
})

test('runs the attribution CLI against the mock providers', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'the CLI does not depend on the browser')
  await login(request)
  const seeded = await ledgerEvent(request, 'eventKey', 'lead:demo')

  const payloadBin = fileURLToPath(new URL('../node_modules/.bin/payload', import.meta.url))
  const env = {
    ...process.env,
    ATTRIBUTION_E2E_ADMIN_TOKEN: MOCK_ADMIN_TOKEN,
    ATTRIBUTION_MOCK_PROVIDERS_URL: mockProvidersURL,
    ATTRIBUTION_SEED: 'false',
    DATABASE_URL: `file:./${E2E_DATABASE_FILE}`,
    PAYLOAD_CONFIG_PATH: 'dev/payload.config.ts',
  }
  const cli = async (args: string[]): Promise<unknown> => {
    const { stdout } = await execFileAsync(
      payloadBin,
      ['run', 'dev/scripts/attribution.ts', '--', ...args],
      {
        cwd: repoRoot,
        env,
        timeout: 90_000,
      },
    )
    return JSON.parse(stdout.slice(stdout.indexOf('{\n'))) as unknown
  }

  const verified = await cli(['verify', '--destination', 'ga4', '--event', String(seeded.id)])
  expect(verified).toEqual({
    details: {
      validationMessages: [
        expect.objectContaining({
          fieldPath: 'events[0].params.lead_source',
          validationCode: 'VALUE_REQUIRED',
        }),
      ],
    },
    ok: false,
  })

  const planned = await cli([
    'setup-ga4',
    '--plan',
    'dev/fixtures/ga4-plan.json',
    '--access-token-env',
    'ATTRIBUTION_E2E_ADMIN_TOKEN',
  ])
  expect(planned).toMatchObject({
    apply: false,
    missingDimensions: [
      { displayName: 'first campaign', parameterName: 'first_campaign', scope: 'EVENT' },
    ],
    missingKeyEvents: [{ countingMethod: 'ONCE_PER_EVENT', eventName: 'generate_lead' }],
  })

  const requests = await recordedRequests(request)
  const debug = requests.filter((entry) => entry.provider === 'ga4Debug')
  expect(debug.at(-1)?.body).toMatchObject({ validation_behavior: 'ENFORCE_RECOMMENDATIONS' })
  expect(debug.at(-1)?.query).not.toHaveProperty('validation_behavior')
  const admin = requests.filter((entry) => entry.provider === 'ga4Admin')
  expect(admin.length).toBeGreaterThanOrEqual(2)
  expect(admin.every((entry) => entry.method === 'GET')).toBe(true)
})
