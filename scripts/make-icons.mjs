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
const PUBLIC = join(HERE, '..', 'public')
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
 * Substitute exactly once, or say what changed.
 *
 * The maskable variant below is made by editing three specific strings out of
 * the drawing, and `String.replace` on a pattern that no longer matches does
 * nothing at all and reports nothing at all. That failure would ship as a home
 * screen icon with a rounded corner cut out of a rounded corner, which nobody
 * would notice until somebody installed it on a phone.
 */
function swap(svg, find, replace) {
  if (!svg.includes(find)) throw new Error(`build/icon.svg no longer contains:\n  ${find}`)
  return svg.split(find).join(replace)
}

/**
 * The maskable silhouette: full-bleed ground, drawing inset into the safe zone.
 *
 * Android crops a maskable icon to whatever shape the launcher wants, and
 * guarantees only the centre circle of 80% diameter. Two consequences, and this
 * variant exists because the committed drawing satisfies neither: its squircle
 * corners would be cropped by a *second* rounded corner and read as a notch,
 * and its mark reaches about 452 units from centre where the safe circle stops
 * at 410.
 *
 * So the tile is squared and the drawing is scaled to 80% about the canvas
 * centre - the same factor the macOS variant uses, which takes the mark to 364
 * and leaves it comfortably inside. Scaling about the centre rather than
 * re-centring keeps the mark sitting very slightly high, which is the one thing
 * the drawing's own comment asks for.
 */
function maskableVariant() {
  let out = source.replace(/^<\?xml[^>]*\?>\s*/, '')
  out = swap(
    out,
    '<rect x="0" y="0" width="1024" height="1024" rx="228" fill="url(#ground)"/>',
    '<rect x="0" y="0" width="1024" height="1024" fill="url(#ground)"/>',
  )
  // The rim hairline traces a squircle that is no longer there.
  out = swap(
    out,
    '<rect x="4" y="4" width="1016" height="1016" rx="226" fill="none" stroke="url(#rim)" stroke-width="8"/>',
    '',
  )
  const scale = 824 / 1024
  out = swap(out, 'transform="translate(512 496)"', `transform="translate(512 ${512 + (496 - 512) * scale}) scale(${scale})"`)
  return out
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

outputs.push([BUILD, 'icon.png', await png(bleed, 512)])
outputs.push([
  BUILD,
  'icon.ico',
  ico(await Promise.all(ICO_SIZES.map(async (size) => ({ size, data: await pngFor(bleed, smallBleed, size) })))),
])

/*
 * The icons `public/manifest.webmanifest` points at, so boofwang can be
 * installed to a home screen and opened without a network.
 *
 * 192 and 512 are the two sizes Chrome requires before it will offer to install
 * anything at all. They are the full-bleed drawing, because an `any` icon is
 * placed as it is drawn; the maskable one is a separate silhouette because it
 * is not.
 */
outputs.push([PUBLIC, 'icon-192.png', await png(bleed, 192)])
outputs.push([PUBLIC, 'icon-512.png', await png(bleed, 512)])
outputs.push([PUBLIC, 'icon-maskable-512.png', await png(maskableVariant(), 512)])

// `iconutil` is macOS only. Elsewhere the committed `.icns` is left as it is,
// and `--check` says so rather than reporting it stale on a Linux runner.
if (process.platform === 'darwin') outputs.push([BUILD, 'icon.icns', await icns(mac, smallMac)])
else console.log('icon.icns: skipped, iconutil is macOS only')

let stale = 0
for (const [dir, name, data] of outputs) {
  const path = join(dir, name)
  const label = `${dir === PUBLIC ? 'public' : 'build'}/${name}`
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
      console.error(`${label} is stale: run \`node scripts/make-icons.mjs\``)
    }
    continue
  }
  if (!same) writeFileSync(path, data)
  console.log(`${label}: ${data.length.toLocaleString()} bytes${same ? ' (unchanged)' : ''}`)
}

if (check && stale > 0) process.exit(1)
if (check) console.log(`icons are up to date with ${'build/icon.svg'}`)
