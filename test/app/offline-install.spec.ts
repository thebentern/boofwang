// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The pieces that make boofwang installable, checked against each other.
 *
 * They are four separate files that only work as a set: a manifest naming icons
 * that exist at the sizes it claims, a `<link rel="manifest">` that points at
 * it, and a build that actually writes the service worker beside it. Any one of
 * them can be edited without the others complaining, and the symptom of every
 * mismatch is the same - the browser silently declines to offer an install, and
 * a radio gets programmed on a hilltop by somebody who thought they had a copy.
 */

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8')

const manifest = JSON.parse(read('public/manifest.webmanifest'))
const config = read('nuxt.config.ts')
const css = read('app/assets/css/main.css')
const pkg = JSON.parse(read('package.json'))

/** A PNG's dimensions, out of its IHDR. Cheaper than a decoder and exact. */
function pngSize(path: string) {
  const buf = readFileSync(fileURLToPath(new URL(path, root)))
  expect(buf.subarray(1, 4).toString('ascii'), `${path} is not a PNG`).toBe('PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** The first definition of a token, which is the dark theme's. */
function token(name: string, from = css) {
  const match = from.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))
  expect(match, `--${name} is not defined in main.css`).not.toBeNull()
  return match![1]!.toUpperCase()
}

describe('the web app manifest', () => {
  it('says what a browser needs before it will offer an install', () => {
    expect(manifest.name).toBe('boofwang')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.description.length).toBeGreaterThan(30)
  })

  it('names icons that exist, at the sizes it claims', () => {
    // Chrome checks the file, not the declaration. An icon whose real size
    // disagrees with `sizes` is discarded, and with both of the required sizes
    // discarded the install prompt never appears and nothing says why.
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3)
    for (const icon of manifest.icons) {
      const path = `public${icon.src}`
      expect(existsSync(fileURLToPath(new URL(path, root))), `${path} is missing`).toBe(true)
      const [w, h] = icon.sizes.split('x').map(Number)
      expect(pngSize(path), `${path} is not ${icon.sizes}`).toEqual({ width: w, height: h })
    }
  })

  it('carries the two sizes an install needs and one maskable', () => {
    const any = manifest.icons.filter((i: { purpose: string }) => i.purpose === 'any')
    expect(any.map((i: { sizes: string }) => i.sizes).sort()).toEqual(['192x192', '512x512'])
    // Without a maskable icon Android draws the square drawing inside its own
    // mask, which crops the corners of a squircle into a notch.
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true)
  })

  it('is tinted with the page background, not with something near it', () => {
    // Installed, the app fills the display and the system chrome sits directly
    // against the page. A colour that is close but not equal reads as a seam
    // along the top edge of a phone.
    const bg = token('bg')
    expect(manifest.background_color.toUpperCase()).toBe(bg)
    expect(manifest.theme_color.toUpperCase()).toBe(bg)
  })

  it('is linked from the document head', () => {
    expect(config).toContain(`rel: 'manifest', href: '/manifest.webmanifest'`)
  })
})

describe('the browser chrome tint', () => {
  it('matches --bg in both themes', () => {
    const light = css.slice(css.indexOf(':root.light'))
    const themes = [token('bg'), token('bg', light)]
    const declared = [...config.matchAll(/'theme-color', content: '(#[0-9A-Fa-f]{6})'/g)].map((m) =>
      m[1]!.toUpperCase(),
    )
    expect(declared, 'both prefers-color-scheme variants must be declared').toHaveLength(2)
    expect(declared).toEqual(themes)
  })
})

describe('the build', () => {
  it('writes the service worker into the site it just built', () => {
    // Both entry points. A build that skips this step ships a site with a
    // `<link rel="manifest">`, an install prompt, and no offline copy at all
    // behind it - which is worse than not offering one.
    expect(pkg.scripts.build).toContain('scripts/build-service-worker.mjs')
    expect(pkg.scripts.generate).toContain('scripts/build-service-worker.mjs')
  })

  it('does not write one into the desktop shell', () => {
    /*
     * The shell serves the packaged site off a custom scheme and updates by
     * being replaced, through GitHub releases. A worker in front of that would
     * hold one release's assets in the profile and go on serving them after the
     * application had been updated - an offline cache defeating an update,
     * which is the exact failure this feature exists to prevent.
     */
    expect(pkg.scripts['desktop:site']).not.toContain('build-service-worker')
  })
})
