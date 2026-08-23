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
        test: {
          name: 'electron',
          // The desktop shell, which is plain ESM with no DOM and no Electron
          // runtime - the serving rules are pure functions precisely so they
          // can be checked here rather than by launching a window.
          environment: 'node',
          include: ['test/electron/**/*.spec.ts'],
        },
      },
      {
        test: {
          name: 'sw',
          // The offline cache. Same reasoning as the electron project above:
          // the worker's rules are checked as code rather than by deploying a
          // site, installing it, taking the network away and looking. It is
          // evaluated in a fake worker scope, so no DOM and no browser.
          environment: 'node',
          include: ['test/sw/**/*.spec.ts'],
        },
      },
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
