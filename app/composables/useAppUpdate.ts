// SPDX-License-Identifier: GPL-3.0-or-later
import { detectHost } from '#core/platform/host.js'
import { evaluateOfflineSupport, type OfflineSupport } from '#core/platform/offline-support.js'
import { readBuildInfo, worthPrompting, type BuildInfo } from '#core/version/build.js'

/**
 * The offline install, and the update that has to follow it.
 *
 * `sw/worker.js` is what makes boofwang open without a network. This is the
 * other half, and it is the half with the hazard in it: a cache that never
 * refreshes is a codeplug editor frozen at whatever it understood about a radio
 * on the day it was installed. So the worker never activates itself, and this
 * file exists to notice a new one, say which one it is, and apply it only when
 * asked.
 *
 * **A reload is never taken.** Applying an update means reloading the page, and
 * a reload throws away a codeplug that has been read and edited but not yet
 * written. `AppUpdateNotice.vue` is where that cost gets priced; nothing here
 * reloads on its own.
 *
 * The one place in `app/` that knows about `navigator.serviceWorker`, in the
 * same way `useWebSerial` is the one place that knows about `navigator.serial`.
 */

/** How often a visible tab is allowed to ask the server whether it is stale. */
const CHECK_EVERY_MS = 15 * 60_000

/**
 * A long-lived visible tab still has to check.
 *
 * The visibility and online events below cover a laptop being opened and a
 * phone coming back into signal. Neither fires for a machine left on a bench
 * with the tab in front, which is a fair description of how this program gets
 * used for an afternoon.
 */
const POLL_EVERY_MS = 60 * 60_000

/** When this browser last managed to ask. Survives a reload; it is a fact about the device. */
const LAST_CHECKED_KEY = 'boofwang:update-checked-at'

/**
 * Give up waiting for the new worker to take over and reload anyway.
 *
 * `controllerchange` is the correct signal and it arrives in well under a
 * second. If it does not arrive at all the update has failed somewhere we
 * cannot see, and a reload is still the right move: it either picks up the new
 * worker or brings the prompt back, and both beat a button that spins forever.
 */
const APPLY_TIMEOUT_MS = 5_000

interface UpdateState {
  /**
   * Whether an offline copy is possible here, and why not if it is not.
   *
   * The reason matters more than the boolean: "you are already running the
   * installed application" and "this browser cannot do it" are the same false
   * and want opposite things said about them.
   */
  support: OfflineSupport
  /** A worker of ours is controlling the page: the app will open without a network. */
  offlineReady: boolean
  /** A newer worker is installed and waiting for permission to take over. */
  updateReady: boolean
  /** Which build the waiting worker would install, when it was able to say. */
  waitingBuild: BuildInfo | null
  checking: boolean
  applying: boolean
  /** ISO timestamp of the last completed check, from any tab on this device. */
  lastCheckedAt: string | null
  /** What went wrong registering or checking, in the browser's own words. */
  failure: string | null
}

/**
 * One registration per document, however many components ask for it.
 *
 * Module scope rather than per-caller state: the footer, the About page and the
 * banner all want this, and three registrations would mean three sets of
 * listeners and three reloads racing each other.
 */
const state = reactive<UpdateState>({
  // Until `start` runs there is no navigator to ask, and claiming support that
  // has not been established is the wrong way to be wrong.
  support: { supported: false, blocker: 'unsupported-browser', browser: 'your browser', advice: '' },
  offlineReady: false,
  updateReady: false,
  waitingBuild: null,
  checking: false,
  applying: false,
  lastCheckedAt: null,
  failure: null,
})

let registration: ServiceWorkerRegistration | null = null
let started = false

/**
 * Ask a worker which build it is, or give up.
 *
 * Worth the round trip: "a new version is ready" asks to be trusted, and
 * "0.1.1 · a1b2c3d is ready, you are running 0.1.0 · 9f8e7d6" can be checked
 * against the commit log. A worker that does not answer - an older one from
 * before this protocol existed - resolves to null and the notice says less
 * rather than nothing.
 */
function askBuild(worker: ServiceWorker): Promise<BuildInfo | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: BuildInfo | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), 2_000)
    const channel = new MessageChannel()
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer)
      const data = event.data as { type?: string, build?: unknown } | null
      finish(data?.type === 'boofwang:build' ? readBuildInfo(data.build) : null)
    }
    try {
      worker.postMessage({ type: 'boofwang:build' }, [channel.port2])
    } catch {
      clearTimeout(timer)
      finish(null)
    }
  })
}

/** Record a waiting worker, and find out what it is. */
async function noteWaiting(worker: ServiceWorker | null) {
  if (!worker) {
    state.updateReady = false
    state.waitingBuild = null
    return
  }
  state.updateReady = true
  state.waitingBuild = await askBuild(worker)
}

