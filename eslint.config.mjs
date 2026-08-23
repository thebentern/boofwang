// SPDX-License-Identifier: GPL-3.0-or-later
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    ignores: ['.nuxt/**', '.output/**', 'dist/**', 'node_modules/**', 'vendor/**', 'public/presets/**'],
  },
  {
    // lib/ is the framework-agnostic core. Keeping it pure is what lets the
    // drivers be unit-tested in plain Node and reused outside Nuxt later.
    // Enforced mechanically, because "please don't import Vue here" is not a
    // constraint that survives contact with a deadline.
    files: ['lib/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['vue', 'vue/*'], message: 'lib/ must stay framework-agnostic.' },
            { group: ['pinia', '@pinia/*'], message: 'lib/ must stay framework-agnostic.' },
            { group: ['#app', '#app/*', '#imports', 'nuxt', 'nuxt/*', '@nuxt/*'], message: 'lib/ must stay framework-agnostic.' },
            { group: ['~/*', '@/*', '~~/*'], message: 'lib/ must not reach into app/.' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.vue'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The service worker template. It runs in a scope that has neither a window
    // nor a module system, and two of the four placeholders
    // `scripts/build-service-worker.mjs` fills in stand where an expression
    // goes rather than inside a string - so they read as undefined globals
    // here, by design, and this is the only file that may say so.
    files: ['sw/**/*.js'],
    languageOptions: {
      globals: {
        __BOOFWANG_BUILD__: 'readonly',
        __BOOFWANG_PRECACHE__: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        self: 'readonly',
      },
    },
  },
)
