// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import {
  BOOT_IMAGE_BYTES,
  BOOT_IMAGE_HEIGHT,
  BOOT_IMAGE_WIDTH,
  BootImageError,
  centreCrop,
  cropRect,
  DEFAULT_FRAMING,
  decodeBootImage,
  encodeBootImage,
  packRgb565,
  unpackRgb565,
} from '#core/io/boot-image.js'

type Rgba = [number, number, number, number]

const RED: Rgba = [255, 0, 0, 255]
const GREEN: Rgba = [0, 255, 0, 255]
const BLUE: Rgba = [0, 0, 255, 255]

function rgba(width: number, height: number, at: (x: number, y: number) => Rgba): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = at(x, y)
      const p = (y * width + x) * 4
      out[p] = r
      out[p + 1] = g
      out[p + 2] = b
      out[p + 3] = a
    }
  }
  return out
}

const solid = (width: number, height: number, colour: Rgba) => rgba(width, height, () => colour)

/** The 16-bit word for pixel `i`, low byte first. */
const wordAt = (bytes: Uint8Array, i: number) => bytes[i * 2]! | (bytes[i * 2 + 1]! << 8)

const words = (bytes: Uint8Array) => Array.from({ length: bytes.length / 2 }, (_, i) => wordAt(bytes, i))

const pixelAt = (rgbaOut: Uint8ClampedArray, x: number, y: number) => {
  const p = (y * BOOT_IMAGE_WIDTH + x) * 4
  return [rgbaOut[p]!, rgbaOut[p + 1]!, rgbaOut[p + 2]!, rgbaOut[p + 3]!]
}

/**
 * The channel order is the whole point.
 *
 * Read as RGB565 the same bytes still make a picture - right shape, right
 * framing, red and blue exchanged - so the mistake survives every check that
 * only looks at whether something appeared on screen. These tests pin the exact
 * 16-bit values, because that is the only assertion the swap cannot pass.
 */
describe('RGB565', () => {
  it('puts red in the high five bits and blue in the low five', () => {
    expect(wordAt(encodeBootImage(solid(240, 320, RED), 240, 320), 0)).toBe(0xf800)
    expect(wordAt(encodeBootImage(solid(240, 320, GREEN), 240, 320), 0)).toBe(0x07e0)
    expect(wordAt(encodeBootImage(solid(240, 320, BLUE), 240, 320), 0)).toBe(0x001f)
  })

  it('writes the low byte of the word first', () => {
    expect([...encodeBootImage(solid(240, 320, RED), 240, 320).subarray(0, 2)]).toEqual([0x00, 0xf8])
    expect([...encodeBootImage(solid(240, 320, BLUE), 240, 320).subarray(0, 2)]).toEqual([0x1f, 0x00])
  })

  it('does not encode red the way a BGR565 encoder would', () => {
    /*
     * This test used to assert the opposite, and it passed.
     *
     * The specification calls the format BGR565 - twice, with no diagram and no
     * byte order - and decoding the factory splash as BGR565 produced a gold
     * BAOFENG logo, which looked right because Baofeng's logo is orange. It was
     * not right. Writing a colour chart to a real radio and looking at the
     * panel put red at the top only when red was encoded in the HIGH bits. The
     * factory splash therefore displays blue on the radio, and the render that
     * looked correct was the wrong one.
     *
     * That is the whole reason this file exists: a channel swap produces a
     * picture that is perfectly plausible, and the only thing that catches it
     * is a known pattern on the actual display.
     */
    const red = wordAt(encodeBootImage(solid(240, 320, RED), 240, 320), 0)
    const blue = wordAt(encodeBootImage(solid(240, 320, BLUE), 240, 320), 0)
    expect(red).toBe(0xf800)
    expect(blue).not.toBe(0xf800)
    expect(red).not.toBe(blue)
  })

  it('round-trips red, green and blue back to themselves', () => {
    // Exact, not approximate: 0 and 255 are the two values 5 bits can represent
    // perfectly, so a swap or a rounding mistake shows up as a whole channel
    // moving rather than as a shade.
    for (const colour of [RED, GREEN, BLUE]) {
      const back = decodeBootImage(encodeBootImage(solid(240, 320, colour), 240, 320))
      expect(pixelAt(back.rgba, 0, 0)).toEqual(colour)
      expect(pixelAt(back.rgba, BOOT_IMAGE_WIDTH - 1, BOOT_IMAGE_HEIGHT - 1)).toEqual(colour)
    }
  })
})

