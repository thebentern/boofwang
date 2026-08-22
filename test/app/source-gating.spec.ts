// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DATA_SOURCES } from '#core/data/registry.js'

/**
 * The web build must not be able to reach a source it cannot use.
 *
 * There is one artifact: the desktop shell ships the same `.output/public` the
 * Pages deploy does, so a desktop-only source's module is necessarily *present*
 * in the browser build. There is no second bundle to leave it out of, and
 * pretending otherwise would mean two artifacts to keep in step.
 *
 * What is guaranteed instead, and what this file guards:
 *
 *  - the module is in a lazy chunk, not the entry, so a browser never fetches
 *    it, and
 *  - `loadSource` refuses on capability before it evaluates the import.
 *
 * The second is tested directly in `test/lib/data/sources.spec.ts`. This one
 * checks the build, because the way that guarantee breaks is somebody turning
 * the dynamic `import()` into a static one - which would compile, pass every
 * unit test, and quietly put a desktop-only endpoint in the entry chunk.
 *
 * Skipped when there is no build, the same way the hardware project skips
 * without a radio.
 *
 * Which means it does not run in CI as things stand: `.github/workflows/ci.yml`
 * runs `test:cov` before `build`, so `.output/public` does not exist yet and
 * every assertion here is skipped. Said out loud rather than left to be
 * discovered, because a suite that reports green while silently skipping its
 * only check of the shipped artifact is worse than no check. Running the `app`
 * project a second time after the build step would close it.
 */
const PUBLIC = fileURLToPath(new URL('../../.output/public', import.meta.url))
const built = existsSync(`${PUBLIC}/index.html`)

/** The API hosts a browser must never be able to call. Homepages are fine: the UI names them. */
const GATED_ENDPOINTS = ['hearham.com/api', 'radioid.net/api']

describe.skipIf(!built)('the built web bundle', () => {
  const index = () => readFileSync(`${PUBLIC}/index.html`, 'utf8')

  /**
   * Chunks belonging to the build that is actually there.
   *
   * `.output/public/_nuxt` is not emptied between builds - it currently holds
   * fifty-three files while `index.html` names twenty-eight - so a plain
   * directory listing mixes the current build with every previous one. Reading
   * a stale chunk would let an assertion pass on evidence from a build that no
   * longer exists, which is the same class of mistake as a test that skips
   * silently.
   */
  function currentChunks(): string[] {
    const builtAt = statSync(`${PUBLIC}/index.html`).mtimeMs
    return readdirSync(`${PUBLIC}/_nuxt`)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => statSync(`${PUBLIC}/_nuxt/${f}`).mtimeMs >= builtAt - 60_000)
  }

  const currentBodies = () =>
    currentChunks().map((f) => readFileSync(`${PUBLIC}/_nuxt/${f}`, 'utf8')).join('')

  /**
   * Chunks the browser loads without being asked: anything index.html names.
   * A gated endpoint appearing in one of these means it ships to every visitor.
   */
  function eagerChunks(): string[] {
    const html = index()
    return readdirSync(`${PUBLIC}/_nuxt`)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => html.includes(f))
  }

  it('names some chunks eagerly, or this test is checking nothing', () => {
    expect(eagerChunks().length).toBeGreaterThan(0)
  })

  it('keeps every gated API endpoint out of the eagerly loaded chunks', () => {
    const eager = eagerChunks()
    for (const chunk of eager) {
      const body = readFileSync(`${PUBLIC}/_nuxt/${chunk}`, 'utf8')
      for (const endpoint of GATED_ENDPOINTS) {
        expect(body.includes(endpoint), `${chunk} reaches ${endpoint}`).toBe(false)
      }
    }
  })

  it('keeps every gated API endpoint out of index.html', () => {
    for (const endpoint of GATED_ENDPOINTS) {
      expect(index().includes(endpoint), endpoint).toBe(false)
    }
  })

  it('still ships the ungated source, which needs no shell at all', () => {
    // BrandMeister reflects the requesting origin. If this ever stops being
    // reachable from the web build, the DM-32UV talk group import - the largest
    // gap this whole feature closes - has been gated for no reason.
    expect(currentBodies()).toContain('api.brandmeister.network')
  })

  it('has a lazy chunk for each gated source, proving they are still built', () => {
    // The counterpart to the assertions above: absent from the eager chunks
    // because they are lazy, not because someone deleted them.
    const all = currentBodies()
    for (const endpoint of GATED_ENDPOINTS) {
      expect(all.includes(endpoint), endpoint).toBe(true)
    }
  })
})

describe('the registry', () => {
  it('declares a gated source for each endpoint this file guards', () => {
    // Keeps GATED_ENDPOINTS honest: adding a desktop-only source without adding
    // its endpoint here would leave it unguarded.
    const gated = DATA_SOURCES.filter((s) => s.needs.includes('crossOriginFetch'))
    expect(gated.length).toBe(GATED_ENDPOINTS.length)
    for (const s of gated) {
      const host = new URL(s.homepage).host.replace(/^www\./, '')
      expect(GATED_ENDPOINTS.some((e) => e.startsWith(host)), s.id).toBe(true)
    }
  })
})
