import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'data/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase leans on inference; explicit return types everywhere is noise.
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['server/**/*.ts', 'scripts/**/*.mjs', 'e2e/**/*.ts', '*.ts', '*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The mock server, build scripts and e2e tests are tools, not shipped code.
    files: ['server/src/mock/**', 'scripts/**', 'e2e/**'],
    rules: { 'no-console': 'off' },
  },
);