describe('encodeBootImage', () => {
  it('produces exactly what the region holds', () => {
    const bytes = encodeBootImage(solid(240, 320, RED), 240, 320)
    expect(bytes.length).toBe(153_600)
    expect(BOOT_IMAGE_BYTES).toBe(BOOT_IMAGE_WIDTH * BOOT_IMAGE_HEIGHT * 2)
  })

  it('re-encodes a decoded image byte for byte', () => {
    // Two properties at once. The 5- and 6-bit round trip has to be exact, and
    // resampling a 240 x 320 source must be the identity rather than something
    // that shifts the picture half a pixel. Anything off by one row or column
    // fails here on 153,600 bytes of noise.
    const original = new Uint8Array(BOOT_IMAGE_BYTES)
    let seed = 0x1234_5678
    for (let i = 0; i < original.length; i++) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
      original[i] = (seed >>> 24) & 0xff
    }

    const { rgba: pixels, width, height } = decodeBootImage(original)
    expect(equalBytes(encodeBootImage(pixels, width, height), original)).toBe(true)
  })

  it('composites transparency over black', () => {
    // A logo exported with a transparent background lands on an unlit LCD, so
    // black is what its author already saw behind it.
    const clear = encodeBootImage(solid(240, 320, [255, 255, 255, 0]), 240, 320)
    expect(words(clear).every((w) => w === 0)).toBe(true)

    const half = decodeBootImage(encodeBootImage(solid(240, 320, [255, 255, 255, 128]), 240, 320))
    // Mid grey, within the step size of a 5-bit channel. Not exactly equal
    // across the three: green has an extra bit and quantises differently.
    for (const channel of pixelAt(half.rgba, 0, 0).slice(0, 3)) {
      expect(channel).toBeGreaterThan(120)
      expect(channel).toBeLessThan(140)
    }
  })

  it('refuses dimensions that do not describe the buffer it was given', () => {
    expect(() => encodeBootImage(new Uint8ClampedArray(4), 2, 2)).toThrow(BootImageError)
    expect(() => encodeBootImage(new Uint8ClampedArray(0), 0, 0)).toThrow(BootImageError)
    expect(() => encodeBootImage(solid(4, 4, RED), 4.5, 4)).toThrow(BootImageError)
  })
})

describe('decodeBootImage', () => {
  it('returns the dimensions the radio uses', () => {
    const out = decodeBootImage(new Uint8Array(BOOT_IMAGE_BYTES))
    expect([out.width, out.height]).toEqual([240, 320])
    expect(out.rgba.length).toBe(240 * 320 * 4)
  })

  it('makes every pixel opaque', () => {
    const out = decodeBootImage(new Uint8Array(BOOT_IMAGE_BYTES).fill(0x5a))
    const alphas = new Set<number>()
    for (let i = 3; i < out.rgba.length; i += 4) alphas.add(out.rgba[i]!)
    expect([...alphas]).toEqual([255])
  })

  it('rejects anything that is not a whole region', () => {
    // A short read is the realistic way to get here, and half a picture
    // rendered as a preview would look like a radio problem rather than ours.
    expect(() => decodeBootImage(new Uint8Array(BOOT_IMAGE_BYTES - 2))).toThrow(BootImageError)
    expect(() => decodeBootImage(new Uint8Array(BOOT_IMAGE_BYTES + 2))).toThrow(BootImageError)
  })
})

