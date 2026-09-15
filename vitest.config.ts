import { defineConfig } from 'vitest/config'

const source = (path: string) => new URL(path, import.meta.url).pathname

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'dev/**/*.test.ts', 'scripts/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 120000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/__tests__/**', 'src/exports/**', '**/types.ts'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
  resolve: {
    alias: [
      { find: /^payload-plugin-attribution$/, replacement: source('./src/index.ts') },
      {
        find: /^payload-plugin-attribution\/(client|next|browser)$/,
        replacement: source('./src/exports/$1.ts'),
      },
    ],
  },
})