function markChecked() {
  state.lastCheckedAt = new Date().toISOString()
  try {
    localStorage.setItem(LAST_CHECKED_KEY, state.lastCheckedAt)
  } catch {
    // Private mode, or storage full. The timestamp is a nicety; losing it does
    // not stop anything from working.
  }
}

async function check(force = false) {
  if (!registration || state.checking) return
  if (!force && state.lastCheckedAt) {
    const since = Date.now() - new Date(state.lastCheckedAt).getTime()
    if (since >= 0 && since < CHECK_EVERY_MS) return
  }
  state.checking = true
  try {
    await registration.update()
    state.failure = null
    markChecked()
  } catch (e) {
    // Offline is the expected reason, and it is not a failure worth showing:
    // this whole feature is for people with no network. Anything else is.
    if (navigator.onLine) state.failure = e instanceof Error ? e.message : String(e)
  } finally {
    state.checking = false
    await noteWaiting(registration.waiting)
  }
}

/**
 * Hand the page over to the waiting worker.
 *
 * The worker will not call `skipWaiting` for itself; this message is the only
 * thing that makes it. The reload afterwards is what the caller has to have
 * decided is affordable.
 */
function apply() {
  const waiting = registration?.waiting
  if (!waiting || state.applying) return
  state.applying = true

  let reloaded = false
  const reload = () => {
    if (reloaded) return
    reloaded = true
    location.reload()
  }
  setTimeout(reload, APPLY_TIMEOUT_MS)
  navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true })
  waiting.postMessage({ type: 'boofwang:skip-waiting' })
}

async function register(baseURL: string) {
  try {
    registration = await navigator.serviceWorker.register(`${baseURL}sw.js`, { scope: baseURL })
  } catch (e) {
    // A site served over plain http, a blocked registration, a corrupt script.
    // Nothing else in the app depends on this succeeding.
    state.failure = e instanceof Error ? e.message : String(e)
    return
  }

  state.offlineReady = navigator.serviceWorker.controller !== null
  await noteWaiting(registration.waiting)

  /*
   * A worker arriving while the page is open.
   *
   * `updatefound` fires for the very first install too, and that one is not an
   * update: there is nothing to replace and nothing to prompt about. The
   * controller is what tells them apart - it is null until a worker has ever
   * taken over this page.
   */
  registration.addEventListener('updatefound', () => {
    const installing = registration?.installing
    if (!installing) return
    installing.addEventListener('statechange', () => {
      if (installing.state !== 'installed') return
      if (navigator.serviceWorker.controller === null) {
        state.offlineReady = true
        return
      }
      void noteWaiting(registration?.waiting ?? installing)
    })
  })

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    state.offlineReady = navigator.serviceWorker.controller !== null
  })

  void check(true)
}

/**
 * Register the worker and watch for a newer one.
 *
 * Called once, from the layout. Everything else calls `useAppUpdate()` and gets
 * the same state without starting a second registration.
 */
function start() {
  if (started) return
  started = true

  const config = useRuntimeConfig()
  const baseURL = config.app.baseURL.endsWith('/') ? config.app.baseURL : `${config.app.baseURL}/`

  /*
   * Whether to register at all, decided once, by a pure function that can be
   * checked against every combination. The case worth being careful about is
   * the desktop shell, which carries Chromium and registers its own scheme as
   * secure - so every naive check passes there, and a worker installed in front
   * of a packaged application is an offline cache that survives the application
   * being replaced.
   */
  const host = detectHost(typeof window === 'undefined' ? undefined : (window as { boofwang?: unknown }).boofwang)
  state.support = evaluateOfflineSupport(
    typeof navigator === 'undefined' ? undefined : navigator,
    typeof window !== 'undefined' && window.isSecureContext,
    host,
    import.meta.dev,
  )
  if (!state.support.supported) return

  try {
    state.lastCheckedAt = localStorage.getItem(LAST_CHECKED_KEY)
  } catch {
    /* storage unavailable; the check simply runs */
  }

  void register(baseURL)

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
  window.addEventListener('online', () => void check(true))
  setInterval(() => void check(), POLL_EVERY_MS)
}

/**
 * The running build, read from what the bundle carries.
 *
 * Separate from the update state because it is true whether or not this browser
 * supports service workers at all: the version has to be visible either way.
 */
export function useBuildInfo(): BuildInfo {
  const config = useRuntimeConfig()
  return readBuildInfo(config.public.build)
}

export function useAppUpdate() {
  onMounted(start)
  const running = useBuildInfo()
  return {
    state: readonly(state),
    /**
     * Whether there is an update worth telling somebody about.
     *
     * Derived here rather than in each component so the bar and the About page
     * cannot disagree - one saying an update is waiting while the other shows
     * nothing is exactly the sort of contradiction that makes a person stop
     * believing either. `worthPrompting` holds the reason a waiting worker is
     * sometimes not news.
     */
    pending: computed(() => state.updateReady && worthPrompting(running, state.waitingBuild)),
    /** Ask now, ignoring the throttle. The About page's button. */
    check: () => check(true),
    apply,
  }
}
