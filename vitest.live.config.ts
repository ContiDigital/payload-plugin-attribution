import { defineConfig } from 'vitest/config'

const source = (path: string) => new URL(path, import.meta.url).pathname

export default defineConfig({
  test: {
    environment: 'node',
    hookTimeout: 120_000,
    include: ['dev/live.spec.ts'],
    testTimeout: 60_000,
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
