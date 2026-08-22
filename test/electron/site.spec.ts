// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - the shell is plain ESM JavaScript, deliberately untyped.
import { assertFetchable, contentTypeFor, headersFor, resolveSitePath, respondFor } from '../../electron/site.mjs'

/**
 * The desktop shell's serving rules.
 *
 * These exist because verifying them the other way - launch a windowed
 * application, wait, read its console - turned out to be unreliable enough to
 * be worthless: the same build rendered on one run and came up blank on the
 * next, and the console said nothing either time. Both real bugs in this shell
 * were in the rules below, and both presented identically as "the window is
 * blank", which is the least informative symptom a program can have.
 *
 * So the rules are pure functions over a path and a reader, and this runs in
 * the ordinary suite on every machine that checks out the repository, including
 * the ones with no display.
 */

const ROOT = '/srv/site'

describe('which file a request path means', () => {
  it('serves a real file when the path names one', () => {
    expect(resolveSitePath('/_nuxt/entry.abc123.js', ROOT)).toBe(join(ROOT, '_nuxt/entry.abc123.js'))
    expect(resolveSitePath('/favicon.ico', ROOT)).toBe(join(ROOT, 'favicon.ico'))
  })

  it('answers a route with the shell, so the router can take it', () => {
    // A single-page build: /channels is not a file and never was. Answering 404
    // here is how a desktop build ends up with working links and a blank page
    // on reload.
    for (const route of ['/', '/channels', '/dmr', '/startup-image', '/backups']) {
      expect(resolveSitePath(route, ROOT), route).toBe(join(ROOT, 'index.html'))
    }
  })

  it('refuses to climb out of the site root', () => {
    // The request comes from a page this shell loaded, so this is not the usual
    // hostile-input case - but the cost of being wrong is reading a user's
    // files into a renderer.
    for (const escape of ['/../etc/passwd', '/../../etc/passwd', '/_nuxt/../../../etc/passwd']) {
      expect(resolveSitePath(escape, ROOT), escape).toBeNull()
    }
  })

  it('refuses an encoded traversal, which normalising alone would not catch', () => {
    expect(resolveSitePath('/%2e%2e/%2e%2e/etc/passwd', ROOT)).toBeNull()
  })

  it('refuses a malformed escape rather than throwing', () => {
    // decodeURIComponent throws on a lone %; a throw inside the protocol
    // handler takes down the request with no status at all.
    expect(resolveSitePath('/%', ROOT)).toBeNull()
    expect(resolveSitePath('/a%zz', ROOT)).toBeNull()
  })

  it('refuses an embedded NUL', () => {
    expect(resolveSitePath('/index.html\0.png', ROOT)).toBeNull()
  })

  it('keeps a path that merely starts with the root’s name outside it', () => {
    // `/srv/site-other` is not inside `/srv/site`, and a plain startsWith
    // without the separator would say it is.
    expect(resolveSitePath('/../site-other/secret.txt', ROOT)).toBeNull()
  })
})

