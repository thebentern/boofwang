// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { assertFetchable } from '#core/platform/fetchable.js'
// @ts-expect-error - the shell is plain ESM JavaScript, deliberately untyped.
import { assertFetchable as electronAssertFetchable } from '../../../electron/site.mjs'

/**
 * The fetch rule exists twice: once in `lib/platform/fetchable.ts` for the app
 * bundle and once in `electron/site.mjs`, which Node runs with no TypeScript
 * loader and so cannot import the first. This runs both over the same URLs so
 * that they cannot drift - a scheme one shell allows and the other refuses is
 * a hole in exactly the place the same-origin policy is not standing.
 */

const both = [
  ['lib', assertFetchable],
  ['electron', electronAssertFetchable as typeof assertFetchable],
] as const

const ALLOWED = [
  'https://hearham.com/api/repeaters/v1',
  'https://radioid.net/api/dmr/user/?id=1',
  'https://localhost/',
  'https://localhost:8443/api',
  'https://user:secret@example.com/',
]

const REFUSED = [
  'http://hearham.com/api',
  'http://localhost:3000/',
  'file:///etc/passwd',
  'ftp://example.com/file',
  'javascript:alert(1)',
  'app://boofwang/index.html',
  'data:application/json,1',
]

describe.each(both)('assertFetchable in %s', (_where, check) => {
  it('allows https and returns the parsed URL', () => {
    for (const url of ALLOWED) {
      expect(check(url).protocol, url).toBe('https:')
      expect(check(url).href, url).toBe(new URL(url).href)
    }
  })

  it('refuses every other scheme by name', () => {
    for (const url of REFUSED) {
      expect(() => check(url), url).toThrow(/https only/)
    }
  })

  it('refuses something that is not a URL at all', () => {
    expect(() => check('not a url')).toThrow(/is not a URL/)
    expect(() => check('')).toThrow(/is not a URL/)
  })
})

describe('the two copies agree', () => {
  it('give the same verdict on every URL, allowed or not', () => {
    const verdict = (check: typeof assertFetchable, url: string): string => {
      try {
        return `ok ${check(url).href}`
      } catch (e) {
        return `throw ${(e as Error).message}`
      }
    }
    for (const url of [...ALLOWED, ...REFUSED, 'not a url', '']) {
      expect(verdict(electronAssertFetchable as typeof assertFetchable, url), url).toBe(verdict(assertFetchable, url))
    }
  })
})
