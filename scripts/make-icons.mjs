// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
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
const IOS = join(HERE, '..', 'mobile', 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset')
const ANDROID = join(HERE, '..', 'mobile', 'android', 'app', 'src', 'main', 'res')
const SVG = join(BUILD, 'icon.svg')

/** The tile the mark sits on, shared by every silhouette that draws one. */
const TILE = '#202C39'

/**
 * Android's launcher densities: the legacy icon edge, then the adaptive
 * foreground edge, which is the 108dp canvas rather than the 48dp one.
 */
const ANDROID_DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
]

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

/*
 * `swap` used to be here: a substitute-or-throw, because `String.replace` on a
 * pattern that no longer matches does nothing and reports nothing, and the
 * maskable variant was built by editing three exact strings out of the drawing.
 * Its last caller went with `maskableVariant`. The hazard it guarded went too:
 * the home-screen drawings are written out in full rather than derived by
 * editing `build/icon.svg`, so there is no pattern left to silently stop
 * matching. `icons:check` is what catches drift now, and it covers one more
 * file than it used to.
 */

/*
 * `maskableVariant` used to live here: the maskable silhouette derived from
 * `build/icon.svg` by squaring the tile, dropping the rim and scaling the mark
 * to the 80% safe circle Android guarantees.
 *
 * Its geometry was right and none of that reasoning changed - `homeMaskable`
 * above does the same three things. What changed is which drawing it does them
 * to: a maskable icon is a launcher icon, so it lands at launcher sizes, and
 * that is exactly the range the four-arc drawing turns to mush in. Deriving it
 * from the 1024 source was spending the safe zone on detail nobody sees.
 */


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

/**
 * A third drawing, for the sizes a launcher actually renders.
 *
 * The repo had two drawings and they are drawn for 32px and 1024px. A home
 * screen sits between them: a launcher grid renders at roughly 48-60px, and
 * `icon-192.png` was the 1024 drawing rastered down, so a phone got the
 * four-arc version at a size much nearer the favicon end. The vertical gradient
 * and the 8px rim are both gone below about 96px, so those pixels were spent on
 * nothing while the arcs crowded each other.
 *
 * Same rule the repo already applies between 32 and 1024: redraw, do not scale.
 * One arc pair rather than two, and the OUTER one - a wide arc survives a small
 * render where a narrow one closes onto its neighbour. Stroke 34 to 64, dot r74
 * to r104, and a flat ground because a gradient across 48px is a flat colour
 * with extra file size.
 */
function homeMark() {
  return `  <g transform="translate(512 500)">
    <g fill="none" stroke="#F29559" stroke-width="64" stroke-linecap="round">
      <path d="M-286 236a330 330 0 0 1 0-472"/>
      <path d="M286 -236a330 330 0 0 1 0 472"/>
      <path d="M0 96v250"/>
      <path d="M-116 346h232"/>
    </g>
    <circle cx="0" cy="-24" r="104" fill="#F29559"/>
  </g>`
}

function homeVariant() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect x="0" y="0" width="1024" height="1024" rx="228" fill="#202C39"/>
${homeMark()}
</svg>`
}

/**
 * The maskable form of the same drawing.
 *
 * The committed maskable geometry was already right - full bleed, no corner
 * radius, mark inset into the safe zone - because Android crops it to whatever
 * shape the launcher wants. Only the arc count changes, for the reason above:
 * a maskable icon is a launcher icon and lands at launcher sizes.
 */
function homeMaskable() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect x="0" y="0" width="1024" height="1024" fill="#202C39"/>
  <g transform="translate(512 512) scale(0.72) translate(-512 -512)">
${homeMark()}
  </g>
</svg>`
}

/**
 * The iOS silhouette: the home drawing with the corners left square.
 *
 * iOS rounds an app icon itself. Handing it the squircle rounds corners that
 * are about to be rounded again, and what shows through the mask is a pale
 * fringe where the tile has already stopped. Square here, masked there.
 */
