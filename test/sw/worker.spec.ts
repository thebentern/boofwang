// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { addAllInit, fetched, FakeRequest, loadWorker, ORIGIN } from './scope.js'

/**
 * What the offline cache will and will not do.
 *
 * The two ways a service worker in front of this program does harm are serving
 * a stale application and serving stale data, and both are worse than being
 * offline: an old build writes an old understanding of a radio's memory, and a
 * cached repeater directory puts somebody on a frequency that moved. Every test
 * here is one of those two, or the reload that must not happen by itself.
 */

const nav = (path: string) => new FakeRequest(path, { mode: 'navigate' })
const get = (path: string) => new FakeRequest(path)

describe('installing', () => {
  it('stores everything the build shipped', async () => {
    const sw = loadWorker({ revision: 'aaa111' })
    await sw.install()

    const cache = sw.caches.named.get('boofwang-aaa111')
    expect(cache, 'the cache is named for the revision, so two builds cannot share one').toBeDefined()
    expect([...cache!.entries.keys()].sort()).toEqual([
      `${ORIGIN}/404.html`,
      `${ORIGIN}/_nuxt/entry.abc123.js`,
      `${ORIGIN}/favicon.svg`,
      `${ORIGIN}/index.html`,
    ])
  })

  it('bypasses the browser cache for every entry', async () => {
    // Without `cache: 'reload'` the install may be served out of the HTTP
    // cache, which is how a fresh install ends up holding the previous build's
    // index.html - the exact failure the worker exists to prevent, arriving
    // through the front door.
    const sw = loadWorker()
    await sw.install()
    expect(addAllInit.length).toBeGreaterThan(0)
    expect(addAllInit.every((r) => r.cache === 'reload')).toBe(true)
  })

  it('stores nothing at all when one file is missing', async () => {
    // Atomic on purpose. Half a build in the cache serves some of one and some
    // of another, and nothing anywhere reports it.
    const sw = loadWorker({ precache: ['/index.html', '/gone.js'], revision: 'ccc333' })
    fetched.delete('/gone.js')

    await expect(sw.install()).rejects.toThrow(/gone\.js/)
    expect(sw.caches.named.get('boofwang-ccc333')?.entries.size ?? 0).toBe(0)
  })

  it('does not take over the page', async () => {
    // No `skipWaiting` in the install handler: activating means reloading, and
    // a reload discards a codeplug that has been edited and not yet written.
    const sw = loadWorker()
    await sw.install()
    expect(sw.skipWaitingCalls()).toBe(0)
  })
})

describe('activating', () => {
  it('deletes every earlier build of boofwang and claims the page', async () => {
    const sw = loadWorker({ revision: 'bbb222' })
    await sw.caches.open('boofwang-aaa111')
    await sw.caches.open('boofwang-000000')
    await sw.install()
    await sw.activate()

    expect(await sw.caches.keys()).toEqual(['boofwang-bbb222'])
    expect(sw.claimed()).toBe(true)
  })

  it('leaves caches it does not own alone', async () => {
    // The app stores backups in IndexedDB rather than the Cache API, but the
    // rule matters anyway: a worker that reaps by prefix must have a prefix.
    const sw = loadWorker({ revision: 'bbb222' })
    await sw.caches.open('something-else')
    await sw.install()
    await sw.activate()
    expect((await sw.caches.keys()).sort()).toEqual(['boofwang-bbb222', 'something-else'])
  })
})

