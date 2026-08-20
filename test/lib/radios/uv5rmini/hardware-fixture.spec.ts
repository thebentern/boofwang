// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { createUv5rMiniDriver } from '#core/radios/uv5rmini/driver.js'
import { VARIANTS, imageSize } from '#core/radios/uv5rmini/protocol.js'
import { exportChirpCsv } from '#core/io/chirp-csv.js'
import type { RadioImage } from '#core/radio/image.js'

/**
 * A real Baofeng UV-5R Mini, read over an FTDI cable.
 *
 * It answers to `PROGRAMCOLORPROU` and reports `5RMINI  +L00000`, so it is the
 * three-region 999-channel variant rather than the four-region `5RM`. The
 * codeplug is factory default: 21 unnamed channels across 2 m and 70 cm, no
 * tones, and nothing personal in it - the printable-string scan over all 33,344
 * bytes finds no run of four or more characters.
 *
 * The bytes here are byte-identical to what the app produced through its own
 * read path, and to an independent raw read taken outside the app.
 */
const BLOB = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv5rmini-5RMINI.bin', import.meta.url))),
)
const INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv5rmini-5RMINI.index.json', import.meta.url)), 'utf8'),
) as { sha256: string; bytes: number; ident4d: string; regions: { start: number; size: number }[] }

const variant = VARIANTS.find((v) => v.id === 'uv5rmini')!

function image(): RadioImage {
  let off = 0
  const regions = variant.regions.map((r) => {
    const data = BLOB.slice(off, off + r.size)
    off += r.size
    return { start: r.start, data, label: r.label }
  })
  return {
    radioId: 'uv5rmini',
    variant: INDEX.ident4d,
    layout: 'uv5rmini',
    createdAt: '2026-08-20T00:00:00.000Z',
    regions,
    meta: {},
    sha256: INDEX.sha256,
  }
}

const driver = createUv5rMiniDriver()
const writableDriver = createUv5rMiniDriver({ enableWrite: true })

describe('a real UV-5R Mini', () => {
  it('is the size the three-region variant says it is', () => {
    expect(BLOB.length).toBe(INDEX.bytes)
    expect(BLOB.length).toBe(imageSize(variant))
    expect(BLOB.length).toBe(0x8240)
  })

  it('identifies as the UV-5R Mini rather than the 5RM', () => {
    // The radio answered PROGRAMCOLORPROU. Had it been the 5RM the image would
    // be 0x8380 and the power table would have three entries.
    expect(INDEX.ident4d).toContain('5RMINI')
    expect(variant.channelCount).toBe(999)
    expect(variant.power).toHaveLength(2)
  })

  it('decodes the 21 channels the radio ships with, and nothing else', () => {
    const doc = driver.decode(image())
    expect(doc.channels.size).toBe(21)
    expect(driver.validate(doc)).toEqual([])
  })

  it('reads the frequencies the radio actually holds', () => {
    const doc = driver.decode(image())
    const hz = [...doc.channels.values()].map((c) => c.rxFreq)
    expect(hz.slice(0, 5)).toEqual([144_925_000, 144_525_000, 145_125_000, 145_525_000, 145_985_000])
    expect(hz[15]).toBe(439_975_000)
    expect(hz[20]).toBe(435_525_000)
  })

  it('splits the power levels where the radio splits them', () => {
    // Channels 1-16 are High and 17-21 are Low on this unit. On the UV-5R Mini
    // High is 5 W; reading it with the 5RM's table would call it 8 W.
    const doc = driver.decode(image())
    const mw = [...doc.channels.values()].map((c) => c.power.mW)
    expect(new Set(mw.slice(0, 16))).toEqual(new Set([5000]))
    expect(new Set(mw.slice(16))).toEqual(new Set([1000]))
  })

  it('reads every channel as wide FM, because the wide bit is clear', () => {
    // The bit CHIRP calls `wide` means narrow. Clear means 25 kHz. Trusting the
    // name would report every one of these as narrow.
    const doc = driver.decode(image())
    for (const ch of doc.channels.values()) {
      expect(ch.bandwidthHz).toBe(25_000)
      expect(ch.modulation).toBe('FM')
    }
  })

  it('finds no tones, and does not invent one from blank memory', () => {
    const doc = driver.decode(image())
    for (const ch of doc.channels.values()) {
      expect(ch.tone).toEqual({ rx: null, tx: null, rxInverted: false })
    }
  })

  it('exports a CSV CHIRP accepts', () => {
    // Pinned from a run of scripts/crosscheck-chirp-csv.py against this exact
    // file: CHIRP parsed all 21 channels and re-exported it byte for byte
    // identically.
    const csv = exportChirpCsv(driver.decode(image()), { header: [] })
    const rows = csv.split('\r\n').filter(Boolean)
    expect(rows).toHaveLength(22) // header + 21
    expect(rows[1]).toBe('1,,144.925000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,5.0W,,,,,')
    expect(rows[17]).toBe('17,,431.525000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,1.0W,,,,,')
  })

  it('has nothing personal in it', () => {
    // The guard that should have existed before a DM-32UV fixture went in with
    // fourteen real AES keys. No run of four printable characters anywhere.
    let run = 0
    let longest = 0
    for (const b of BLOB) {
      run = b >= 0x20 && b < 0x7f ? run + 1 : 0
      longest = Math.max(longest, run)
    }
    expect(longest).toBeLessThan(4)
  })
})

describe('the rest of the image', () => {
  it('decodes radio-wide settings from the real fixture', () => {
    /*
     * The last of the image nobody had read. It lives in the 64-byte region the
     * radio serves from 0x9000, which is image offset 0x8040 once the three
     * regions are concatenated - CHIRP's `#seekto` values are image offsets.
     *
     * The values are checked against the unit these bytes came from: a squelch
     * of 3 and a 120-second timeout are settings, not noise, which is what
     * distinguishes a correct offset from a plausible-looking wrong one.
     */
    const doc = driver.decode(image())
    const s = doc.settings as Record<string, number>

    expect(s.squelch).toBe(3)
    expect(s.timeout).toBe(8)
    expect(s.vox).toBe(4)
    expect(s.beep).toBe(1)

    // Every field is a byte, so anything outside that is a bad offset.
    for (const [k, v] of Object.entries(s)) {
      expect(typeof v, k).toBe('number')
      expect(v, k).toBeGreaterThanOrEqual(0)
      expect(v, k).toBeLessThanOrEqual(255)
    }
  })

  it('still round-trips byte-for-byte with settings decoded', () => {
    // Decoding them must not tempt the encoder into writing them back: nothing
    // edits settings yet, and normalising a byte nobody asked to change is what
    // breaks the invariant the whole write path rests on.
    const img = image()
    const out = writableDriver.encode(writableDriver.decode(img), img)
    for (let r = 0; r < img.regions.length; r++) {
      expect(equalBytes(out.regions[r]!.data, img.regions[r]!.data), `region ${r}`).toBe(true)
    }
  })
})
