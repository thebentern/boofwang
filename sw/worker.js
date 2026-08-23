// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The offline cache.
 *
 * boofwang self-hosts its fonts and refuses to call api.iconify.design because
 * radios get programmed where there is no network - and then the site itself
 * needed the network to load, which made both of those gestures rather than
 * measures. The desktop build answered it for a laptop. It does nothing for a
 * phone talking Bluetooth to a UV-5R Mini in a field, and that is the case this
 * file is for.
 *
 * **The rules are deliberately narrow.** A service worker in front of a program
 * that writes to radios can do two kinds of harm, and both are worse than being
 * offline:
 *
 *   1. Serve a stale application. The offsets under `lib/radios/` change when
 *      somebody works out that a byte meant something else, and an old copy
 *      writes the old understanding to somebody's radio. So a cache belongs to
 *      exactly one build, every other cache is deleted on activation, and the
 *      running build is named in the footer where it can be checked.
 *
 *   2. Serve stale *data*. The repeater directories, the BrandMeister device
 *      list and the RadioID database are all live, all cross-origin, and none
 *      of them should ever come out of a cache this file controls. A repeater
 *      that moved frequency six months ago is a licence problem, not a
 *      convenience problem.
 *
 * So this worker serves exactly what the build shipped and nothing else. It
 * never populates the cache opportunistically, never touches a cross-origin
 * request, and never touches anything that is not a GET. Four rules, in
 * `handlerFor` below, and a request that matches none of them is passed
 * through untouched as though this file were not installed.
 *
 * **It never updates itself without being told to.** `skipWaiting` is behind a
 * message, because applying an update means reloading the page and a reload
 * discards a codeplug that has been edited but not yet written. The interface
 * decides when that is acceptable; see `app/composables/useAppUpdate.ts`.
 *
 * A classic script, not a module: module service workers still are not
 * supported everywhere, and this file has no imports to justify the cost. The
 * four constants below are placeholders, filled in by
 * `scripts/build-service-worker.mjs` - which is also what makes this file's own
 * bytes change when the build changes, and a service worker whose bytes never
 * change is one the browser never replaces.
 */

/** @type {{ version: string, commit: string, committedAt: string }} */
const BUILD = __BOOFWANG_BUILD__

/**
 * A digest of the build identity and every precached path.
 *
 * The cache is keyed on this rather than on the version so that a rebuild whose
 * assets differ cannot land in the cache a previous build filled - which is the
 * one way a per-version cache goes half stale, and it happens on any build from
 * a dirty tree, where the commit alone says nothing changed.
 */
const REVISION = '__BOOFWANG_REVISION__'

/** The site's base path, with a trailing slash. `/` on boofwa.ng. */
const SCOPE = '__BOOFWANG_SCOPE__'

/** Every file the build emitted, as absolute paths under SCOPE. */
const PRECACHE = __BOOFWANG_PRECACHE__

const CACHE = `boofwang-${REVISION}`

/** Every cache this file has ever owned, for reaping the ones that are not CACHE. */
const CACHE_PREFIX = 'boofwang-'

/**
 * The single page this app is.
 *
 * `ssr: false` means every route is served by the same shell, so a navigation
 * to /channels offline is answered with the shell and the router takes the path
 * from the URL, exactly as GitHub Pages does it with 404.html.
 */
const SHELL = `${SCOPE}index.html`

const PRECACHED = new Set(PRECACHE)

/**
 * What this worker will do with a request, or null to leave it alone.
 *
 * Separated from the fetch handler so the rules can be read as a list. Order
 * matters: a navigation is answered with the shell whether or not its own path
 * was ever a file, which is what makes deep links work offline.
 *
 * @param {Request} request
 * @param {string} origin - the worker's own origin
 * @returns {'shell' | 'precached' | null}
 */
