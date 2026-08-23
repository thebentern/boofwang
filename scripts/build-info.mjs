// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Who this build is, asked once.
 *
 * Two things need the answer and they must not disagree: `nuxt.config.ts` bakes
 * it into the bundle so the footer can state what is running, and
 * `scripts/build-service-worker.mjs` writes it into the worker so the update
 * prompt can name what it would install. Two readings of `git` in two files is
 * how those drift, and a footer that disagrees with the worker is worse than no
 * footer at all - it is a wrong answer to the one question this feature exists
 * to answer.
 *
 * Everything degrades to a string rather than throwing. A build from a
 * downloaded tarball has no `.git`, and refusing to build for that would be
 * absurd; it says `unknown` and carries on.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/**
 * The commit, and whether the tree it was built from matched it.
 *
 * A dirty build is labelled `abc1234-dirty`. It is the common case locally and
 * the label is what stops somebody reporting a bug against a commit hash that
 * describes code they had already changed. `commitUrl` in `lib/version/build.ts`
 * declines to link it, because there is nothing on GitHub to link to.
 *
 * `GITHUB_SHA` is the fallback for a CI checkout with no usable git directory.
 */
function commit() {
  const short = git('rev-parse', '--short=7', 'HEAD')
  if (!short) {
    const env = process.env.GITHUB_SHA ?? ''
    return env.length >= 7 ? env.slice(0, 7) : 'unknown'
  }
  return git('status', '--porcelain').length > 0 ? `${short}-dirty` : short
}

/**
 * @returns {{ version: string, commit: string, committedAt: string }}
 */
export function buildInfo() {
  let version = 'unknown'
  try {
    version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'
  } catch {
    /* no package.json is not a reason to fail a build */
  }

  /*
   * The commit date, not the clock the packager ran on.
   *
   * The question this answers on screen is "how old is the code I am running",
   * and a build clock answers a different one. A four-month-old commit built an
   * hour ago would report itself as an hour old, which is the reassuring answer
   * and the wrong one.
   */
  return { version, commit: commit(), committedAt: git('log', '-1', '--format=%cI') }
}
