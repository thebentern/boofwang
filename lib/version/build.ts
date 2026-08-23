// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Which build of boofwang is running, stated so a person can check it.
 *
 * A codeplug editor that has quietly gone stale is a hazard of its own: the
 * offsets under `lib/radios/` change when somebody works out that a byte meant
 * something else, and a browser holding a four-month-old copy of the app will
 * write the old understanding to a radio without hesitating. The offline cache
 * is what makes that possible, so the build identity has to be visible wherever
 * the cache reaches, which is everywhere.
 *
 * The identity is compiled into the bundle rather than fetched. That is the
 * point: a version read from a file at runtime can disagree with the code that
 * reads it, and the one case where it would - a cached bundle beside a fresh
 * manifest - is exactly the case this display exists to catch.
 *
 * Kept DOM-free like the rest of the core, so the formatting is testable
 * without a browser.
 */

export interface BuildInfo {
  /** `package.json` version. `'unknown'` when the build could not say. */
  readonly version: string
  /** Short commit hash, or `'unknown'` outside a git checkout. */
  readonly commit: string
  /**
   * ISO 8601 commit date, or `''` when unknown.
   *
   * The *commit* date, not the build clock. What gets asked of it is "how old
   * is the code I am running", and a four-month-old commit packaged an hour ago
   * would answer that with "an hour" - the reassuring answer and the wrong one.
   * It is deliberately not part of the build's identity; see `sameBuild`.
   */
  readonly committedAt: string
}

export const UNKNOWN_BUILD: BuildInfo = { version: 'unknown', commit: 'unknown', committedAt: '' }

/**
 * Read a build identity from whatever the bundle carries, failing closed.
 *
 * Anything other than the exact shape resolves to `UNKNOWN_BUILD`, in the same
 * spirit as `detectHost`. A footer that says `unknown` is honest; a footer that
 * throws takes the page with it over a string.
 */
export function readBuildInfo(raw: unknown): BuildInfo {
  if (typeof raw !== 'object' || raw === null) return UNKNOWN_BUILD
  const r = raw as Record<string, unknown>
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.length > 0 ? v : fallback)
  return {
    version: str(r.version, 'unknown'),
    commit: str(r.commit, 'unknown'),
    committedAt: str(r.committedAt, ''),
  }
}

/** `0.1.1 · a1b2c3d`, or the version alone when there is no commit to name. */
export function formatBuild(b: BuildInfo): string {
  return b.commit === 'unknown' ? b.version : `${b.version} · ${b.commit}`
}

/**
 * Whether two builds are the same code.
 *
 * The commit decides. A version number cannot tell two builds apart - every
 * commit between two releases carries the same one - and the update prompt is
 * about code, not about releases.
 */
export function sameBuild(a: BuildInfo, b: BuildInfo): boolean {
  return a.commit === b.commit && a.version === b.version
}

/**
 * Whether a worker waiting to install is worth interrupting somebody about.
 *
 * It is not always. Nuxt stamps the moment of prerendering into every shell it
 * emits, so two builds of one commit differ in their bytes, the service worker
 * written over them differs too, and the browser dutifully installs the second
 * as an update. Nothing has changed; a re-run of a CI job is enough to cause it.
 *
 * A prompt reading "0.1.1 · 936db45 is ready, you are running 0.1.1 · 936db45"
 * is worse than no prompt at all. It teaches the reader that the notice means
 * nothing, and the next one will be the one that mattered.
 *
 * A worker that cannot say what it is gets the benefit of the doubt: it is an
 * older build, from before this exchange existed, and being stale is the thing
 * worth being wrong about.
 */
export function worthPrompting(running: BuildInfo, waiting: BuildInfo | null): boolean {
  return waiting === null || !sameBuild(running, waiting)
}

/**
 * The commit on GitHub, or null when there is nothing there to link to.
 *
 * A hash and nothing else. `unknown` has no page, and neither does the
 * `abc1234-dirty` a local build from a modified tree carries: offering a link
 * that 404s is worse than offering none, because the reader concludes the
 * commit does not exist rather than that their own tree was not committed.
 */
export function commitUrl(b: BuildInfo, repo = 'https://github.com/thebentern/boofwang'): string | null {
  return /^[0-9a-f]{7,40}$/.test(b.commit) ? `${repo}/commit/${b.commit}` : null
}

/**
 * How long ago, in words, for a timestamp that may be absent or malformed.
 *
 * Two questions share this: how old the running code is, and how long since
 * this browser last managed to ask whether there was anything newer. The first
 * is answered in days and the second in minutes, so the scale runs from "just
 * now" up to years - but only ever one unit, because the reader is deciding
 * whether to worry, not doing arithmetic.
 */
export function describeAge(iso: string, now: Date = new Date()): string | null {
  if (!iso) return null
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null

  /*
   * A clock behind the timestamp gets "just now" rather than a special case.
   * It happens on machines whose time is wrong, which includes a field laptop
   * that has been off for a month - the population this feature is for.
   */
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`

  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`

  const months = Math.floor(days / 30)
  if (months < 12) return months === 1 ? 'a month ago' : `${months} months ago`

  const years = Math.floor(days / 365)
  return years === 1 ? 'a year ago' : `${years} years ago`
}
