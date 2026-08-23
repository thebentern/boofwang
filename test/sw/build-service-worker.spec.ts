// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error - the build scripts are plain ESM JavaScript, deliberately untyped.
import { buildServiceWorker, precacheList, renderWorker, revisionOf } from '../../scripts/build-service-worker.mjs'

/**
 * What goes into the worker, and what makes it change.
 *
 * Both halves are load-bearing. A precache list that quietly stops matching
 * `_nuxt/` gives a site that works perfectly until the network goes; a revision
 * that does not change when the build does gives a browser that never installs
 * the fix.
 */

const TEMPLATE = readFileSync(fileURLToPath(new URL('../../sw/worker.js', import.meta.url)), 'utf8')

const INFO = { version: '0.1.1', commit: 'a1b2c3d', committedAt: '2026-08-20T09:00:00Z' }

/** Directories made by the round-trip test below, removed however it ends. */
const temporary: string[] = []
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

describe('choosing what to precache', () => {
  const emitted = [
    '.nojekyll',
    '404.html',
    'CNAME',
    '_nuxt/entry.abc123.js',
    '_nuxt/entry.abc123.js.map',
    '_nuxt/ibm-plex-sans-400.def456.woff2',
    'favicon.svg',
    'index.html',
    'manifest.webmanifest',
    'sw.js',
  ]

  it('takes everything the build emitted', () => {
    // Not a hand-written list of globs. The one maintained by hand is the one
    // that stops matching the day a Nuxt release renames a directory, and the
    // symptom is invisible until somebody is offline.
    const list = precacheList(emitted)
    expect(list).toContain('/index.html')
    expect(list).toContain('/404.html')
    expect(list).toContain('/_nuxt/entry.abc123.js')
    expect(list).toContain('/_nuxt/ibm-plex-sans-400.def456.woff2')
    expect(list).toContain('/favicon.svg')
    expect(list).toContain('/manifest.webmanifest')
  })

  it('leaves out the worker itself', () => {
    // A cached worker pins the site to one build permanently: the browser
    // compares the worker's own bytes to decide whether to install a new one,
    // and it cannot compare bytes it is being handed out of a cache.
    expect(precacheList(emitted)).not.toContain('/sw.js')
  })

  it('leaves out the deployment markers and the source maps', () => {
    const list = precacheList(emitted)
    expect(list).not.toContain('/.nojekyll')
    expect(list).not.toContain('/CNAME')
    expect(list).not.toContain('/_nuxt/entry.abc123.js.map')
  })

  it('applies the base path the site is served from', () => {
    expect(precacheList(['index.html', '_nuxt/e.js'], '/boofwang/')).toEqual([
      '/boofwang/index.html',
      '/boofwang/_nuxt/e.js',
    ])
  })

  it('tolerates a base path without its trailing slash', () => {
    expect(precacheList(['index.html'], '/boofwang')).toEqual(['/boofwang/index.html'])
  })
})

describe('the revision', () => {
  const read = (contents: Record<string, string>) => (path: string) => contents[path] ?? ''

  it('changes when a file changes but its name does not', () => {
    /*
     * The one that matters. Most of `_nuxt/` carries a content hash in its
     * filename, but index.html, favicon.svg and manifest.webmanifest do not -
     * so a revision computed from names alone would stay put after an edit to
     * any of them, the worker's own bytes would stay put, and the browser would
     * never install the build containing the change.
     */
    const files = ['/index.html', '/favicon.svg']
    const before = revisionOf(INFO, files, read({ '/index.html': 'one', '/favicon.svg': 'a' }))
    const after = revisionOf(INFO, files, read({ '/index.html': 'two', '/favicon.svg': 'a' }))
    expect(after).not.toBe(before)
  })

  it('changes when the commit changes', () => {
    const files = ['/index.html']
    const contents = read({ '/index.html': 'one' })
    expect(revisionOf({ ...INFO, commit: '9f8e7d6' }, files, contents)).not.toBe(revisionOf(INFO, files, contents))
  })

  it('is a function of the inputs and nothing else', () => {
    /*
     * No clock, no counter, no randomness. Which is as far as determinism goes
     * here and worth being precise about: Nuxt stamps the moment of prerendering
     * into every shell it emits, so a second build of one commit does produce
     * different bytes and therefore a different revision. `worthPrompting` in
     * `lib/version/build.ts` is what stops that reaching a person as an update
     * that is not one.
     */
    const files = ['/index.html', '/_nuxt/e.js']
    const contents = read({ '/index.html': 'one', '/_nuxt/e.js': 'two' })
    expect(revisionOf(INFO, files, contents)).toBe(revisionOf(INFO, files, contents))
  })

  it('is short enough to read out loud', () => {
    expect(revisionOf(INFO, [], read({}))).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('rendering the worker', () => {
  const render = (template = TEMPLATE) =>
    renderWorker(template, {
      info: INFO,
      revision: 'abc123abc123',
      base: '/',
      precache: ['/index.html', '/_nuxt/e.js'],
    }) as string

  it('leaves no placeholder behind', () => {
    expect(render()).not.toMatch(/__BOOFWANG_/)
  })

  it('writes the build in as data, not as a string', () => {
    const out = render()
    expect(out).toContain('const BUILD = {"version":"0.1.1","commit":"a1b2c3d","committedAt":"2026-08-20T09:00:00Z"}')
    expect(out).toContain('const REVISION = "abc123abc123"')
    expect(out).toContain('const SCOPE = "/"')
    expect(out).toContain('const PRECACHE = ["/index.html","/_nuxt/e.js"]')
  })

  it('keeps the licence header, because the file ships', () => {
    expect(render().startsWith('// SPDX-License-Identifier: GPL-3.0-or-later')).toBe(true)
  })

  it('writes the same bytes when run twice over the same site', () => {
    /*
     * The step runs after `nuxt build`, into the directory it just read - so
     * the second run sees the worker the first one wrote. If that changed the
     * answer, every deploy would ship a worker whose bytes differ for no
     * reason, every browser would install it, and everybody would be told an
     * update was ready that contained nothing. `sw.js` staying out of both the
     * precache list and the revision is what prevents it, and neither is
     * obvious from reading either function alone.
     */
    const dir = mkdtempSync(join(tmpdir(), 'boofwang-sw-'))
    temporary.push(dir)
    mkdirSync(join(dir, '_nuxt'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="__nuxt"></div>')
    writeFileSync(join(dir, '_nuxt', 'entry.abc123.js'), 'console.log(1)')
    writeFileSync(join(dir, '.nojekyll'), '')

    const first = buildServiceWorker(dir)
    const bytes = readFileSync(join(dir, 'sw.js'), 'utf8')
    const second = buildServiceWorker(dir)

    expect(second.revision).toBe(first.revision)
    expect(readFileSync(join(dir, 'sw.js'), 'utf8')).toBe(bytes)
    expect(first.precache).toEqual(['/_nuxt/entry.abc123.js', '/index.html'])
    expect(bytes).not.toMatch(/__BOOFWANG_/)
  })

  it('refuses a template that has lost a placeholder', () => {
    /*
     * A silent no-op here produces a worker holding the literal string
     * `__BOOFWANG_REVISION__`, which parses, installs, and caches the build
     * under a cache named after a placeholder - so the next build does not
     * evict it and the site is pinned to whichever one arrived first.
     */
    expect(() => render(TEMPLATE.replace('__BOOFWANG_REVISION__', 'oops'))).toThrow(/__BOOFWANG_REVISION__/)
  })
})
