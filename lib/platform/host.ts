// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What kind of host boofwang is running in, and what that host can do.
 *
 * boofwang ships as a web app and as a desktop shell from one codebase. The
 * difference between them is expressed here, once, as capabilities rather than
 * as a build flag - so that a feature declares what it *needs* instead of which
 * build it belongs to. Nothing else in the codebase should branch on which host
 * it is running in; it should ask whether the capability it wants is present.
 *
 * Kept DOM-free like the rest of `lib/platform/`, so the reasoning is testable
 * without a browser and cannot drift into a component.
 */

export type HostKind = 'browser' | 'desktop'

export interface HostCapabilities {
  /**
   * Whether an arbitrary cross-origin HTTP request will succeed.
   *
   * False in a browser for any host that sends no `Access-Control-Allow-Origin`.
   * This is the only capability that gates a data source today, and it gates
   * exactly two of them - most of what boofwang reads is either CORS-open or
   * comes from a file the user exported themselves.
   */
  readonly crossOriginFetch: boolean
  /**
   * Whether backups can be written to a directory chosen by the user, through a
   * privileged process rather than through the browser's storage.
   *
   * The browser build reaches the same outcome by a different route - a
   * persisted `FileSystemDirectoryHandle` - so this being false does not mean
   * backups are less durable there.
   */
  readonly fileVault: boolean
  /**
   * Whether outbound requests can carry a `User-Agent` we choose.
   *
   * Browsers forbid setting it. No source currently in the registry requires
   * one: the requirement belonged to RepeaterBook, which is excluded on licence
   * grounds. Declared because the shell has the capability, not because
   * anything needs it - see `docs/provenance.md`.
   */
  readonly customUserAgent: boolean
}

export type HostCapability = keyof HostCapabilities

const BROWSER: HostCapabilities = {
  crossOriginFetch: false,
  fileVault: false,
  customUserAgent: false,
}

const DESKTOP: HostCapabilities = {
  crossOriginFetch: true,
  fileVault: true,
  customUserAgent: true,
}

export function capabilitiesFor(host: HostKind): HostCapabilities {
  return host === 'desktop' ? DESKTOP : BROWSER
}

/** Whether `host` can satisfy every capability in `needs`. */
export function hostSupports(host: HostKind, needs: readonly HostCapability[]): boolean {
  const caps = capabilitiesFor(host)
  return needs.every((n) => caps[n])
}

/**
 * Read the host kind from whatever the shell injected, failing closed.
 *
 * Anything other than the exact shape the preload promises resolves to
 * `'browser'`, the less capable answer. A missing preload, a partially
 * initialised bridge and a page opened in an ordinary tab are indistinguishable
 * from here and must all take the same path: a bug that guesses `'desktop'`
 * would offer a control that cannot work, which is worse than offering nothing.
 */
export function detectHost(injected: unknown): HostKind {
  if (typeof injected !== 'object' || injected === null) return 'browser'
  return (injected as { desktop?: unknown }).desktop === true ? 'desktop' : 'browser'
}