describe('scale and crop', () => {
  it('takes the largest centred rectangle with the shape of the screen', () => {
    expect(centreCrop(480, 320)).toEqual({ x: 120, y: 0, width: 240, height: 320 })
    expect(centreCrop(240, 640)).toEqual({ x: 0, y: 160, width: 240, height: 320 })
    expect(centreCrop(240, 320)).toEqual({ x: 0, y: 0, width: 240, height: 320 })
    expect(centreCrop(1200, 1600)).toEqual({ x: 0, y: 0, width: 1200, height: 1600 })
  })

  it('drops the sides of a landscape source rather than squeezing them in', () => {
    // Red everywhere the centre crop should discard, green inside it. A
    // stretch keeps the red; a crop cannot.
    const source = rgba(480, 320, (x) => (x >= 120 && x < 360 ? GREEN : RED))
    expect(words(encodeBootImage(source, 480, 320)).every((w) => w === 0x07e0)).toBe(true)
  })

  it('drops the top and bottom of a tall source', () => {
    const source = rgba(240, 640, (_x, y) => (y >= 160 && y < 480 ? GREEN : RED))
    expect(words(encodeBootImage(source, 240, 640)).every((w) => w === 0x07e0)).toBe(true)
  })

  it('scales the whole frame when the aspect already matches', () => {
    // 480 x 640 is 240 x 320 doubled, so nothing is cropped and the boundary
    // between the halves has to land exactly halfway across.
    const source = rgba(480, 640, (x) => (x < 240 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
    const out = words(encodeBootImage(source, 480, 640))
    for (const y of [0, 159, 319]) {
      expect(out[y * BOOT_IMAGE_WIDTH + 119]).toBe(0x0000)
      expect(out[y * BOOT_IMAGE_WIDTH + 120]).toBe(0xffff)
    }
  })

  it('averages over the area a destination pixel covers', () => {
    // Downscaling by picking one source pixel out of each block would return
    // pure black or pure white here. The average of a checkerboard is grey.
    const source = rgba(480, 640, (x, y) => ((x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
    const back = decodeBootImage(encodeBootImage(source, 480, 640))
    for (const channel of pixelAt(back.rgba, 10, 10).slice(0, 3)) {
      expect(channel).toBeGreaterThan(115)
      expect(channel).toBeLessThan(140)
    }
  })
})

/**
 * Facts from the radio, without shipping the radio's picture.
 *
 * The factory splash is Baofeng's artwork and is not in the repository. What is
 * pinned here is what reading it settled: the byte order, which the
 * specification never states, and which is otherwise only an assumption that
 * happens to be self-consistent.
 *
 * `docs/protocols/dm32uv.md` has the session. Rendering the same bytes as
 * RGB565 produced the identical splash with the logo blue - perfect layout,
 * legible text, wrong colour - which is exactly why this is a test and not a
 * comment.
 */
describe('what a real DM-32UV showed on its own panel', () => {
  it('puts red at the top of a colour chart, which is how the channel order was settled', () => {
    // A chart of solid bands was written to a radio and photographed by eye.
    // Encoded with blue in the high bits the top band came out blue; encoded
    // with red in the high bits it came out red. The panel is the only
    // authority here, because both encodings produce a plausible picture.
    expect(packRgb565(255, 0, 0)).toBe(0xf800)
    expect(packRgb565(0, 0, 255)).toBe(0x001f)
  })

  it('shows its factory splash in blue, which is the corollary nobody expects', () => {
    // The stored splash has its high bits clear and its low bits set on the
    // lettering. Under the channel order the panel actually uses, that is blue.
    // Decoding it as BGR565 gives gold, which is what Baofeng's printed logo
    // looks like and is why the wrong answer went unquestioned for a while.
    const stored = 0x0724 // a lit pixel from the logo, as the radio stores it
    const { r, b } = unpackRgb565(stored)
    expect(b).toBeGreaterThan(r)
  })
})

/**
 * Framing: where in the source the picture is taken from.
 *
 * A fixed centre crop is the wrong answer often enough to matter - the subject
 * of a photograph is usually not in the middle, and a logo on a wide banner is
 * nowhere near it - so the crop takes a zoom and a centre. The maths lives here
 * rather than in the component because a rectangle that drifts outside the
 * source produces black edges, and that is worth a test rather than an eye.
 */
describe('cropRect', () => {
  it('is the centre crop when nothing has been moved', () => {
    expect(cropRect(640, 480, DEFAULT_FRAMING)).toEqual(centreCrop(640, 480))
  })

  it('takes less of the source as the zoom goes up', () => {
    const one = cropRect(640, 480, DEFAULT_FRAMING)
    const two = cropRect(640, 480, { ...DEFAULT_FRAMING, zoom: 2 })
    expect(two.width).toBeCloseTo(one.width / 2)
    expect(two.height).toBeCloseTo(one.height / 2)
  })

  it('keeps the radio’s shape at every zoom', () => {
    for (const zoom of [1, 1.5, 3, 8]) {
      const r = cropRect(1000, 700, { ...DEFAULT_FRAMING, zoom })
      expect(r.width / r.height).toBeCloseTo(BOOT_IMAGE_WIDTH / BOOT_IMAGE_HEIGHT, 6)
    }
  })

  it('stops at the edge rather than running off it', () => {
    // Dragging past the corner must stop the frame, not show blank: a crop
    // outside the source samples nothing and comes out black.
    for (const [cx, cy] of [[0, 0], [1, 1], [-5, 9], [0.5, 0]]) {
      const r = cropRect(640, 480, { zoom: 2, centreX: cx!, centreY: cy! })
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.width).toBeLessThanOrEqual(640 + 1e-9)
      expect(r.y + r.height).toBeLessThanOrEqual(480 + 1e-9)
    }
  })

  it('refuses to zoom out past the whole frame', () => {
    // Below 1 there is no more source to show, only padding.
    expect(cropRect(640, 480, { ...DEFAULT_FRAMING, zoom: 0.25 })).toEqual(centreCrop(640, 480))
  })

  it('survives nonsense without producing a rectangle outside the source', () => {
    const r = cropRect(640, 480, { zoom: Number.NaN, centreX: Number.NaN, centreY: Infinity })
    expect(Number.isFinite(r.x) && Number.isFinite(r.width)).toBe(true)
    expect(r.x + r.width).toBeLessThanOrEqual(640 + 1e-9)
  })

  it('changes which pixels the encoder reads', () => {
    // Left half red, right half green. Framed left it encodes red; right, green.
    const w = 480, h = 320
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (x < w / 2) rgba[i] = 255
        else rgba[i + 1] = 255
        rgba[i + 3] = 255
      }
    }
    const left = decodeBootImage(encodeBootImage(rgba, w, h, { zoom: 2, centreX: 0, centreY: 0.5 }))
    const right = decodeBootImage(encodeBootImage(rgba, w, h, { zoom: 2, centreX: 1, centreY: 0.5 }))
    expect([left.rgba[0], left.rgba[1], left.rgba[2]]).toEqual([255, 0, 0])
    expect([right.rgba[0], right.rgba[1], right.rgba[2]]).toEqual([0, 255, 0])
  })
})
