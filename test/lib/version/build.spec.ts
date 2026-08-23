// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  commitUrl,
  describeAge,
  formatBuild,
  readBuildInfo,
  sameBuild,
  UNKNOWN_BUILD,
  worthPrompting,
  type BuildInfo,
} from '#core/version/build.js'

const build = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  version: '0.1.1',
  commit: 'a1b2c3d',
  committedAt: '2026-08-20T09:00:00Z',
  ...over,
})

describe('reading what the bundle carries', () => {
  it('takes the shape it expects', () => {
    expect(readBuildInfo({ version: '0.2.0', commit: 'deadbee', committedAt: '2026-01-01T00:00:00Z' })).toEqual({
      version: '0.2.0',
      commit: 'deadbee',
      committedAt: '2026-01-01T00:00:00Z',
    })
  })

  it('fails closed on anything else', () => {
    // The footer saying `unknown` is honest. The footer throwing takes the page
    // with it, over a string nobody was reading anyway.
    for (const bad of [undefined, null, 'a string', 42, [], { version: 3 }]) {
      expect(readBuildInfo(bad).version).toBe('unknown')
    }
    expect(readBuildInfo(null)).toEqual(UNKNOWN_BUILD)
  })

  it('fills in only the fields that are missing', () => {
    expect(readBuildInfo({ version: '0.3.0' })).toEqual({ version: '0.3.0', commit: 'unknown', committedAt: '' })
  })

  it('treats an empty string as absent', () => {
    expect(readBuildInfo({ version: '', commit: '' }).version).toBe('unknown')
  })
})

describe('naming a build', () => {
  it('is the version and the commit', () => {
    expect(formatBuild(build())).toBe('0.1.1 · a1b2c3d')
  })

  it('drops the commit when there is not one', () => {
    expect(formatBuild(build({ commit: 'unknown' }))).toBe('0.1.1')
  })
})

describe('telling two builds apart', () => {
  it('is decided by the commit, not the version', () => {
    // Every commit between two releases carries the same version number. A
    // prompt that fired only on a version change would sit silent through a
    // month of driver fixes.
    expect(sameBuild(build(), build({ commit: '9f8e7d6' }))).toBe(false)
    expect(sameBuild(build(), build())).toBe(true)
  })

  it('ignores the commit date, which is not part of the identity', () => {
    expect(sameBuild(build(), build({ committedAt: '2020-01-01T00:00:00Z' }))).toBe(true)
  })
})

describe('deciding whether to interrupt somebody', () => {
  it('prompts for a build that is not the one running', () => {
    expect(worthPrompting(build(), build({ commit: '9f8e7d6' }))).toBe(true)
    expect(worthPrompting(build(), build({ version: '0.2.0' }))).toBe(true)
  })

  it('stays quiet when the waiting worker is the build already running', () => {
    /*
     * This happens. Nuxt stamps the moment of prerendering into every shell it
     * emits, so a second build of one commit differs in its bytes, the worker
     * written over it differs too, and the browser installs it as an update.
     * Nothing has changed. A prompt saying so teaches people that the bar means
     * nothing, and the next one is the one that mattered.
     */
    expect(worthPrompting(build(), build())).toBe(false)
    expect(worthPrompting(build(), build({ committedAt: '2020-01-01T00:00:00Z' }))).toBe(false)
  })

  it('prompts when the waiting worker will not say what it is', () => {
    // An older build, from before the exchange existed. Being stale is the
    // thing worth being wrong about.
    expect(worthPrompting(build(), null)).toBe(true)
  })
})

describe('linking a commit', () => {
  it('links a real hash', () => {
    expect(commitUrl(build())).toBe('https://github.com/thebentern/boofwang/commit/a1b2c3d')
  })

  it('declines anything that is not one', () => {
    // A dirty local build carries `a1b2c3d-dirty`. Linking it would 404, and a
    // reader concludes the commit was deleted rather than never committed.
    expect(commitUrl(build({ commit: 'a1b2c3d-dirty' }))).toBeNull()
    expect(commitUrl(build({ commit: 'unknown' }))).toBeNull()
    expect(commitUrl(build({ commit: 'zzzzzzz' }))).toBeNull()
  })
})

describe('how long ago', () => {
  const now = new Date('2026-08-23T12:00:00Z')
  const ago = (ms: number) => describeAge(new Date(now.getTime() - ms).toISOString(), now)

  it('counts in one unit at a time', () => {
    expect(ago(5_000)).toBe('just now')
    expect(ago(60_000)).toBe('a minute ago')
    expect(ago(9 * 60_000)).toBe('9 minutes ago')
    expect(ago(3_600_000)).toBe('an hour ago')
    expect(ago(5 * 3_600_000)).toBe('5 hours ago')
    expect(ago(86_400_000)).toBe('yesterday')
    expect(ago(4 * 86_400_000)).toBe('4 days ago')
    expect(ago(45 * 86_400_000)).toBe('a month ago')
    expect(ago(200 * 86_400_000)).toBe('6 months ago')
    expect(ago(400 * 86_400_000)).toBe('a year ago')
    expect(ago(1000 * 86_400_000)).toBe('2 years ago')
  })

  it('says just now for a clock that is behind', () => {
    // A field laptop that has been off for a month comes back with a wrong
    // clock often enough that "in 3 days" would be a real thing to render.
    expect(ago(-86_400_000)).toBe('just now')
  })

  it('has nothing to say about an absent or malformed date', () => {
    expect(describeAge('', now)).toBeNull()
    expect(describeAge('not a date', now)).toBeNull()
  })
})
