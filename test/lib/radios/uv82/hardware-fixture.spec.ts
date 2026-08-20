// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { equalBytes } from '#core/codec/struct.js'
import { txFrequency } from '#core/model/channel.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv82Driver, decodeChannel, decodeToneWord } from '#core/radios/uv82/driver.js'
import {
  CHANNEL_COUNT,
  NAME_BASE,
  UV82_CHANNEL,
  UV82_DTCS,
  UV82_NAME,
  channelAddr,
  nameAddr,
} from '#core/radios/uv82/layout.js'
import { IMAGE_SIZE } from '#core/radios/uv82/protocol.js'

/**
 * A real Baofeng UV-82, read over an FTDI cable: firmware N822413, 0x1948
 * bytes (8 ident + 0x1800 main + 0x140 aux).
 *
 * The expectations are not hand-written. `uv82-chirp-decode.json` was produced
 * by parsing this exact image with CHIRP's own `bitwise` engine and the
 * `MEM_FORMAT` from `uv5r.py`, applying CHIRP's own empty test and tone
 * decoding. So this asserts agreement with the reference implementation on real
 * hardware data, which is a different and much stronger claim than agreement
 * with a second reading of the same spec by the same author.
 */
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv82-N822413.bin', import.meta.url))),
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
  readFileSync(fileURLToPath(new URL('../../../fixtures/uv82-chirp-decode.json', import.meta.url)), 'utf8'),
) as Record<string, ChirpChannel>

function image(): RadioImage {
  return {
    radioId: 'uv82',
    variant: 'N822413',
    layout: 'uv82',
    createdAt: '2026-08-19T21:00:00.000Z',
    regions: [{ start: 0, data: RAW.slice(), readOnly: false, label: 'image' }],
    meta: {},
    sha256: '',
  }
}

const driver = createUv82Driver()

describe('the image itself', () => {
  it('is ident + main + aux', () => {
    expect(RAW.length).toBe(IMAGE_SIZE)
    expect(IMAGE_SIZE).toBe(0x1948)
  })

  it('starts with the ident block the radio sent', () => {
    expect([...RAW.subarray(0, 8)]).toEqual([0xaa, 0x30, 0x79, 0x04, 0x00, 0x05, 0x20, 0xdd])
  })
})

