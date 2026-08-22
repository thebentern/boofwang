// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The DM-32UV startup image, as pixels.
 *
 * The picture the radio shows while it powers up is stored raw: 153,600 bytes
 * of RGB565, 240 x 320 portrait, no header, no palette, no compression.
 * Transcribed from the MIT-licensed DM32-Protocol-Spec, `04-MEMORY-LAYOUT.md`,
 * V-frame 0x0E. Where those bytes live on the radio is the business of
 * `radios/dm32uv/boot-image.ts`; this file is only the arithmetic.
 *
 * There are deliberately no image *files* here. Decoding a PNG or a JPEG needs
 * a decoder, and the only one a browser will lend us is the one behind
 * `<canvas>` - which lib/ may not touch, by rule and by test. So the seam is
 * raw RGBA: exactly what `CanvasRenderingContext2D.getImageData()` hands back,
 * and exactly what a Node test can build by hand. The browser does the
 * decoding, this does the part that can be silently wrong.
 */

/** 240 x 320 portrait, from the specification. */
export const BOOT_IMAGE_WIDTH = 240
export const BOOT_IMAGE_HEIGHT = 320
/** 153,600 bytes: two per pixel, which is the whole payload. */
export const BOOT_IMAGE_BYTES = BOOT_IMAGE_WIDTH * BOOT_IMAGE_HEIGHT * 2

export class BootImageError extends Error {
  override readonly name = 'BootImageError'
}

export interface BootImagePixels {
  readonly rgba: Uint8ClampedArray
  readonly width: typeof BOOT_IMAGE_WIDTH
  readonly height: typeof BOOT_IMAGE_HEIGHT
}

/**
 * RGB565, and the B comes first for a reason.
 *
 * One 16-bit word per pixel: five bits of blue in the high end, six of green,
 * five of red in the low end.
 *
 *   bit  15 14 13 12 11 | 10  9  8  7  6  5 |  4  3  2  1  0
 *        b4 b3 b2 b1 b0 | g5 g4 g3 g2 g1 g0 | r4 r3 r2 r1 r0
 *
 * The specification names the format "RGB565" (`04-MEMORY-LAYOUT.md`, V-frame
 * 0x0E), and the conventional reading of that name puts the first-named channel
 * in the most significant bits, the same way "RGB565" puts red there.
 *
 * Getting this backwards is the failure this module exists to avoid. Read as
 * RGB565 the same bytes still produce a picture - correctly framed, correctly
 * shaped, with red and blue exchanged - so it looks like a working feature and
 * only a colour chart or a face gives it away. Green sits in the middle and is
 * untouched by the swap, which is why a test on green alone proves nothing.
 */
export function packRgb565(r: number, g: number, b: number): number {
  return ((quantise(r, 31) << 11) | (quantise(g, 63) << 5) | quantise(b, 31)) >>> 0
}

export function unpackRgb565(word: number): { r: number; g: number; b: number } {
  return {
    r: expand5((word >>> 11) & 0x1f),
    g: expand6((word >>> 5) & 0x3f),
    b: expand5(word & 0x1f),
  }
}

/**
 * Which half of the word goes into memory first.
 *
 * **Not stated by the specification and not visible in any capture.** It
 * gives the format a name and a size, and neither hardware capture reads or
 * writes 0x150000 at all, so there is no evidence either way. Little-endian is
 * the assumption taken here, because every other multi-byte field this radio
 * exchanges is little-endian: the 24-bit addresses, the 16-bit lengths, the
 * contact count.
 *
 * Confined to these two functions on purpose. If a real radio renders a written
 * image with its colours wrong in a way a red/blue swap cannot explain - stripes
 * or a hue rotation rather than blue skin - the byte order is the thing to flip,
 * and this is the only place it is decided.
 */
