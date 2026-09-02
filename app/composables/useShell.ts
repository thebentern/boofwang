// SPDX-License-Identifier: GPL-3.0-or-later
import { detectHost, type HostKind } from '#core/platform/host.js'
import type { ShellBridge } from '#core/platform/shell.js'

/**
 * Which host boofwang is running in, and the bridge that host injected.
 *
 * The one reader of `window.boofwang`. The desktop preload and the mobile
 * shell both leave their bridge there before the page runs, and `detectHost`
 * fails closed on anything else, so an ordinary tab, a half-initialised bridge
 * and a prerender with no `window` at all answer `'browser'`. Decided once and
 * cached: the answer cannot change within a page's lifetime, and reading it
 * lazily rather than at module scope is what keeps the prerender alive.
 *
 * Three files used to carry their own copy of this cast. A third shell is the
 * point at which that stops being harmless.
 */
let cached: { host: HostKind; bridge: ShellBridge | null } | null = null

export function useShell(): { host: HostKind; bridge: ShellBridge | null } {
  if (cached) return cached
  const injected = typeof window === 'undefined' ? undefined : (window as { boofwang?: unknown }).boofwang
  const host = detectHost(injected)
  const bridge = host === 'browser' ? null : (injected as ShellBridge)
  // The browser answer is cached too, but only once there is a window to have
  // asked. Before that the answer is a placeholder, not a fact.
  if (typeof window !== 'undefined') cached = { host, bridge }
  return { host, bridge }
}
