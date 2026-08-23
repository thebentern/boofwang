// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
// @ts-expect-error - the build scripts are plain ESM JavaScript, deliberately untyped.
import { renderWorker } from '../../scripts/build-service-worker.mjs'

/**
 * A service worker global scope, small enough to reason about.
 *
 * The worker is a classic script that talks to `caches`, `fetch`, `clients` and
 * three event types, and the alternative way to check what it does with them is
 * to deploy a site, install it, unplug the network and look. That is a slow
 * test with a bad failure mode: the symptom of every mistake in this file is a
 * blank page, which is the least informative thing a program can report.
 *
 * So the real `sw/worker.js` is rendered exactly as the build renders it and
 * evaluated here, and the tests drive its own handlers. Nothing is reimplemented
 * - what runs is the file that ships.
 */

export const ORIGIN = 'https://boofwa.ng'

interface Init {
  method?: string
  mode?: string
  headers?: Record<string, string>
  cache?: string
}

/**
 * Enough of `Request` for the worker's rules.
 *
 * Not undici's: it rejects a relative URL, and every path the worker precaches
 * is relative to its own scope. A browser resolves those against the worker's
 * location, which is what this does.
 */
export class FakeRequest {
  readonly url: string
  readonly method: string
  readonly mode: string
  readonly cache: string | undefined
  readonly headers: { get(name: string): string | null }

  constructor(input: string | FakeRequest, init: Init = {}) {
    const from = typeof input === 'string' ? null : input
    this.url = new URL(typeof input === 'string' ? input : input.url, ORIGIN).toString()
    this.method = init.method ?? from?.method ?? 'GET'
    this.mode = init.mode ?? from?.mode ?? 'no-cors'
    this.cache = init.cache ?? from?.cache
    const headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    this.headers = { get: (name) => headers.get(name.toLowerCase()) ?? null }
  }
}

export class FakeResponse {
  constructor(
    readonly body: string,
    readonly init: { status?: number, headers?: Record<string, string> } = {},
  ) {}

  get status() {
    return this.init.status ?? 200
  }
}

class FakeCache {
  readonly entries = new Map<string, FakeResponse>()

  async addAll(requests: (FakeRequest | string)[]) {
    /*
     * Atomic, the way a browser's is: every response is fetched before any of
     * them is stored, and one 404 rejects the lot. Modelled rather than
     * simplified because the worker relies on it - a half-filled cache serves
     * some of one build and some of another, and says nothing about it.
     */
    const staged: [string, FakeResponse][] = []
    for (const r of requests) {
      const request = typeof r === 'string' ? new FakeRequest(r) : r
      const body = fetched.get(new URL(request.url).pathname)
      if (body === undefined) throw new Error(`404 ${request.url}`)
      staged.push([request.url, new FakeResponse(body)])
      addAllInit.push(request)
    }
    for (const [url, response] of staged) this.entries.set(url, response)
  }

  async match(request: FakeRequest | string) {
    const url = typeof request === 'string' ? new URL(request, ORIGIN).toString() : request.url
    return this.entries.get(url) ?? undefined
  }

  async delete(request: FakeRequest | string) {
    const url = typeof request === 'string' ? new URL(request, ORIGIN).toString() : request.url
    return this.entries.delete(url)
  }
}

/** What the network would serve, by path. Drives both `addAll` and `fetch`. */
export const fetched = new Map<string, string>()

/** Every request `addAll` was given, so the test can check `cache: 'reload'`. */
export const addAllInit: FakeRequest[] = []

export class FakeCaches {
  readonly named = new Map<string, FakeCache>()

  async open(name: string) {
    let cache = this.named.get(name)
    if (!cache) this.named.set(name, (cache = new FakeCache()))
    return cache
  }

  async keys() {
    return [...this.named.keys()]
  }

  async delete(name: string) {
    return this.named.delete(name)
  }

  async match(request: FakeRequest | string, options: { cacheName?: string } = {}) {
    const names = options.cacheName ? [options.cacheName] : [...this.named.keys()]
    for (const name of names) {
      const hit = await this.named.get(name)?.match(request)
      if (hit) return hit
    }
    return undefined
  }
}

