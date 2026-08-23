// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/**
 * Build the application icons from `build/icon.svg`.
 *
 * The icons are committed, because CI builds on three platforms and only one of
 * them has `iconutil`. What is committed is therefore a derived artifact, which
 * is the sort of thing that drifts from its source and quietly becomes the
 * source - so this script exists to regenerate them, and `--check` asserts that
 * what is committed is what this produces. Run it after touching the SVG.
 *
 *   node scripts/make-icons.mjs           # write the icons
 *   node scripts/make-icons.mjs --check   # fail if they are stale
 *
 * Two silhouettes come out of one drawing. macOS since Big Sur expects the art
 * inset in its canvas - 824 of 1024, with a squircle - and an icon that fills
 * the canvas sits visibly larger than everything around it in the Dock. Windows
 * and Linux draw their own container, so those get the full bleed.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const BUILD = join(HERE, '..', 'build')
const SVG = join(BUILD, 'icon.svg')

/** The sizes an `.icns` carries, and the names `iconutil` insists on. */
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
/** What Windows Explorer picks between. 256 is the one anybody sees. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

const source = readFileSync(SVG, 'utf8')

/**
 * The macOS silhouette: the drawing scaled into 824 of 1024, centred.
 *
 * Done by wrapping rather than by editing the source, so there is one drawing
 * and the difference between the platforms stays visible in one place.
 */
function macVariant() {
  const inner = source.replace(/^<\?xml[^>]*\?>\s*/, '')
  const inset = (1024 - 824) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <g transform="translate(${inset} ${inset}) scale(${824 / 1024})">
    ${inner}
  </g>
</svg>`
}

/**
 * The drawing again, for sizes where the full one turns to mush.
 *
 * At 16 and 32 the outer arc pair collapses into a smudge and the mast goes to
 * a hairline - which is exactly what `public/favicon.svg` says in its own
 * comment, and why that file has only the inner pair. So below 48 the icon
 * follows the favicon: inner arcs, heavier strokes, larger dot. Scaling one
 * drawing to every size is how an icon ends up illegible in the one place it is
 * seen most, which is a menu bar or a tab.
 */
function smallVariant(tileRadius) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2B3D4D"/>
      <stop offset="0.55" stop-color="#202C39"/>
      <stop offset="1" stop-color="#141A22"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1024" height="1024" rx="${tileRadius}" fill="url(#g)"/>
  <g transform="translate(512 496)">
    <g fill="none" stroke="#F29559" stroke-width="76" stroke-linecap="round">
      <path d="M-196 162a224 224 0 0 1 0-324"/>
      <path d="M196 -162a224 224 0 0 1 0 324"/>
      <path d="M0 96v250"/>
      <path d="M-118 346h236"/>
    </g>
    <circle cx="0" cy="-16" r="96" fill="#F29559"/>
  </g>
</svg>`
}

/** Below this, the simplified drawing. */
const SMALL_BELOW = 48

const png = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer()

/** Pick the drawing that survives the size being asked for. */
const pngFor = (large, small, size) => png(size < SMALL_BELOW ? small : large, size)

/**
 * Pack PNGs into an `.ico`.
 *
 * Hand-rolled because the alternative is ImageMagick, which is one more thing
 * that has to be installed for anybody to regenerate an icon. The format is a
 * 6-byte header, a 16-byte entry per image, then the images - and since Vista a
 * PNG may be stored whole rather than as a DIB, which is what every size here
 * does. A 256px image writes its dimension as 0, which is the format's way of
 * saying 256 in a byte.
 */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length
  images.forEach(({ size, data }, i) => {
    const at = i * 16
    directory.writeUInt8(size >= 256 ? 0 : size, at)
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1)
    directory.writeUInt8(0, at + 2) // palette
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += data.length
  })

  return Buffer.concat([header, directory, ...images.map((i) => i.data)])
}

/** `.icns` through `iconutil`, which needs an iconset directory laid out its way. */
async function icns(large, small) {
  const dir = mkdtempSync(join(tmpdir(), 'boofwang-icons-'))
  const iconset = join(dir, 'icon.iconset')
  mkdirSync(iconset)
  for (const size of ICNS_SIZES) {
    writeFileSync(join(iconset, `icon_${size}x${size}.png`), await pngFor(large, small, size))
    // The @2x of the size below, which is the same pixels under another name.
    if (size > 16) writeFileSync(join(iconset, `icon_${size / 2}x${size / 2}@2x.png`), await pngFor(large, small, size))
  }
  const out = join(dir, 'icon.icns')
  execFileSync('iconutil', ['--convert', 'icns', '--output', out, iconset])
  const data = readFileSync(out)
  rmSync(dir, { recursive: true, force: true })
  return data
}

const check = process.argv.includes('--check')
const outputs = []

const bleed = source
const mac = macVariant()
// The squircle radius each silhouette uses, so the small drawing matches.
const smallBleed = smallVariant(228)
const smallMac = smallVariant(228)

outputs.push(['icon.png', await png(bleed, 512)])
outputs.push([
  'icon.ico',
  ico(await Promise.all(ICO_SIZES.map(async (size) => ({ size, data: await pngFor(bleed, smallBleed, size) })))),
])

// `iconutil` is macOS only. Elsewhere the committed `.icns` is left as it is,
// and `--check` says so rather than reporting it stale on a Linux runner.
if (process.platform === 'darwin') outputs.push(['icon.icns', await icns(mac, smallMac)])
else console.log('icon.icns: skipped, iconutil is macOS only')

let stale = 0
for (const [name, data] of outputs) {
  const path = join(BUILD, name)
  let current = null
  try {
    current = readFileSync(path)
  } catch {
    /* not written yet */
  }
  const same = current !== null && current.equals(data)
  if (check) {
    if (!same) {
      stale++
      console.error(`${name} is stale: run \`node scripts/make-icons.mjs\``)
    }
    continue
  }
  if (!same) writeFileSync(path, data)
  console.log(`${name}: ${data.length.toLocaleString()} bytes${same ? ' (unchanged)' : ''}`)
}

if (check && stale > 0) process.exit(1)
if (check) console.log(`icons are up to date with ${'build/icon.svg'}`)
