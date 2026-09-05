// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { txFrequency } from '#core/model/channel.js'
import { DTCS_CODES } from '#core/model/tones.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5rDriver } from '#core/radios/uv5r/driver.js'
import { UV5R_SCHEMA } from '#core/radios/uv5r/schema.js'
import { createUv5gDriver } from '#core/radios/uv5g/driver.js'
import { CHANNEL_COUNT, channelAddr, REGIONS as FAMILY_REGIONS } from '#core/radios/uv82/layout.js'
import { decodeChannel } from '#core/radios/uv82/driver.js'
import { IMAGE_SIZE } from '#core/radios/uv82/protocol.js'

/**
 * There is no UV-5R capture, and this file does not pretend otherwise.
 *
 * Nobody working on boofwang has had one of these on a cable, so what follows
 * runs the UV-5R driver over bytes read from a *Radioddity UV-5G* - a real
 * radio, read over an FTDI cable, firmware HN5RV011. That is a fair test of
 * this driver and a fair test of nothing else, and the reason it is worth
 * anything at all is upstream's own structure: CHIRP's `RadioddityUV5GRadio`
 * is a bare subclass of `BaofengUV5R` with no memory map of its own, so these
 * really are UV-5R bytes in a UV-5G's shell.
 *
 * The expectations are not hand-written either. `uv5g-chirp-decode.json` comes
 * from `scripts/dump-uv5r-channels.py`, which parses this exact image with
 * CHIRP's `bitwise` engine and the `MEM_FORMAT` out of **uv5r.py** - the plain
 * UV-5R's own format string. So the comparison below is boofwang's UV-5R
 * decoder against CHIRP's UV-5R decoder over real hardware data, with neither
 * side written by the other.
 *
 * What none of this can do is prove a UV-5R ever answered a magic, that the
 * band plan matches the radio, or that a write lands where it is aimed. Only a
 * radio can do that. See docs/protocols/uv5r.md.
 */
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv5g-HN5RV011.bin', import.meta.url))),
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
  readFileSync(fileURLToPath(new URL('../../../fixtures/uv5g-chirp-decode.json', import.meta.url)), 'utf8'),
) as Record<string, ChirpChannel>

/** The family bytes, presented to the driver as the radio it is being tested as. */
function image(): RadioImage {
  return {
    radioId: 'uv5r',
    variant: 'BFB297',
    layout: 'uv5r',
    createdAt: '2026-09-04T00:00:00.000Z',
    regions: [{ start: 0, data: RAW.slice(), readOnly: false, label: 'image' }],
    meta: {},
    sha256: '',
  }
}

const driver = createUv5rDriver()

describe('the image shape this driver expects', () => {
  it('is ident + main + aux, the shape the whole classic family shares', () => {
    expect(RAW.length).toBe(IMAGE_SIZE)
    expect(IMAGE_SIZE).toBe(0x1948)
    // `_memsize` in uv5r.py is 0x1808 - ident plus main - and the aux area is
    // read separately and appended, which is what makes the file 0x1948. One
    // region covers the lot: there is no calibration area to hold back.
    expect(FAMILY_REGIONS.map((r) => [r.start, r.length, r.readOnly])).toEqual([[0, IMAGE_SIZE, false]])
  })
})