export interface Harness {
  caches: FakeCaches
  claimed: () => boolean
  skipWaitingCalls: () => number
  /** Whether the network is up. `false` makes every `fetch` reject. */
  online: boolean
  install(): Promise<void>
  activate(): Promise<void>
  /** The response the worker gave, or null when it passed the request through. */
  fetchEvent(request: FakeRequest): Promise<FakeResponse | null>
  message(data: unknown): unknown
}

const TEMPLATE = fileURLToPath(new URL('../../sw/worker.js', import.meta.url))

/**
 * Render and evaluate the worker, returning handles on what it did.
 *
 * `precache` doubles as the set of paths the fake network will serve, so a test
 * that wants an install to fail can simply leave one out.
 */
export function loadWorker(options: {
  build?: { version: string, commit: string, committedAt: string }
  revision?: string
  base?: string
  precache?: string[]
  serve?: Record<string, string>
} = {}): Harness {
  const build = options.build ?? { version: '0.1.1', commit: 'a1b2c3d', committedAt: '2026-08-20T09:00:00Z' }
  const base = options.base ?? '/'
  const precache = options.precache ?? ['/index.html', '/404.html', '/_nuxt/entry.abc123.js', '/favicon.svg']

  fetched.clear()
  addAllInit.length = 0
  for (const path of precache) fetched.set(path, `body of ${path}`)
  for (const [path, body] of Object.entries(options.serve ?? {})) fetched.set(path, body)

  const listeners = new Map<string, ((event: unknown) => void)[]>()
  const caches = new FakeCaches()
  let claimed = false
  let skipWaitingCalls = 0
  const harness = { online: true } as Harness

  const self = {
    location: { origin: ORIGIN, href: `${ORIGIN}${base}sw.js` },
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler])
    },
    skipWaiting() {
      skipWaitingCalls++
    },
    clients: {
      async claim() {
        claimed = true
      },
    },
  }

  const context = createContext({
    self,
    caches,
    Request: FakeRequest,
    Response: FakeResponse,
    URL,
    Promise,
    Set,
    Error,
    console,
    async fetch(input: FakeRequest | string) {
      if (!harness.online) throw new TypeError('Failed to fetch')
      const path = new URL(typeof input === 'string' ? input : input.url, ORIGIN).pathname
      const body = fetched.get(path)
      if (body === undefined) return new FakeResponse('Not found', { status: 404 })
      return new FakeResponse(body)
    },
  })

  const source = renderWorker(readFileSync(TEMPLATE, 'utf8'), {
    info: build,
    revision: options.revision ?? 'rev0000',
    base,
    precache,
  })
  runInContext(source, context)

  const fire = (type: string, event: Record<string, unknown>) => {
    for (const handler of listeners.get(type) ?? []) handler(event)
  }

  harness.caches = caches
  harness.claimed = () => claimed
  harness.skipWaitingCalls = () => skipWaitingCalls

  harness.install = async () => {
    let waited: Promise<unknown> = Promise.resolve()
    fire('install', { waitUntil: (p: Promise<unknown>) => (waited = p) })
    await waited
  }

  harness.activate = async () => {
    let waited: Promise<unknown> = Promise.resolve()
    fire('activate', { waitUntil: (p: Promise<unknown>) => (waited = p) })
    await waited
  }

  harness.fetchEvent = async (request: FakeRequest) => {
    let answered: Promise<FakeResponse> | null = null
    fire('fetch', { request, respondWith: (p: Promise<FakeResponse>) => (answered = p) })
    // A handler that never calls respondWith is the worker declining to take
    // part, and the browser goes to the network as though it were not there.
    return answered === null ? null : await answered
  }

  harness.message = (data: unknown) => {
    let replied: unknown = undefined
    fire('message', { data, ports: [{ postMessage: (m: unknown) => (replied = m) }] })
    return replied
  }

  return harness
}
