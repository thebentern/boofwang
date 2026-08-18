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
)
