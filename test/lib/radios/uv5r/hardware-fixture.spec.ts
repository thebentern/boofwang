// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { txFrequency } from '#core/model/channel.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5rDriver } from '#core/radios/uv5r/driver.js'
import { decodeSettings } from '#core/radios/uv82/driver.js'
import { REGIONS } from '#core/radios/uv82/layout.js'
import { IDENT_SIZE, IMAGE_SIZE } from '#core/radios/uv82/protocol.js'

/**
 * A real Baofeng UV-5R, read over an FTDI cable on 2026-09-05.
 *
 * The radio the whole classic family is named for, and the last one boofwang
 * got hold of. Firmware `HN5RV011!!!`, ident `aa 30 76 04 00 05 20 dd`, 6,472
 * bytes, sha256 `d783efb5...`. Read twice in separate sessions, byte-identical,
 * then written and restored to this exact image - see docs/protocols/uv5r.md.
 *
 * Distinct from `uv5g-HN5RV011.bin` by 2,240 bytes, which is why both are kept:
 * that one is a GMRS factory plug with 41 channels and eleven receive-only
 * NOAA markers, this one is 21 ordinary channels and none. `decode.spec.ts`
 * runs this driver over those bytes for the receive-only coverage this capture
 * cannot give.
 *
 * The expectations are not hand-written. `uv5r-chirp-decode.json` and
 * `uv5r-chirp-settings.json` come from `scripts/dump-uv5r-channels.py` and
 * `dump-uv5r-settings.py`, which parse this exact image with CHIRP's `bitwise`
 * engine and the `MEM_FORMAT` out of uv5r.py. So this is boofwang's UV-5R
 * decoder against CHIRP's, over the radio's own bytes, with neither side
 * written by the other.
 *
 * Committed after a scan, as any hardware capture must be: every channel is
 * unnamed, the power-on message is the factory `WELCOME`, and the DTMF and ANI
 * code region is byte-identical to the UV-5G capture already in this
 * directory - factory defaults, not somebody's identity.
 */
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv5r-HN5RV011.bin', import.meta.url))),
)

interface ChirpChannel {
  name: string
  rx: number
  tx: number
  bw: number
  power: string
  skip: string
  rxtone: { kind: string; deciHz?: number; code?: number; polarity?: string } | null
  txtone: { kind: string; deciHz?: number; code?: number; polarity?: string } | null
}

const CHIRP = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/uv5r-chirp-decode.json', import.meta.url)), 'utf8'),
) as Record<string, ChirpChannel>

const CHIRP_SETTINGS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/uv5r-chirp-settings.json', import.meta.url)), 'utf8'),
) as { settings: Record<string, number | string>; poweron_msg: { line1: string; line2: string } }

function image(): RadioImage {
  return {
    radioId: 'uv5r',
    variant: 'HN5RV011',
    layout: 'uv5r',
    createdAt: '2026-09-05T00:00:00.000Z',
    regions: [{ start: 0, data: RAW.slice(), readOnly: false, label: REGIONS[0].label }],
    meta: {},
    sha256: '',
  }
}

const driver = createUv5rDriver()

describe('the image the radio actually sent', () => {
  it('is ident + main + aux, the shape the classic family shares', () => {
    expect(RAW.length).toBe(IMAGE_SIZE)
    expect(IMAGE_SIZE).toBe(0x1948)
  })

  it('starts with the ident block this unit answered with', () => {
    expect([...RAW.subarray(0, IDENT_SIZE)]).toEqual([0xaa, 0x30, 0x76, 0x04, 0x00, 0x05, 0x20, 0xdd])
  })

  it('is not a 220 MHz radio, which byte 0x03 is what says so', () => {
    // CHIRP reads 0x02 there for the 220 MHz variant, whose bands are 130-176
    // and 220-260 MHz rather than the VHF/UHF pair this schema carries. This
    // unit reads 0x04, so the band plan on screen is the right one for it.
    expect(RAW[3]).not.toBe(0x02)
    expect(RAW[3]).toBe(0x04)
  })
})

describe('decoded channels agree with CHIRP’s UV-5R parser, field for field', () => {
  const cp = driver.decode(image())

  it('finds exactly the channels CHIRP finds', () => {
    const mine = [...cp.channels.keys()].sort((a, b) => a - b)
    const theirs = Object.keys(CHIRP).map(Number).sort((a, b) => a - b)
    expect(mine).toEqual(theirs)
    expect(mine.length).toBe(21)
  })

  it.each(Object.keys(CHIRP).map(Number).sort((a, b) => a - b))('channel %i matches', (index) => {
    const mine = cp.channels.get(index)!
    const theirs = CHIRP[String(index)]!
    expect(mine, `channel ${index} missing`).toBeDefined()
    expect(mine.name).toBe(theirs.name)
    expect(mine.rxFreq).toBe(theirs.rx)
    expect(mine.bandwidthHz).toBe(theirs.bw)
    expect(mine.power.label).toBe(theirs.power)
    expect(mine.skip).toBe(theirs.skip)
    expect(txFrequency(mine) ?? 0).toBe(theirs.tx)

    for (const [side, expected] of [
      ['rx', theirs.rxtone],
      ['tx', theirs.txtone],
    ] as const) {
      const got = side === 'rx' ? mine.tone.rx : mine.tone.tx
      if (expected === null) {
        expect(got, `channel ${index} ${side} tone`).toBeNull()
      } else if (expected.kind === 'ctcss') {
        expect(got).toEqual({ kind: 'ctcss', deciHz: expected.deciHz })
      } else {
        expect(got).toEqual({ kind: 'dtcs', code: expected.code, polarity: expected.polarity })
      }
    }
  })
})

describe('the settings block, against CHIRP', () => {
  const flatten = (settings: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(settings).map(([k, v]) => [k.includes('.') ? k.slice(k.indexOf('.') + 1) : k, v]),
    )
  const mine = flatten(decodeSettings(RAW))
  const fields = Object.entries(CHIRP_SETTINGS.settings).filter(([, v]) => typeof v === 'number')

  it('reads every numeric field CHIRP reads', () => {
    expect(fields.length).toBeGreaterThanOrEqual(48)
    expect(Object.keys(mine)).toEqual(expect.arrayContaining(fields.map(([k]) => k)))
  })

  it.each(fields)('agrees on %s', (key, value) => {
    expect(mine[key]).toBe(value)
  })

  it('reads the power-on message the radio shows, which is the factory default', () => {
    expect(mine.line1).toBe('WELCOME')
    expect(mine.line1).toBe(CHIRP_SETTINGS.poweron_msg.line1)
    expect(mine.line2).toBe(CHIRP_SETTINGS.poweron_msg.line2.trimEnd())
  })
})

describe('the round-trip invariant, on this radio’s own bytes', () => {
  it('encode(decode(image), image) is byte-identical', () => {
    // The invariant the encoder rests on, and since 2026-09-05 also the check
    // `writeImage` runs against the radio in hand before it sends anything -
    // it is what distinguishes this two-power radio from a tri-power BF-F8HP
    // reporting the same ambiguous firmware string.
    const img = image()
    const out = driver.encode(driver.decode(img), img)
    expect(equalBytes(out.regions[0]!.data, RAW)).toBe(true)
  })

  it('survives a settings round-trip untouched', () => {
    const img = image()
    const doc = driver.decode(img)
    expect(Object.keys(doc.settings).length).toBeGreaterThan(0)
    expect(equalBytes(driver.encode(doc, img).regions[0]!.data, RAW)).toBe(true)
  })
})
