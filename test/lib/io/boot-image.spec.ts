// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import {
  BOOT_IMAGE_BYTES,
  BOOT_IMAGE_HEIGHT,
  BOOT_IMAGE_WIDTH,
  BootImageError,
  centreCrop,
  decodeBootImage,
  encodeBootImage,
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
describe('BGR565', () => {
  it('puts red in the low five bits and blue in the high five', () => {
    expect(wordAt(encodeBootImage(solid(240, 320, RED), 240, 320), 0)).toBe(0x001f)
    expect(wordAt(encodeBootImage(solid(240, 320, GREEN), 240, 320), 0)).toBe(0x07e0)
    expect(wordAt(encodeBootImage(solid(240, 320, BLUE), 240, 320), 0)).toBe(0xf800)
  })

  it('writes the low byte of the word first', () => {
    // The byte order is an assumption, not something the specification states.
    // Pinning it here means a hardware finding that contradicts it breaks a
    // test with a name rather than quietly changing the pixels.
    expect([...encodeBootImage(solid(240, 320, RED), 240, 320).subarray(0, 2)]).toEqual([0x1f, 0x00])
    expect([...encodeBootImage(solid(240, 320, BLUE), 240, 320).subarray(0, 2)]).toEqual([0x00, 0xf8])
  })

  it('does not encode red the way an RGB565 encoder would', () => {
    // 0xF800 is red under RGB565 and blue under BGR565. If these two ever come
    // out equal, the channels have been swapped.
    const red = wordAt(encodeBootImage(solid(240, 320, RED), 240, 320), 0)
    const blue = wordAt(encodeBootImage(solid(240, 320, BLUE), 240, 320), 0)
    expect(red).not.toBe(0xf800)
    expect(blue).toBe(0xf800)
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
