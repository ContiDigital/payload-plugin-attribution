import { defineConfig, devices } from '@playwright/test'

import {
  DEFAULT_E2E_PORT,
  DEFAULT_MOCK_PROVIDERS_PORT,
  E2E_DATABASE_FILE,
} from './dev/e2eConstants.js'

const port = (name: string, fallback: string): string => {
  const value = process.env[name] ?? fallback
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`)
  }
  return value
}

const appPort = port('PLAYWRIGHT_PORT', DEFAULT_E2E_PORT)
const mockPort = port('PLAYWRIGHT_MOCK_PORT', DEFAULT_MOCK_PROVIDERS_PORT)
// next dev replaces the proxy's Cache-Control on rendered pages; production serving keeps it.
const nextMode = process.env.PLAYWRIGHT_NEXT_MODE === 'dev' ? 'dev' : 'start'
const baseURL = `http://127.0.0.1:${appPort}`
const mockProvidersURL = `http://127.0.0.1:${mockPort}`

export default defineConfig({
  testDir: './dev',
  testMatch: 'e2e.spec.ts',
  // Every project shares one SQLite database and one mock provider log.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm dev:mock-providers',
      env: { MOCK_PROVIDERS_PORT: mockPort },
      reuseExistingServer: false,
      url: `${mockProvidersURL}/__health`,
    },
    {
      command: nextMode === 'dev' ? 'pnpm dev:e2e' : 'pnpm dev:e2e:start',
      env: {
        ATTRIBUTION_E2E: 'true',
        ATTRIBUTION_MOCK_PROVIDERS_URL: mockProvidersURL,
        ATTRIBUTION_RUN_JOBS: 'false',
        DATABASE_URL: `file:./${E2E_DATABASE_FILE}`,
        PLAYWRIGHT_NEXT_MODE: nextMode,
        PLAYWRIGHT_PORT: appPort,
      },
      reuseExistingServer: false,
      timeout: 420_000,
      url: `${baseURL}/admin/login`,
    },
  ],
})