describe('what a served file says it is', () => {
  it('names the types a Nuxt build actually emits', () => {
    expect(contentTypeFor('/x/entry.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/x/entry.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('/x/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/x/font.woff2')).toBe('font/woff2')
    expect(contentTypeFor('/x/icon.svg')).toBe('image/svg+xml')
  })

  it('falls back rather than guessing wrong', () => {
    expect(contentTypeFor('/x/thing.bin')).toBe('application/octet-stream')
  })

  it('sends a CORS header even though the origin is its own', () => {
    /*
     * This looks redundant and is not, and it is the bug that cost the most to
     * find. Nuxt emits its module preloads and its stylesheet with
     * `crossorigin`, which puts those requests in CORS mode whatever the
     * origin. Without this header every module is rejected, and what the user
     * sees is a window that finished loading, has the right origin, has
     * `navigator.serial`, and is completely blank.
     */
    expect(headersFor('/x/entry.js')['access-control-allow-origin']).toBe('*')
    expect(headersFor('/x/index.html')['access-control-allow-origin']).toBe('*')
  })
})

describe('answering a request', () => {
  const files = new Map([
    [join(ROOT, 'index.html'), '<!doctype html><title>boofwang</title>'],
    [join(ROOT, '_nuxt/entry.js'), 'export default 1'],
  ])
  const read = async (f: string) => {
    const hit = files.get(f)
    if (hit === undefined) throw new Error('ENOENT')
    return hit
  }

  it('returns the file with its type and the CORS header', async () => {
    const r = await respondFor('/_nuxt/entry.js', ROOT, read)
    expect(r.status).toBe(200)
    expect(r.body).toBe('export default 1')
    expect(r.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(r.headers['access-control-allow-origin']).toBe('*')
  })

  it('returns the shell for a route', async () => {
    const r = await respondFor('/channels', ROOT, read)
    expect(r.status).toBe(200)
    expect(String(r.body)).toContain('boofwang')
  })

  it('404s a file that is not there, rather than throwing', async () => {
    const r = await respondFor('/_nuxt/missing.js', ROOT, read)
    expect(r.status).toBe(404)
    expect(r.body).toBeNull()
  })

  it('404s a traversal without reading anything', async () => {
    let touched = false
    const spy = async (f: string) => { touched = true; return read(f) }
    const r = await respondFor('/../../etc/passwd', ROOT, spy)
    expect(r.status).toBe(404)
    expect(touched, 'it tried to read the file it had already refused').toBe(false)
  })
})

describe('what the shell will fetch for the page', () => {
  /*
   * This is the shell's whole reason to exist and the one place a URL chosen by
   * the renderer reaches the network with no same-origin policy in front of it.
   * hearham and RadioID send no `Access-Control-Allow-Origin`, so a browser tab
   * cannot read them at any price - and that is exactly why this has to stay
   * narrow rather than becoming a general proxy.
   */
  it('allows https', () => {
    expect(assertFetchable('https://hearham.com/api/repeaters/v1').protocol).toBe('https:')
    expect(assertFetchable('https://radioid.net/api/dmr/user/?id=1').host).toBe('radioid.net')
  })

  it('refuses every other scheme, including the ones that read local files', () => {
    for (const url of [
      'http://hearham.com/api',
      'file:///etc/passwd',
      'app://boofwang/index.html',
      'data:application/json,1',
    ]) {
      expect(() => assertFetchable(url), url).toThrow(/https only/)
    }
  })

  it('refuses something that is not a URL at all', () => {
    expect(() => assertFetchable('not a url')).toThrow(/is not a URL/)
  })
})

describe('against the site this repository actually generates', () => {
  /*
   * The rules above are exercised against a fake filesystem, which cannot say
   * whether they match what Nuxt emits. This one reads the real build when it
   * is present - and skips rather than fails when it is not, because a fresh
   * checkout has no `.output`.
   */
  const site = fileURLToPath(new URL('../../.output/public', import.meta.url))
  const generated = async () => {
    try {
      await readFile(join(site, 'index.html'))
      return true
    } catch {
      return false
    }
  }

  it('serves the real index and the assets its HTML asks for', async () => {
    if (!(await generated())) return
    const index = await respondFor('/', site, readFile)
    expect(index.status).toBe(200)
    const html = String(index.body)

    // Every same-origin asset the shell is expected to serve. If Nuxt changes
    // how it emits these, this is where it shows up rather than in a blank
    // window on somebody's desktop.
    const refs = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]!)
    expect(refs.length, 'the generated index references nothing').toBeGreaterThan(0)
    for (const ref of refs.slice(0, 12)) {
      const r = await respondFor(ref, site, readFile)
      expect(r.status, `${ref} did not resolve`).toBe(200)
    }
  })

  it('still has the crossorigin attribute this header exists for', async () => {
    if (!(await generated())) return
    const html = String((await respondFor('/', site, readFile)).body)
    // If this ever stops being true the CORS header could go - but it is here
    // now, and the test says so rather than the comment alone.
    expect(html).toMatch(/crossorigin/)
  })
})
