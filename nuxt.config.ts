// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url'
import { buildInfo } from './scripts/build-info.mjs'

// Icons referenced from RadioSchema/FieldSpec *data* cannot be found by the
// client-bundle scanner (it only sees statically written names). With
// `fallbackToApi: false` an unscanned icon renders blank, so every schema-driven
// name must be listed here. `test/app/icon-coverage.spec.ts` enforces that.
const SCHEMA_ICONS = [
  'lucide:antenna',
  'lucide:arrow-right',
  'lucide:audio-waveform',
  'lucide:arrow-up-down',
  'lucide:arrow-up-right',
  'lucide:badge-check',
  'lucide:binary',
  'lucide:bluetooth',
  'lucide:box',
  'lucide:bug',
  'lucide:cable',
  'lucide:check',
  'lucide:chevron-down',
  'lucide:chevron-up',
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
        // viewport-fit=cover lets the mobile shell paint under the notch and
        // the home indicator; the layout then pads by env(safe-area-inset-*).
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        {
          name: 'description',
          content:
            'Browser-based codeplug editor and programmer for the Quansheng UV-K5, Baofeng UV-82, Baofeng UV-5R Mini and Baofeng DM-32UV. Runs entirely in your browser over Web Serial.',
        },
        /*
         * Tints the browser chrome on mobile to match the app's own surface.
         *
         * These are `--bg` from `app/assets/css/main.css` in each theme, and
         * they have to stay that. Installed to a home screen the app fills the
         * display and the chrome sits directly against the page: the two values
         * that used to be here were close to the page but not equal to it, and
         * the difference reads as a seam along the top edge of a phone.
         */
        { name: 'theme-color', content: '#141A22', media: '(prefers-color-scheme: dark)' },
        { name: 'theme-color', content: '#F2F5F8', media: '(prefers-color-scheme: light)' },
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
        /*
         * What makes the app installable, alongside the service worker written
         * by `scripts/build-service-worker.mjs`. Its `start_url` and `scope`
         * are `/` for the same reason the hrefs above have no prefix, and it
         * would need the same treatment for a repository-subpath build.
         */
        { rel: 'manifest', href: '/manifest.webmanifest' },
      ],
    },
  },

  /**
   * Which build this is, compiled in.
   *
   * Not fetched at runtime, deliberately. The offline cache makes it possible
   * for a browser to hold an old copy of the app indefinitely, and a version
   * number read from a file could then disagree with the code reading it -
   * which is the one situation the version display exists to catch. Baked into
   * the bundle, it cannot.
   *
   * `scripts/build-info.mjs` is the single reading of git; the service worker
   * gets its copy from the same function so the footer and the update prompt
   * cannot tell different stories.
   */
  runtimeConfig: { public: { build: buildInfo() } },

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
