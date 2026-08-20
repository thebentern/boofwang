// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url'

// Icons referenced from RadioSchema/FieldSpec *data* cannot be found by the
// client-bundle scanner (it only sees statically written names). With
// `fallbackToApi: false` an unscanned icon renders blank, so every schema-driven
// name must be listed here. `test/app/icon-coverage.spec.ts` enforces that.
const SCHEMA_ICONS = [
  'lucide:antenna',
  'lucide:arrow-right',
  'lucide:arrow-up-down',
  'lucide:binary',
  'lucide:box',
  'lucide:bug',
  'lucide:cable',
  'lucide:check',
  'lucide:chevron-down',
  'lucide:chevron-right',
  'lucide:circle-alert',
  'lucide:circle-check',
  'lucide:circle-dot',
  'lucide:circle-minus',
  'lucide:circle-x',
  'lucide:clock',
  'lucide:coffee',
  'lucide:columns-3',
  'lucide:cpu',
  'lucide:crosshair',
  'lucide:dot',
  'lucide:download',
  'lucide:external-link',
  'lucide:eye',
  'lucide:eye-off',
  'lucide:file-down',
  'lucide:file-up',
  'lucide:filter',
  'lucide:flask-conical',
  'lucide:folder',
  'lucide:folder-tree',
  'lucide:gauge',
  'lucide:git-branch',
  'lucide:globe',
  'lucide:hash',
  'lucide:heart',
  'lucide:history',
  'lucide:info',
  'lucide:key',
  'lucide:key-round',
  'lucide:laptop',
  'lucide:layers',
  'lucide:list',
  'lucide:loader-circle',
  'lucide:lock',
  'lucide:lock-open',
  'lucide:mic',
  'lucide:minus',
  'lucide:monitor',
  'lucide:moon',
  'lucide:palette',
  'lucide:pencil',
  'lucide:play',
  'lucide:plus',
  'lucide:power',
  'lucide:radio',
  'lucide:radio-tower',
  'lucide:refresh-cw',
  'lucide:rows-3',
  'lucide:satellite',
  'lucide:save',
  'lucide:scale',
  'lucide:scan-line',
  'lucide:search',
  'lucide:server',
  'lucide:settings',
  'lucide:shield',
  'lucide:shield-alert',
  'lucide:signal',
  'lucide:sliders-horizontal',
  'lucide:square',
  'lucide:square-mouse-pointer',
  'lucide:sun',
  'lucide:toggle-left',
  'lucide:trash-2',
  'lucide:triangle-alert',
  'lucide:type',
  'lucide:unlock',
  'lucide:upload',
  'lucide:usb',
  'lucide:users',
  'lucide:volume-2',
  'lucide:x',
  'lucide:zap',
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
    /**
     * Served from the root of boofwa.ng.
     *
     * A custom domain serves the site at `/`, not at `/<repo>/`. The CNAME file
     * in `public/` is what tells GitHub Pages that, and it has to travel in the
     * built artifact - which is why it lives in `public/` rather than being set
     * only in the repository settings, where a redeploy can drop it.
     *
     * `NUXT_APP_BASE_URL` still overrides, so a build for the bare
     * `<user>.github.io/boofwang/` URL is one environment variable away.
     */
    baseURL: process.env.NUXT_APP_BASE_URL || '/',
    head: {
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content:
            'Browser-based codeplug editor and programmer for the Quansheng UV-K5, Baofeng UV-82, Baofeng UV-5R Mini and Baofeng DM-32UV. Runs entirely in your browser over Web Serial.',
        },
        // Tints the browser chrome on mobile to match the app's own surface.
        { name: 'theme-color', content: '#101315', media: '(prefers-color-scheme: dark)' },
        { name: 'theme-color', content: '#f7f8f8', media: '(prefers-color-scheme: light)' },
      ],
      /*
       * Icons are served from the site root.
       *
       * Nuxt does not prefix head hrefs with `app.baseURL`, so these are only
       * correct while the site is served from the root of its own domain -
       * which the CNAME and the pinned NUXT_APP_BASE_URL together guarantee.
       * A build for a repository subpath would need these prefixed too.
       *
       * The SVG carries both themes and is what modern browsers use; the .ico
       * is a three-size fallback and is also what gets requested at /favicon.ico
       * whether or not it is declared.
       */
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', type: 'image/x-icon', sizes: '16x16 32x32 48x48', href: '/favicon.ico' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
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