function handlerFor(request, origin) {
  if (request.method !== 'GET') return null

  /*
   * A range request cannot be answered from the Cache API without slicing the
   * body by hand, and a partial response assembled wrongly is a corrupt file.
   * Nothing boofwang ships is range-fetched; let the network have them.
   */
  if (request.headers && request.headers.get('range')) return null

  let url
  try {
    url = new URL(request.url)
  } catch {
    return null
  }

  // Cross-origin is the whole live data layer: repeater directories, the
  // BrandMeister list, RadioID. None of it may ever come from this cache.
  if (url.origin !== origin) return null

  if (request.mode === 'navigate') return 'shell'
  return PRECACHED.has(url.pathname) ? 'precached' : null
}

/** Cache names this worker owns but no longer wants. */
function staleCaches(names, current) {
  return names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== current)
}

/**
 * What a navigation gets when there is neither a cache nor a network.
 *
 * A blank window is the least informative symptom a program can have, and it is
 * what this would otherwise be: the shell is precached atomically, so reaching
 * here means the browser evicted the cache under storage pressure. Saying so
 * costs a few hundred bytes and turns an unexplained blank page into an
 * instruction.
 */
function offlineShell() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>boofwang is offline</title>'
      + '<style>body{font:15px/1.6 system-ui,sans-serif;background:#141A22;color:#EAF0F6;'
      + 'margin:0;display:grid;place-items:center;min-height:100vh;padding:24px}'
      + 'main{max-width:34em}code{color:#F29559}</style>'
      + '<main><h1>boofwang is offline</h1>'
      + '<p>The offline copy of the app is not on this device, and there is no network to '
      + 'fetch it from. Reload once you are back on a network and it will be stored again.</p>'
      + `<p><code>${BUILD.version} · ${BUILD.commit}</code></p></main>`,
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

async function respondWithShell() {
  const cached = await caches.match(SHELL, { cacheName: CACHE })
  if (cached) return cached
  try {
    return await fetch(SHELL)
  } catch {
    return offlineShell()
  }
}

/**
 * Cache first, because everything precached belongs to this build.
 *
 * `_nuxt/` assets carry a content hash in the name and can never change under
 * a path; the rest - fonts, icons, the manifest - are replaced wholesale by the
 * next build under its own cache name. So a hit is always the right bytes, and
 * a miss means eviction rather than staleness.
 */
async function respondFromCache(request) {
  const cached = await caches.match(request, { cacheName: CACHE })
  return cached ?? fetch(request)
}

/*
 * Wiring. Guarded so this file can be evaluated by its tests, which drive the
 * handlers directly rather than through a browser.
 */
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('install', (event) => {
    /*
     * `cache: 'reload'` on every entry. Without it `addAll` may be served from
     * the browser's own HTTP cache, which is how a "fresh" install ends up
     * holding the previous build's index.html - the exact failure this whole
     * file exists to prevent, arriving through the front door.
     *
     * `addAll` is atomic: one 404 and nothing is stored. That is the failure
     * mode to want. A half-filled cache serves some of one build and some of
     * another, and no error anywhere says so.
     *
     * Note what is *not* here: `skipWaiting`. A new worker waits until the page
     * asks for it, because activating means reloading and a reload throws away
     * unwritten edits.
     */
    event.waitUntil(
      caches
        .open(CACHE)
        .then((cache) => cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' })))),
    )
  })

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((names) => Promise.all(staleCaches(names, CACHE).map((n) => caches.delete(n))))
        .then(() => self.clients.claim()),
    )
  })

  self.addEventListener('fetch', (event) => {
    const how = handlerFor(event.request, self.location.origin)
    // Not calling respondWith at all is what "pass through untouched" means:
    // the request goes to the network as though nothing were installed.
    if (how === null) return
    event.respondWith(how === 'shell' ? respondWithShell() : respondFromCache(event.request))
  })

  self.addEventListener('message', (event) => {
    const type = event.data && event.data.type

    // The page has decided the reload is safe. Until this arrives, a new worker
    // sits in `waiting` and the running build keeps serving.
    if (type === 'boofwang:skip-waiting') self.skipWaiting()

    // Which build this worker would install, so the prompt can name it rather
    // than saying "an update" and asking to be trusted.
    if (type === 'boofwang:build' && event.ports && event.ports[0]) {
      event.ports[0].postMessage({ type: 'boofwang:build', build: BUILD })
    }
  })
}
