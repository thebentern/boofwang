// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url'

// Icons referenced from RadioSchema/FieldSpec *data* cannot be found by the
// client-bundle scanner (it only sees statically written names). With
// `fallbackToApi: false` an unscanned icon renders blank, so every schema-driven
// name must be listed here. `test/app/icon-coverage.spec.ts` enforces that.
const SCHEMA_ICONS = [
  'lucide:radio',
  'lucide:radio-tower',
  'lucide:antenna',
  'lucide:cable',
  'lucide:download',
  'lucide:upload',
  'lucide:save',
  'lucide:file-down',
  'lucide:file-up',
  'lucide:list',
  'lucide:layers',
  'lucide:users',
  'lucide:key',
  'lucide:key-round',
  'lucide:lock',
  'lucide:unlock',
  'lucide:shield',
  'lucide:shield-alert',
  'lucide:triangle-alert',
  'lucide:circle-alert',
  'lucide:circle-check',
  'lucide:info',
  'lucide:settings',
  'lucide:sliders-horizontal',
  'lucide:toggle-left',
  'lucide:hash',
  'lucide:type',
  'lucide:binary',
  'lucide:volume-2',
  'lucide:signal',
  'lucide:gauge',
  'lucide:history',
  'lucide:trash-2',
  'lucide:plus',
  'lucide:pencil',
  'lucide:search',
  'lucide:filter',
  'lucide:chevron-right',
  'lucide:chevron-down',
  'lucide:external-link',
  'lucide:refresh-cw',
  'lucide:play',
  'lucide:square',
  'lucide:flask-conical',
]

export default defineNuxtConfig({
  compatibilityDate: '2026-08-01',

  // A Web Serial tool cannot be usefully server-rendered, and a single app
  // shell is what GitHub Pages serves best.
  ssr: false,

  // Writes .nojekyll (without it Jekyll strips /_nuxt/) and prerenders 404.html,
  // which is what makes deep links work on Pages.
  nitro: { preset: 'github-pages' },

  app: {
    // Project pages are served from /boofwang/ - BOTH slashes are required.
    // CI overrides this with the base_path reported by actions/configure-pages.
    baseURL: process.env.NUXT_APP_BASE_URL || '/boofwang/',
    head: {
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content:
            'Browser-based codeplug editor and programmer for the Quansheng UV-K5, Baofeng UV-5R Mini and Baofeng DM-32UV. Runs entirely in your browser over Web Serial.',
        },
      ],
    },
  },

  modules: ['@nuxt/ui', '@pinia/nuxt', '@vueuse/nuxt', '@nuxt/eslint'],

  css: ['~/assets/css/main.css'],

  // Never reach out to api.iconify.design at runtime: people program radios in
  // the field with no network.
  icon: {
    fallbackToApi: false,
    clientBundle: { scan: true, includeCustomCollections: true, icons: SCHEMA_ICONS, sizeLimitKb: 512 },
  },

  // The framework-agnostic core lives outside app/ and is imported as #core.
  alias: { '#core': fileURLToPath(new URL('./lib', import.meta.url)) },

  // typecheck runs as its own CI step rather than inside the dev/build loop.
  typescript: { typeCheck: false },

  experimental: { payloadExtraction: false },

  devtools: { enabled: true },
})
