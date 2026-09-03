// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/**
 * The two images the Google Play listing needs, drawn from the app's own icon.
 *
 *   node scripts/make-store-art.mjs
 *
 * Play asks for a 512x512 icon and a 1024x500 feature graphic, and will not
 * publish a listing without both. They are not built by anything: a person
 * uploads them to the Play Console, so unlike `make-icons.mjs` there is no
 * `--check` here. A check would have to compare bytes, the wordmark is
 * rendered with whatever font the host has, and the same source would then
 * report stale on Linux and fine on macOS. `make-icons.mjs` already carries
 * that scar in the shape of its `iconutil` skip.
 *
 * The output goes to `build/play/` and is git-ignored for the same reason: it
 * is regenerated in a second and it is nobody's input.
 *
 * Play flattens nothing and draws its own rounded corners over the icon, so the
 * alpha in `public/icon-512.png` is composited onto the ground colour here
 * rather than shipped. A transparent icon on Play renders on white, which is
 * the one background this drawing was not designed for.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'build', 'play')

/** The palette is `build/icon.svg`'s, and it is the interface's. */
const GROUND_TOP = '#2B3D4D'
const GROUND_MID = '#202C39'
const GROUND_BOTTOM = '#141A22'
const ACCENT = '#F29559'
const RIM = '#41576B'

/**
 * The mark on its own, without the tile the icon draws it on.
 *
 * Taken from `build/icon.svg` rather than imported, because the icon's mark is
 * positioned for a 1024 square tile and this one has to sit in a 1024x500
 * letterbox. Sharing the geometry would mean the icon could not be recentred
 * without moving this, which is the wrong coupling for two drawings that only
 * have to look like each other.
 */
const mark = (scale) => `
  <g transform="scale(${scale})">
    <g fill="none" stroke="${ACCENT}" stroke-width="34" stroke-linecap="round">
      <path d="M-286 236a330 330 0 0 1 0-472"/>
      <path d="M286 -236a330 330 0 0 1 0 472"/>
      <path d="M-162 134a186 186 0 0 1 0-268"/>
      <path d="M162 -134a186 186 0 0 1 0 268"/>
      <path d="M0 74v244"/>
      <path d="M-96 318h192"/>
    </g>
    <circle cx="0" cy="-16" r="74" fill="${ACCENT}"/>
  </g>`

/**
 * Play crops the feature graphic differently in different placements, and the
 * documented safe area is the middle. So the mark and the words sit well inside
 * it: an edge-to-edge composition is one that loses a letter on a phone.
 */
function featureGraphic() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${GROUND_TOP}"/>
      <stop offset="0.55" stop-color="${GROUND_MID}"/>
      <stop offset="1" stop-color="${GROUND_BOTTOM}"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${RIM}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${RIM}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="1024" height="500" fill="url(#ground)"/>
  <rect width="1024" height="3" fill="url(#rim)"/>

  <g transform="translate(212 250)">${mark(0.42)}</g>

  <g font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
    <text x="392" y="243" font-size="76" font-weight="600" letter-spacing="-2" fill="#F4F7FA">boofwang</text>
    <text x="394" y="296" font-size="27" font-weight="400" fill="#93A4B4">Codeplug editor for two-way radios</text>
  </g>
</svg>`
}

mkdirSync(OUT, { recursive: true })

/*
 * Flattened, not merely opaque. Rendering an SVG through sharp leaves an alpha
 * channel behind even when every pixel in it is solid, and Play rejects a
 * feature graphic that has one at all rather than looking at what is in it.
 */
const feature = await sharp(Buffer.from(featureGraphic()))
  .flatten({ background: GROUND_BOTTOM })
  .png({ compressionLevel: 9 })
  .toBuffer()
writeFileSync(join(OUT, 'feature-graphic.png'), feature)

// Composited onto the ground rather than left transparent: see above.
const icon = await sharp(join(HERE, '..', 'public', 'icon-512.png'))
  .flatten({ background: GROUND_BOTTOM })
  .png({ compressionLevel: 9 })
  .toBuffer()
writeFileSync(join(OUT, 'icon-512.png'), icon)

for (const [name, data] of [['feature-graphic.png', feature], ['icon-512.png', icon]]) {
  const { width, height, hasAlpha } = await sharp(data).metadata()
  console.log(`build/play/${name}: ${width}x${height}, alpha=${hasAlpha}, ${data.length.toLocaleString()} bytes`)
}