function iosVariant() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect x="0" y="0" width="1024" height="1024" fill="${TILE}"/>
${homeMark()}
</svg>`
}

/** The circular launcher icon Android asks for alongside the square one. */
function roundVariant() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <circle cx="512" cy="512" r="512" fill="${TILE}"/>
${homeMark()}
</svg>`
}

/**
 * The adaptive foreground: the mark alone, on nothing.
 *
 * An adaptive icon composites this over `@color/ic_launcher_background`, so
 * drawing the tile here would paint it twice and defeat the parallax the
 * launcher applies to the two layers separately. The 0.72 is the same safe
 * zone `homeMaskable` uses: a launcher may mask this to a circle.
 */
function adaptiveForeground() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <g transform="translate(512 512) scale(0.72) translate(-512 -512)">
${homeMark()}
  </g>
</svg>`
}

/** Below this, the simplified drawing. */
const SMALL_BELOW = 48

const png = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer()

/**
 * The same, with the alpha channel gone.
 *
 * App Store Connect rejects an icon that carries one, even where every pixel
 * is opaque, and it rejects it on upload rather than in review - so the first
 * sign is a failed delivery of a build that took the whole gate to produce.
 */
const opaquePng = (svg, size) =>
  sharp(Buffer.from(svg))
    .resize(size, size)
    .flatten({ background: TILE })
    .png({ compressionLevel: 9 })
    .toBuffer()

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
/*
 * 192 and the maskable take the home-screen drawing; 512 keeps the full one,
 * because it is the size an install prompt and a splash screen show at, where
 * the detail is legible and worth having.
 *
 * apple-touch-icon is generated here rather than committed by hand. It was the
 * one icon in the repo that `pnpm icons:check` did not cover, so it could drift
 * from every other one and nothing would say so. iOS renders it at 60-76pt,
 * which is the same range as the launcher grid.
 */
outputs.push([PUBLIC, 'icon-192.png', await png(homeVariant(), 192)])
outputs.push([PUBLIC, 'icon-512.png', await png(bleed, 512)])
outputs.push([PUBLIC, 'icon-maskable-512.png', await png(homeMaskable(), 512)])
outputs.push([PUBLIC, 'apple-touch-icon.png', await png(homeVariant(), 180)])

/*
 * The two native projects. `cap sync` does not touch these, so what Capacitor
 * scaffolded stayed: both stores were being handed Capacitor's own logo, and
 * a build carrying it reached App Store Connect before anybody looked. They
 * are generated here for the reason everything else here is - a derived icon
 * nobody regenerates drifts until it is the source.
 *
 * iOS takes one 1024 square and masks it. Android takes three drawings at five
 * densities: the legacy icon, the round one, and the adaptive foreground whose
 * tile comes from `values/ic_launcher_background.xml` instead.
 */
outputs.push([IOS, 'AppIcon-512@2x.png', await opaquePng(iosVariant(), 1024)])
for (const [density, legacy, foreground] of ANDROID_DENSITIES) {
  const dir = join(ANDROID, `mipmap-${density}`)
  outputs.push([dir, 'ic_launcher.png', await png(homeVariant(), legacy)])
  outputs.push([dir, 'ic_launcher_round.png', await png(roundVariant(), legacy)])
  outputs.push([dir, 'ic_launcher_foreground.png', await png(adaptiveForeground(), foreground)])
}

// `iconutil` is macOS only. Elsewhere the committed `.icns` is left as it is,
// and `--check` says so rather than reporting it stale on a Linux runner.
if (process.platform === 'darwin') outputs.push([BUILD, 'icon.icns', await icns(mac, smallMac)])
else console.log('icon.icns: skipped, iconutil is macOS only')

let stale = 0
for (const [dir, name, data] of outputs) {
  const path = join(dir, name)
  const label = `${relative(join(HERE, '..'), dir)}/${name}`
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