describe('what it refuses to handle', () => {
  it('passes cross-origin requests straight through', async () => {
    // The whole live data layer. hearham, RadioID and the BrandMeister device
    // list are fetched at runtime and none of them may ever come out of a
    // cache: a repeater that changed frequency six months ago is a licence
    // problem, not a convenience problem.
    const sw = loadWorker()
    await sw.install()
    for (const url of [
      'https://api.brandmeister.network/v2/device',
      'https://radioid.net/static/rptrs.json',
      'https://hearham.com/api/repeaters/v1',
    ]) {
      expect(await sw.fetchEvent(new FakeRequest(url)), url).toBeNull()
    }
  })

  it('passes anything that is not a GET straight through', async () => {
    const sw = loadWorker()
    await sw.install()
    expect(await sw.fetchEvent(new FakeRequest('/index.html', { method: 'POST' }))).toBeNull()
  })

  it('passes range requests straight through', async () => {
    // A partial response assembled by hand out of the Cache API is a corrupt
    // file, and nothing boofwang ships is range-fetched anyway.
    const sw = loadWorker()
    await sw.install()
    expect(await sw.fetchEvent(new FakeRequest('/index.html', { headers: { Range: 'bytes=0-99' } }))).toBeNull()
  })

  it('passes same-origin files the build did not ship straight through', async () => {
    // The cache holds exactly what this build emitted. Nothing is added to it
    // opportunistically, so nothing can survive into a build it did not belong
    // to.
    const sw = loadWorker({ serve: { '/uploaded-later.json': 'live' } })
    await sw.install()
    expect(await sw.fetchEvent(get('/uploaded-later.json'))).toBeNull()
  })

})

describe('what it serves', () => {
  it('answers any route with the shell, so deep links work offline', async () => {
    const sw = loadWorker()
    await sw.install()
    sw.online = false

    for (const path of ['/', '/channels', '/dmr', '/backups/anything']) {
      const response = await sw.fetchEvent(nav(path))
      expect(response?.body, path).toBe('body of /index.html')
    }
  })

  it('serves precached assets from the cache', async () => {
    const sw = loadWorker()
    await sw.install()
    sw.online = false
    expect((await sw.fetchEvent(get('/_nuxt/entry.abc123.js')))?.body).toBe('body of /_nuxt/entry.abc123.js')
    expect((await sw.fetchEvent(get('/favicon.svg')))?.body).toBe('body of /favicon.svg')
  })

  it('says so, in words, when the shell has been evicted and there is no network', async () => {
    // The alternative is a blank window, which is the least informative symptom
    // a program can have. Storage pressure is the only way to get here, since
    // the install is atomic.
    const sw = loadWorker()
    await sw.install()
    sw.caches.named.clear()
    sw.online = false

    const response = await sw.fetchEvent(nav('/channels'))
    expect(response?.status).toBe(503)
    expect(response?.body).toContain('boofwang is offline')
    expect(response?.body, 'the build is named, so the page is still diagnosable').toContain('0.1.1 · a1b2c3d')
  })

  it('falls back to the network when the shell has been evicted but there is one', async () => {
    const sw = loadWorker()
    await sw.install()
    sw.caches.named.clear()
    expect((await sw.fetchEvent(nav('/channels')))?.body).toBe('body of /index.html')
  })
})

describe('under a base path', () => {
  it('scopes the shell and the precache to it', async () => {
    // A build for `<user>.github.io/boofwang/` rather than for boofwa.ng.
    const sw = loadWorker({ base: '/boofwang/', precache: ['/boofwang/index.html', '/boofwang/_nuxt/e.js'] })
    await sw.install()
    sw.online = false
    expect((await sw.fetchEvent(nav('/boofwang/channels')))?.body).toBe('body of /boofwang/index.html')
    expect((await sw.fetchEvent(get('/boofwang/_nuxt/e.js')))?.body).toBe('body of /boofwang/_nuxt/e.js')
  })
})

describe('talking to the page', () => {
  it('steps aside only when asked', async () => {
    const sw = loadWorker()
    expect(sw.skipWaitingCalls()).toBe(0)
    sw.message({ type: 'boofwang:skip-waiting' })
    expect(sw.skipWaitingCalls()).toBe(1)
  })

  it('ignores a message it does not recognise', async () => {
    const sw = loadWorker()
    sw.message({ type: 'skipWaiting' })
    sw.message(null)
    sw.message('boofwang:skip-waiting')
    expect(sw.skipWaitingCalls()).toBe(0)
  })

  it('names the build it would install', async () => {
    // So the prompt can say "0.1.1 · a1b2c3d is ready" rather than "an update
    // is available", which asks to be trusted.
    const sw = loadWorker({ build: { version: '0.2.0', commit: 'feedbee', committedAt: '2026-08-22T10:00:00Z' } })
    expect(sw.message({ type: 'boofwang:build' })).toEqual({
      type: 'boofwang:build',
      build: { version: '0.2.0', commit: 'feedbee', committedAt: '2026-08-22T10:00:00Z' },
    })
  })
})
