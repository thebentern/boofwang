// SPDX-License-Identifier: GPL-3.0-or-later
import { loadSource, SourceUnavailableError } from '#core/data/load.js'
import { availableSources, unreachableSources } from '#core/data/registry.js'
import type { SourceQuery, SourceResult, TalkGroupResult } from '#core/data/source.js'
import { detectHost, type HostKind } from '#core/platform/host.js'

/**
 * Reaching the repeater directories.
 *
 * The one place in `app/` that knows a desktop shell might exist, in the same
 * way `useWebSerial` is the one place that knows about `navigator.serial`.
 * Everything else asks this what is available and gets an answer that is already
 * correct for the host it is running on.
 */

/**
 * Which host this is, decided once.
 *
 * `detectHost` fails closed, so a missing preload, a half-initialised bridge and
 * an ordinary browser tab all answer `'browser'`. Read lazily rather than at
 * module scope because the build prerenders these pages with no `window` at all.
 */
let host: HostKind | null = null
function currentHost(): HostKind {
  host ??= detectHost(typeof window === 'undefined' ? undefined : (window as { boofwang?: unknown }).boofwang)
  return host
}

/**
 * The whole BrandMeister device list, held for the session.
 *
 * Its endpoint rejects query parameters, so a search means fetching all 33,000
 * records - about 10 MB. Doing that per keystroke would be indefensible on a
 * phone tether at a hilltop, which is exactly where somebody programmes a radio.
 * Held per source id, dropped when the tab goes.
 */
const responseCache = new Map<string, unknown>()

async function cachedJson(url: string): Promise<unknown> {
  const hit = responseCache.get(url)
  if (hit !== undefined) return hit
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`${new URL(url).host} answered ${res.status}.`)
  }
  const body: unknown = await res.json()
  responseCache.set(url, body)
  return body
}

export function useDataSources() {
  const kind = computed<HostKind>(() => currentHost())

  /** What this host can use. The only list the interface should render as usable. */
  const available = computed(() => availableSources(kind.value))

  /**
   * Sources that exist and this host cannot reach.
   *
   * Rendered once, as a statement about the host. A source switched off in the
   * registry appears in neither list: withdrawn is not the same as unreachable,
   * and nobody should be told to install an app to reach something boofwang has
   * stopped offering.
   */
  const unreachable = computed(() => unreachableSources(kind.value))

  const isDesktop = computed(() => kind.value === 'desktop')

  async function fetchRepeaters(sourceId: string, query: SourceQuery): Promise<SourceResult> {
    const impl = await loadSource(sourceId, kind.value)
    return impl.fetchRepeaters(cachedJson, query)
  }

  async function fetchTalkGroups(sourceId: string): Promise<TalkGroupResult> {
    const impl = await loadSource(sourceId, kind.value)
    if (!impl.fetchTalkGroups) {
      return {
        talkGroups: [],
        issues: [{ ref: sourceId, severity: 'error', message: `${sourceId} does not publish talk groups.` }],
      }
    }
    return impl.fetchTalkGroups(cachedJson)
  }

  return { host: kind, isDesktop, available, unreachable, fetchRepeaters, fetchTalkGroups }
}

export { SourceUnavailableError }