describe('decoded channels agree with CHIRP’s UV-5R parser, field for field', () => {
  const cp = driver.decode(image())

  it('finds exactly the channels CHIRP finds', () => {
    const mine = [...cp.channels.keys()].sort((a, b) => a - b)
    const theirs = Object.keys(CHIRP).map(Number).sort((a, b) => a - b)
    expect(mine).toEqual(theirs)
    expect(mine.length).toBe(41)
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

  it('reads the same channels the verified sibling driver reads', () => {
    /*
     * The strongest thing that can be said without a radio: this driver and
     * the UV-5G's, which has been verified on hardware, disagree about nothing
     * on these bytes. If a schema difference between them ever reached the
     * decoder - the power table is the one that could - this is where it
     * surfaces, because power is the single field `decodeChannel` takes from
     * the schema rather than from the struct.
     */
    const theirs = createUv5gDriver().decode({ ...image(), radioId: 'uv5g', layout: 'uv5g' })
    expect([...theirs.channels.keys()]).toEqual([...cp.channels.keys()])
    for (const [index, ch] of cp.channels) {
      expect(ch, `channel ${index}`).toEqual(theirs.channels.get(index))
    }
  })
})

describe('receive-only survives the trip', () => {
  it('decodes the FF-filled transmit frequency as a channel that transmits nowhere', () => {
    // Eleven NOAA channels in this factory plug carry FF FF FF FF. Reading one
    // as transmit-capable is how a weather frequency ends up in a radio
    // somebody can key up, so it is checked against the bytes and not only
    // against the fixture.
    const cp = driver.decode(image())
    const rxOnly = [...cp.channels.values()].filter((c) => !c.txAllowed)
    expect(rxOnly).toHaveLength(11)
    for (const ch of rxOnly) {
      const at = channelAddr(ch.index - 1)
      expect([...RAW.subarray(at + 4, at + 8)], ch.name).toEqual([0xff, 0xff, 0xff, 0xff])
    }
  })

  it('keeps the marker byte for byte through a re-encode', () => {
    const img = image()
    const out = driver.encode(driver.decode(img), img).regions[0]!.data
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const ch = decodeChannel(RAW, i)
      if (!ch || ch.txAllowed) continue
      const at = channelAddr(i)
      expect([...out.subarray(at + 4, at + 8)], `slot ${i + 1}`).toEqual([0xff, 0xff, 0xff, 0xff])
    }
  })
})

describe('the round-trip invariant, on real classic-family bytes', () => {
  it('encode(decode(image), image) is byte-identical', () => {
    const img = image()
    const out = driver.encode(driver.decode(img), img)
    expect(equalBytes(out.regions[0]!.data, RAW)).toBe(true)
  })

  it('survives a settings round-trip untouched', () => {
    // A settings transcription can look right, round-trip perfectly and still
    // be reading the wrong bytes - which is what the CHIRP cross-check catches
    // and this does not. What this catches is an encoder that writes a field
    // it was only asked to read.
    const img = image()
    const doc = driver.decode(img)
    expect(Object.keys(doc.settings).length).toBeGreaterThan(0)
    expect(equalBytes(driver.encode(doc, img).regions[0]!.data, RAW)).toBe(true)
  })
})

describe('what the schema claims about this radio', () => {
  it('is a Baofeng UV-5R, read-only until a radio says otherwise', () => {
    expect(UV5R_SCHEMA.vendor).toBe('Baofeng')
    expect(UV5R_SCHEMA.model).toBe('UV-5R')
    expect(UV5R_SCHEMA.status).toBe('read-only')
    expect(UV5R_SCHEMA.capabilities.write).toBe(false)
    expect(driver.schema.capabilities.write).toBe(false)
  })

  it('carries the badges the same radio is resold under', () => {
    // CHIRP's ALIASES on BaofengUV5RGeneric. Someone holding a Retevis RT5R
    // has to be able to find this driver.
    expect(UV5R_SCHEMA.aliases).toContain('Retevis RT5R')
    expect(UV5R_SCHEMA.aliases).toContain('Baofeng UV-5X')
  })

  it('transmits on both bands, and stops at 520 MHz where the UV-82 stops at 521', () => {
    // `_uhf_range` on BaofengUV5R against the UV-82's. One megahertz, and the
    // reason the two radios do not share a constant.
    expect(UV5R_SCHEMA.rf.bands.map((b) => [b.loHz, b.hiHz, b.txAllowed])).toEqual([
      [130_000_000, 176_000_000, true],
      [400_000_000, 520_000_000, true],
    ])
  })

  it('models two power levels, High first, because `lowPower` indexes this table', () => {
    expect(UV5R_SCHEMA.rf.powerLevels.map((p) => [p.label, p.mW])).toEqual([
      ['High', 4000],
      ['Low', 1000],
    ])
  })

  it('carries the family’s 105-code DTCS table, not the standard 104', () => {
    // The extra 645 shifts every index above it. Using the standard table
    // would mis-decode a large part of the range on a radio somebody owns.
    expect(UV5R_SCHEMA.rf.dtcsCodes).toHaveLength(DTCS_CODES.length + 1)
    expect(UV5R_SCHEMA.rf.dtcsCodes).toContain(645)
  })

  it('says how this radio spells receive-only', () => {
    expect(UV5R_SCHEMA.rf.txInhibit).toEqual({ mechanism: 'Transmit frequency set to zero' })
  })

  it('drops the two settings that are UV-82 hardware', () => {
    // CHIRP offers `singleptt` and `vfomrlock` only to the UV-82 family, the
    // UV-82HP and the F-11. This radio has one PTT button.
    const keys = UV5R_SCHEMA.settings.flatMap((g) => g.fields.map((f) => f.key))
    expect(keys).not.toContain('f2b.singleptt')
    expect(keys).not.toContain('f2b.vfomrlock')
    expect(keys.length).toBeGreaterThan(20)
  })

  it('owns the same three ranges as the rest of the family, whose layout this is', () => {
    expect(driver.ownedRanges(0)).toEqual([
      [0x0008, 0x0808],
      [0x0e28, 0x0e58],
      [0x1008, 0x1808],
    ])
  })
})
