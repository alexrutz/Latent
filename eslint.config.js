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
      /*
       * The vendored ComfyUI nodes are not part of this app.
       *
       * `comfyllama/` is a copy of alexrutz/comfyllama, kept here so the two
       * can be changed together and copied straight into
       * `ComfyUI/custom_nodes/`. Its one JavaScript file is a ComfyUI frontend
       * extension: it imports from `../../scripts/`, which only resolves inside
       * ComfyUI, and lives by ComfyUI's conventions rather than by this repo's.
       * Linting it here would be judging it against the wrong rules.
       */
      'comfyllama/**',
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