function readWord(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function writeWord(bytes: Uint8Array, offset: number, word: number): void {
  bytes[offset] = word & 0xff
  bytes[offset + 1] = (word >>> 8) & 0xff
}

/**
 * 8 bits to 5 or 6, rounded rather than truncated.
 *
 * Rounding is what makes the pair exact: `expand5(quantise(v, 31))` returns `v`
 * for every value 5 bits can hold, so re-encoding what was just decoded gives
 * back the same bytes. Truncation loses a step each way and the round-trip test
 * would have to be written loosely enough to stop catching anything.
 */
function quantise(value: number, max: number): number {
  const clamped = value <= 0 ? 0 : value >= 255 ? 255 : value
  return Math.round((clamped * max) / 255)
}

/** 31 -> 255 and 0 -> 0, by replicating the high bits into the low ones. */
const expand5 = (v: number) => (v << 3) | (v >> 2)
const expand6 = (v: number) => (v << 2) | (v >> 4)

export interface CropRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The largest centred rectangle of the source that has the radio's shape.
 *
 * Crop rather than stretch. A boot splash is nearly always a photo or a logo,
 * and 240 x 320 is a tall 3:4 frame; squeezing a landscape photo into it makes
 * everything in the picture narrow, which reads as a broken feature rather than
 * as a deliberate one. Losing the sides of a photo is what a phone lock screen
 * does and nobody complains.
 *
 * The edges are fractional on purpose - a 641-pixel-wide source has no integer
 * centre - and the resampler works in continuous coordinates, so they do not
 * need rounding here.
 */
export function centreCrop(width: number, height: number): CropRect {
  const aspect = BOOT_IMAGE_WIDTH / BOOT_IMAGE_HEIGHT
  if (width / height > aspect) {
    const cropped = height * aspect
    return { x: (width - cropped) / 2, y: 0, width: cropped, height }
  }
  const cropped = width / aspect
  return { x: 0, y: (height - cropped) / 2, width, height: cropped }
}

/**
 * RGBA pixels in, 153,600 bytes of RGB565 out.
 *
 * The source is scaled and centre-cropped to 240 x 320 by averaging over the
 * area each destination pixel covers. Area averaging rather than picking the
 * nearest source pixel because the usual input is a photograph several times
 * larger than the screen, and nearest-neighbour throws away most of it: fine
 * detail turns into aliasing, and text in a logo comes out broken.
 *
 * Alpha is composited over black. A radio powering up shows this on an unlit
 * LCD, so black is what "nothing here" already looks like, and a logo exported
 * with a transparent background lands the way its author drew it.
 */
export function encodeBootImage(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new BootImageError(`An image needs whole positive dimensions, not ${width} x ${height}`)
  }
  const needed = width * height * 4
  if (rgba.length < needed) {
    throw new BootImageError(`A ${width} x ${height} RGBA buffer is ${needed} bytes; this one is ${rgba.length}`)
  }

  const crop = centreCrop(width, height)
  const xStep = crop.width / BOOT_IMAGE_WIDTH
  const yStep = crop.height / BOOT_IMAGE_HEIGHT
  const out = new Uint8Array(BOOT_IMAGE_BYTES)

  for (let dy = 0; dy < BOOT_IMAGE_HEIGHT; dy++) {
    const top = crop.y + dy * yStep
    const bottom = top + yStep
    const firstRow = Math.max(Math.floor(top), 0)
    const lastRow = Math.min(Math.ceil(bottom), height)

    for (let dx = 0; dx < BOOT_IMAGE_WIDTH; dx++) {
      const left = crop.x + dx * xStep
      const right = left + xStep
      const firstCol = Math.max(Math.floor(left), 0)
      const lastCol = Math.min(Math.ceil(right), width)

      let r = 0
      let g = 0
      let b = 0
      let total = 0

      for (let sy = firstRow; sy < lastRow; sy++) {
        const weightY = Math.min(bottom, sy + 1) - Math.max(top, sy)
        if (weightY <= 0) continue
        const row = sy * width * 4
        for (let sx = firstCol; sx < lastCol; sx++) {
          const weightX = Math.min(right, sx + 1) - Math.max(left, sx)
          if (weightX <= 0) continue
          // Premultiplied by alpha, which is the compositing over black: a
          // fully transparent pixel contributes nothing but still counts
          // towards the area, so it darkens rather than being ignored.
          const p = row + sx * 4
          const weight = weightX * weightY
          const alpha = rgba[p + 3]! / 255
          r += rgba[p]! * alpha * weight
          g += rgba[p + 1]! * alpha * weight
          b += rgba[p + 2]! * alpha * weight
          total += weight
        }
      }

      const scale = total > 0 ? 1 / total : 0
      writeWord(out, (dy * BOOT_IMAGE_WIDTH + dx) * 2, packRgb565(r * scale, g * scale, b * scale))
    }
  }

  return out
}

/**
 * 153,600 bytes of RGB565 back into RGBA, for the preview.
 *
 * The preview is rendered from the encoded bytes rather than from the file the
 * user chose, so that a channel-order or byte-order mistake is visible on
 * screen before anything is written to a radio. Previewing the source file
 * would show a correct picture no matter what this module did to it.
 */
export function decodeBootImage(bytes: Uint8Array): BootImagePixels {
  if (bytes.length !== BOOT_IMAGE_BYTES) {
    throw new BootImageError(`A boot image is ${BOOT_IMAGE_BYTES} bytes; this one is ${bytes.length}`)
  }
  const rgba = new Uint8ClampedArray(BOOT_IMAGE_WIDTH * BOOT_IMAGE_HEIGHT * 4)
  for (let i = 0, o = 0; i < bytes.length; i += 2, o += 4) {
    const { r, g, b } = unpackRgb565(readWord(bytes, i))
    rgba[o] = r
    rgba[o + 1] = g
    rgba[o + 2] = b
    rgba[o + 3] = 255
  }
  return { rgba, width: BOOT_IMAGE_WIDTH, height: BOOT_IMAGE_HEIGHT }
}
