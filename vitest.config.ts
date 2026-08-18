// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const core = fileURLToPath(new URL('./lib', import.meta.url))

export default defineConfig({
  resolve: { alias: { '#core': core } },
  test: {
    projects: [
      {
        resolve: { alias: { '#core': core } },
        test: {
          name: 'core',
          // No DOM globals: a stray `document` reference in lib/ fails here
          // rather than in someone's browser.
          environment: 'node',
          include: ['test/lib/**/*.spec.ts'],
        },
      },
      {
        resolve: { alias: { '#core': core } },
        test: {
          name: 'app',
          environment: 'node',
          include: ['test/app/**/*.spec.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.d.ts'],
      reporter: ['text', 'lcov'],
    },
  },
})