describe('decoded channels agree with CHIRP field for field', () => {
  const cp = driver.decode(image())

  it('finds exactly the channels CHIRP finds', () => {
    const mine = [...cp.channels.keys()].sort((a, b) => a - b)
    const theirs = Object.keys(CHIRP).map(Number).sort((a, b) => a - b)
    expect(mine).toEqual(theirs)
    expect(mine.length).toBe(39)
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

    // CHIRP stores an absolute transmit frequency; we express it as a shift, so
    // compare the frequency that would actually be transmitted.
    expect(txFrequency(mine) ?? 0).toBe(theirs.tx === theirs.rx || theirs.tx === 0 ? (theirs.tx || 0) : theirs.tx)

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

describe('empty slots', () => {
  /**
   * This radio does not blank a whole record when a slot is unused. From slot
   * 28 upwards the test unit reads `ff 00 57 15 00 00 57 15 ...` - only the
   * first byte is 0xFF. CHIRP's test is that first byte alone, and a
   * whole-record check would have turned a hundred empty slots into channels
   * near 155.7 MHz.
   */
  it('treats a leading 0xFF as empty even when the rest of the record is not', () => {
    const addr = channelAddr(27)
    expect(RAW[addr]).toBe(0xff)
    expect([...RAW.subarray(addr + 1, addr + 8)]).not.toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    expect(decodeChannel(RAW, 27)).toBeNull()
  })

  it('decodes the slot immediately after a run of empties', () => {
    // Slot 29 (channel 30) is Green Dot, right after the empty run starts.
    expect(decodeChannel(RAW, 29)).toMatchObject({ name: 'Green D', rxFreq: 154_600_000 })
  })

  it('finds no channel in a fully blank slot', () => {
    expect(decodeChannel(RAW, 0)).toBeNull()
  })
})

describe('this family’s own encodings', () => {
  it('has 105 DTCS codes, the standard 104 plus 645', () => {
    // The extra entry shifts every index above it, so the standard table would
    // silently mis-decode a large part of the range.
    expect(UV82_DTCS).toHaveLength(105)
    expect(UV82_DTCS).toContain(645)
    expect([...UV82_DTCS]).toEqual([...UV82_DTCS].sort((a, b) => a - b))
  })

  it('reads a tone word as CHIRP does', () => {
    expect(decodeToneWord(0)).toBeNull()
    expect(decodeToneWord(0xffff)).toBeNull()
    expect(decodeToneWord(885)).toEqual({ kind: 'ctcss', deciHz: 885 })
    expect(decodeToneWord(1)).toEqual({ kind: 'dtcs', code: UV82_DTCS[0], polarity: 'N' })
    expect(decodeToneWord(0x6a)).toEqual({ kind: 'dtcs', code: UV82_DTCS[0], polarity: 'R' })
  })

  it('treats `wide` as wide, the opposite sense to the UV-K5', () => {
    // Two radios in one codebase, two conventions: here 1 means 25 kHz, on the
    // UV-K5 the equivalent bit set means 12.5 kHz.
    const murs = driver.decode(image()).channels.get(24)!
    const blueDot = driver.decode(image()).channels.get(27)!
    expect(UV82_CHANNEL.read(RAW, channelAddr(23)).f0f.wide).toBe(0)
    expect(murs.bandwidthHz).toBe(12_500)
    expect(UV82_CHANNEL.read(RAW, channelAddr(26)).f0f.wide).toBe(1)
    expect(blueDot.bandwidthHz).toBe(25_000)
  })

  it('derives a repeater shift from the stored transmit frequency', () => {
    // The family stores an absolute transmit frequency rather than a shift.
    const rpt = driver.decode(image()).channels.get(31)!
    expect(rpt.name).toBe('N5AT')
    expect(rpt.rxFreq).toBe(145_130_000)
    expect(rpt.tx).toEqual({ kind: 'offset', direction: 'minus', offset: 600_000 })
    expect(txFrequency(rpt)).toBe(144_530_000)
  })
})

describe('the round-trip invariant, on real radio bytes', () => {
  it('reading and writing back every channel record changes nothing', () => {
    const buf = RAW.slice()
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const addr = channelAddr(i)
      UV82_CHANNEL.write(buf, addr, UV82_CHANNEL.read(buf, addr))
    }
    expect(equalBytes(buf, RAW)).toBe(true)
  })

  it('reading and writing back every name changes nothing', () => {
    const buf = RAW.slice()
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const addr = nameAddr(i)
      UV82_NAME.write(buf, addr, UV82_NAME.read(buf, addr))
    }
    expect(equalBytes(buf, RAW)).toBe(true)
  })

  it('holds for arbitrary mutations of a real record', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: CHANNEL_COUNT - 1 }),
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        (slot, noise) => {
          const buf = RAW.slice()
          const addr = channelAddr(slot)
          for (let i = 0; i < 16; i++) buf[addr + i] = buf[addr + i]! ^ noise[i]!
          const before = buf.slice()
          UV82_CHANNEL.write(buf, addr, UV82_CHANNEL.read(buf, addr))
          expect(equalBytes(buf, before)).toBe(true)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('what the driver claims to own', () => {
  it('claims the channel and name tables, and not the ident block', () => {
    const owned = driver.ownedRanges(0)
    expect(owned).toEqual([
      [0x0008, 0x0008 + CHANNEL_COUNT * 16],
      [NAME_BASE, NAME_BASE + CHANNEL_COUNT * 16],
    ])
    // The ident prefix is metadata the radio sent, not memory to write back.
    expect(owned.some(([s]) => s < 8)).toBe(false)
  })
})

describe('writing', () => {
  it('encodes even when the driver cannot write', () => {
    // Encoding is needed for the diff and for saving a file, both of which are
    // useful on a build that will not send anything. The refusal belongs on
    // writeImage, which is the only thing that reaches a radio.
    expect(() => driver.encode(driver.decode(image()), image())).not.toThrow()
  })

  it('stays disabled unless the build asks for it', () => {
    // The registry turns writing on. A driver built for a test or a file import
    // cannot reach a radio at all.
    expect(driver.schema.capabilities.write).toBe(false)
  })
})
