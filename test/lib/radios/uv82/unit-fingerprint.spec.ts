// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '#core/codec/checksum.js'
import { CHIRP_MAGIC } from '#core/io/chirp-img.js'
import { unitHashOf } from '#core/radios/uv82/driver.js'
import { IDENT_SIZE, IMAGE_SIZE, MAIN_SIZE } from '#core/radios/uv82/protocol.js'

/**
 * Whether the unit fingerprint tells apart radios `identHash` cannot.
 *
 * That is the whole claim, and the bench captures cannot test it: there is
 * one of each model on the bench. CHIRP's own test images hold a second UV-5G
 * that sends the bench UV-5G's ident and firmware, and a UV-5G Pro that sends
 * the bench UV-5R's. What is committed is the part of each image the claim
 * rests on - the ident, the firmware window and the 160 span bytes - in
 * uv5r-family-chirp-units.json, so CI holds the claim without the images.
 *
 * The images themselves are GPL-3.0 and fetched into the git-ignored
 * reference/ by `./scripts/fetch-reference.sh`. With them present the excerpt
 * is checked against them, and `BOOFWANG_FIXTURE=1` rewrites it from them.
 */
const FIXTURE = fileURLToPath(new URL('../../../fixtures/uv5r-family-chirp-units.json', import.meta.url))
const bench = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../fixtures/images/${name}`, import.meta.url))))
const chirpPath = (name: string) =>
  fileURLToPath(new URL(`../../../../reference/chirp-images/${name}`, import.meta.url))

/** `readFirmware` takes the version from aux block 0x1EC0 at offset 48. */
const FIRMWARE_AT = IDENT_SIZE + MAIN_SIZE + 48
const FIRMWARE_LENGTH = 14

/**
 * CHIRP's `_get_data_from_image` arguments, written out rather than taken from
 * UNIT_AREAS, so that the excerpt keeps meaning CHIRP's bytes if the constant
 * ever drifts from them - and the fingerprints below stop agreeing when it
 * does.
 */
const CHIRP_SPANS = [[0x1848, 0x18a8], [0x18b8, 0x18c8], [0x18d8, 0x1908]] as const

interface Excerpt {
  /** Of the `.img` file as CHIRP's repository serves it. */
  readonly sha256: string
  readonly ident: string
  readonly firmwareWindow: string
  readonly spans: string
}

const PAIRS = [
  { bench: 'uv5g-HN5RV011.bin', chirp: 'Radioddity_UV-5G.img', what: 'the bench UV-5G and CHIRP\'s', differ: 34 },
  { bench: 'uv5r-HN5RV011.bin', chirp: 'Baofeng_UV-5G_Pro.img', what: 'the bench UV-5R and CHIRP\'s UV-5G Pro', differ: 22 },
] as const
const CHIRP_IMAGES = [...PAIRS.map((p) => p.chirp), 'Baofeng_UV-5R.img', 'Baofeng_F-11.img'] as const
const fetched = CHIRP_IMAGES.every((name) => existsSync(chirpPath(name)))

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')
const unhex = (s: string) => Uint8Array.from(s.split(' ').map((h) => parseInt(h, 16)))

/** The memory of a CHIRP `.img`, trailer dropped, cut to this family's size. */
function chirpImage(name: string): Uint8Array {
  const data = new Uint8Array(readFileSync(chirpPath(name)))
  let end = data.length
  outer: for (let i = data.length - CHIRP_MAGIC.length; i >= 0; i--) {
    for (let j = 0; j < CHIRP_MAGIC.length; j++) if (data[i + j] !== CHIRP_MAGIC[j]) continue outer
    end = i
    break
  }
  // CHIRP's UV-5G image runs eight bytes past the family's 6,472, after the
  // aux area: its firmware string lines up at 0x1838, which the identify hash
  // below would not survive if the extra bytes came anywhere earlier.
  return data.slice(0, Math.min(end, IMAGE_SIZE))
}

const spansOf = (img: Uint8Array) => Uint8Array.from(CHIRP_SPANS.flatMap(([s, e]) => [...img.subarray(s, e)]))

function excerptOf(name: string): Excerpt {
  const img = chirpImage(name)
  return {
    sha256: '',
    ident: hex(img.subarray(0, IDENT_SIZE)),
    firmwareWindow: hex(img.subarray(FIRMWARE_AT, FIRMWARE_AT + FIRMWARE_LENGTH)),
    spans: hex(spansOf(img)),
  }
}

/** An image of only what the excerpt kept, each part where it came from. */
function imageOf(e: Excerpt): Uint8Array {
  const img = new Uint8Array(IMAGE_SIZE)
  img.set(unhex(e.ident), 0)
  img.set(unhex(e.firmwareWindow), FIRMWARE_AT)
  const spans = unhex(e.spans)
  let off = 0
  for (const [s, e2] of CHIRP_SPANS) {
    img.set(spans.subarray(off, off + e2 - s), s)
    off += e2 - s
  }
  return img
}

/**
 * The identify hash the driver would compute for the radio an image came from:
 * the eight ident bytes and the firmware window's printable ASCII, up to the
 * first byte that is not.
 */
async function identHashOf(img: Uint8Array): Promise<string> {
  let version = ''
  for (const b of img.subarray(FIRMWARE_AT, FIRMWARE_AT + FIRMWARE_LENGTH)) {
    if (b < 0x20 || b > 0x7e) break
    version += String.fromCharCode(b)
  }
  return sha256Hex(Uint8Array.from([...img.subarray(0, IDENT_SIZE), ...new TextEncoder().encode(version)]))
}

const excerpts = () => (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { images: Record<string, Excerpt> }).images

describe.runIf(!!process.env.BOOFWANG_FIXTURE && fetched)('rewriting the excerpt from CHIRP\'s images', () => {
  it('writes uv5r-family-chirp-units.json', async () => {
    const images: Record<string, Excerpt> = {}
    for (const name of CHIRP_IMAGES) {
      images[name] = { ...excerptOf(name), sha256: await sha256Hex(new Uint8Array(readFileSync(chirpPath(name)))) }
    }
    const about =
      'Excerpts of four UV-5R-family test images in CHIRP (kk7ds/chirp, tests/images, GPL-3.0): the ident, ' +
      'the firmware window at image 0x1838, and the 160 bytes of the three aux spans uv5r.py compares before ' +
      'it uploads the whole aux area, at image 0x1848-0x18A8, 0x18B8-0x18C8 and 0x18D8-0x1908. Written by ' +
      'test/lib/radios/uv82/unit-fingerprint.spec.ts with BOOFWANG_FIXTURE=1, and checked against the images ' +
      'whenever ./scripts/fetch-reference.sh has fetched them.'
    writeFileSync(FIXTURE, `${JSON.stringify({ about, images }, null, 2)}\n`)
  })
})

describe('radios identHash cannot tell apart', () => {
  for (const pair of PAIRS) {
    it(`separates ${pair.what}`, async () => {
      const ours = bench(pair.bench)
      const theirs = imageOf(excerpts()[pair.chirp]!)
      // Same ident, same firmware: to `identHash` these are one radio.
      expect(await identHashOf(theirs)).toBe(await identHashOf(ours))
      const a = spansOf(ours)
      const b = spansOf(theirs)
      expect(a.filter((x, i) => x !== b[i]).length).toBe(pair.differ)
      expect(await unitHashOf(theirs)).not.toBe(await unitHashOf(ours))
    })
  }

  it('gives every image it has seen a fingerprint of its own', async () => {
    const images = [
      ...['uv82-N822413.bin', 'uv5g-HN5RV011.bin', 'uv5r-HN5RV011.bin'].map(bench),
      ...CHIRP_IMAGES.map((name) => imageOf(excerpts()[name]!)),
    ]
    const prints = await Promise.all(images.map(unitHashOf))
    expect(prints).not.toContain(null)
    expect(new Set(prints).size).toBe(7)
  })
})

describe.skipIf(!fetched)('the excerpt, against CHIRP\'s images', () => {
  for (const name of CHIRP_IMAGES) {
    it(`is ${name} as CHIRP serves it`, async () => {
      const kept = excerpts()[name]!
      expect(await sha256Hex(new Uint8Array(readFileSync(chirpPath(name)))), 'the image changed upstream').toBe(
        kept.sha256,
      )
      expect(excerptOf(name)).toEqual({ ...kept, sha256: '' })
    })
  }
})
