import tseslint from 'typescript-eslint'
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '**/dist/**',
      'node_modules/**',
      '**/node_modules/**',
      '.turbo/**',
      'scripts/**',
      'platforms/**',
      'shared/**',
      'eval-results/**',
      '**/public/**',
      '**/*.d.ts',
      '**/shim/**',
      '*.config.js',
      '*.config.ts',
      '**/drizzle.config.ts',
      'fix-vite-bin.js',
      '**/scripts/**',
      '**/e2e/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.ts', '*.js', '*.tsx'],
        },
      },
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'prefer-const': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
