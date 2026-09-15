import payloadConfig from '@payloadcms/eslint-config'
export default [
  ...payloadConfig,
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/payload-types.ts',
      '**/.next/**',
      'dev/app/(payload)/admin/importMap.js',
    ],
  },
  {
    rules: { 'no-restricted-exports': 'off' },
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['dev/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]
