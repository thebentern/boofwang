// SPDX-License-Identifier: GPL-3.0-or-later
import { extname, join, normalize, sep } from 'node:path'

/**
 * Serving the generated site to the desktop shell, without Electron in the way.
 *
 * Everything here is a pure function of a path and a reader, so the rules that
 * decide what a request answers with can be tested in the ordinary suite rather
 * than by launching a windowed application and reading its console. That
 * mattered: two of the three bugs in this shell were in exactly these rules,
 * and both looked from the outside like "the window is blank".
 */

/** Content types for what a static Nuxt build actually contains. */
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export function contentTypeFor(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Which file a request path means, or null if it means none.
 *
 * Two rules. The path is resolved and then checked to be inside the site root
 * before anything is read - the request comes from a page this shell loaded, so
 * this is not the usual hostile-input case, but a traversal here would read
 * arbitrary files off the user's disk into a renderer and the check costs one
 * comparison. And a path with no extension is a route rather than a file: this
 * is a single-page build, so those are answered with the shell and the router
 * takes over, which is the same thing the Pages 404 does on the web.
 */
export function resolveSitePath(pathname, root) {
  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    // A malformed percent-escape is not a path.
    return null
  }
  if (rel.includes('\0')) return null
  const target = normalize(join(root, rel))
  if (target !== root && !target.startsWith(root + sep)) return null
  return /\.[a-z0-9]+$/i.test(rel) ? target : join(root, 'index.html')
}

/**
 * The headers a served file needs.
 *
 * `access-control-allow-origin` is here for a reason worth writing down,
 * because it looks redundant: the page and the file share an origin. Nuxt emits
 * its module preloads and its stylesheet with `crossorigin`, which puts those
 * requests in CORS mode whatever the origin, and a response with no
 * `Access-Control-Allow-Origin` is then rejected. The symptom is precise and
 * misleading - `did-finish-load` fires, the window is up, the origin is right,
 * `navigator.serial` is present, and the body is empty, because not one module
 * ever executed.
 */
export function headersFor(file) {
  return {
    'content-type': contentTypeFor(file),
    'access-control-allow-origin': '*',
  }
}

/**
 * Answer one request for the site.
 *
 * `read` is injected so this can be exercised against a fake filesystem; the
 * shell passes `node:fs/promises` readFile. Returns a plain object rather than
 * a `Response` so nothing here depends on a fetch implementation being present.
 */
export async function respondFor(pathname, root, read) {
  const file = resolveSitePath(pathname, root)
  if (file === null) return { status: 404, headers: {}, body: null, file: null }
  try {
    const body = await read(file)
    return { status: 200, headers: headersFor(file), body, file }
  } catch {
    return { status: 404, headers: {}, body: null, file }
  }
}

/**
 * Check a URL is one the shell is willing to fetch on the page's behalf.
 *
 * https only, and nothing else is negotiable: this runs outside the renderer
 * where the same-origin policy does not apply, so it is the one place in
 * boofwang where a URL from the page reaches the network unfiltered. Returns
 * the parsed URL or throws with the reason.
 */
export function assertFetchable(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${JSON.stringify(String(url))} is not a URL`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`boofwang fetches over https only, not ${parsed.protocol}`)
  }
  return parsed
}
