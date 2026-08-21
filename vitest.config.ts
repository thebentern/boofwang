// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const core = fileURLToPath(new URL('./lib', import.meta.url))
const app = fileURLToPath(new URL('./app', import.meta.url))

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
      {
        resolve: { alias: { '#core': core, '~': app } },
        test: {
          // Specs that import from app/ rather than only reading it as text.
          //
          // They live under test/nuxt/ because that is the directory Nuxt's
          // generated tsconfig already claims for app-side tests: a spec
          // anywhere else in test/ belongs to the framework-free core project,
          // which by design cannot see app/ at all and refuses to compile a
          // file that imports from it. Nothing here needs a Nuxt runtime - the
          // codeplug store is a Pinia setup store and plain Vue reactivity.
          name: 'nuxt',
          environment: 'node',
          include: ['test/nuxt/**/*.spec.ts'],
        },
      },
      {
        resolve: { alias: { '#core': core } },
        test: {
          name: 'hardware',
          environment: 'node',
          // Needs a radio on a cable and `pnpm bridge` running. The specs skip
          // themselves unless BOOFWANG_HW is set, so this is inert in CI.
          include: ['test/hardware/**/*.spec.ts'],
          testTimeout: 1_800_000,
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
