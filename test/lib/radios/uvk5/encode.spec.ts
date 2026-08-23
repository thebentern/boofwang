// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { equalBytes } from '#core/codec/struct.js'
import { ctcss, dtcs, NO_TONE } from '#core/model/tones.js'
import { hz } from '#core/model/units.js'
import type { Channel } from '#core/model/channel.js'
import { DriverError } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUvk5Driver } from '#core/radios/uvk5/driver.js'
import {
  ATTR_BASE,
  NAME_BASE,
  PROG_END,
  REGIONS,
  UVK5_ATTRIBUTES,
  UVK5_CHANNEL,
  UVK5_NAME,
  attrAddr,
  channelAddr,
  nameAddr,
} from '#core/radios/uvk5/layout.js'
import { encodeShift, encodeToneField, eraseChannel, isErasedRecord } from '#core/radios/uvk5/encode.js'

const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uvk5-2.01.32.bin', import.meta.url))),
)

function realImage(): RadioImage {
  return {
    radioId: 'uvk5',
    variant: '2.01.32',
    layout: 'stock',
    createdAt: '2026-08-19T18:54:00.000Z',
    regions: REGIONS.map((r) => ({
      start: r.start,
      data: RAW.slice(r.start, r.start + r.length),
      readOnly: r.readOnly,
      label: r.label,
    })),
    meta: {},
    sha256: '',
  }
}

const driver = createUvk5Driver()
const flat = (img: RadioImage) => {
  const out = new Uint8Array(0x2000)
  for (const r of img.regions) out.set(r.data, r.start)
  return out
}

describe('the round-trip invariant', () => {
  /**
   * The property the entire write path rests on, asserted against an EEPROM a
   * real radio produced. Nothing is written to hardware unless this holds:
   * decoding an image and encoding it straight back must not move a single
   * byte, including every byte this driver has never modelled.
   */
  it('encode(decode(image), image) is byte-identical', () => {
    const image = realImage()
    const round = driver.encode(driver.decode(image), image)
    expect(equalBytes(flat(round), RAW)).toBe(true)
  })

  it('leaves calibration untouched and still marked read-only', () => {
    const image = realImage()
    const round = driver.encode(driver.decode(image), image)
    const cal = round.regions.find((r) => r.label === 'calibration')!
    expect(cal.readOnly).toBe(true)
    expect(equalBytes(cal.data, RAW.subarray(0x1d00, 0x2000))).toBe(true)
  })

  it('leaves everything outside the tables it owns untouched', () => {
    // Settings at 0x0E70, DTMF contacts at 0x1C00, the boot logo at 0x0EB0 -
    // all read, none modelled, and all of it has to survive.
    const image = realImage()
    const round = flat(driver.encode(driver.decode(image), image))
    const owned = driver.ownedRanges(0)
    const isOwned = (i: number) => owned.some(([s, e]) => i >= s && i < e)
    for (let i = 0; i < PROG_END; i++) {
      if (!isOwned(i)) expect(round[i], `byte 0x${i.toString(16)}`).toBe(RAW[i])
    }
  })

  it('does not mutate the image it was given', () => {
    const image = realImage()
    const before = flat(image)
    driver.encode(driver.decode(image), image)
    expect(equalBytes(flat(image), before)).toBe(true)
  })
})

describe('editing a channel changes only that channel', () => {
  it('renaming touches exactly one name record', () => {
    const image = realImage()
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'W4ABC' })
    const out = flat(driver.encode(cp, image))

    for (let i = 0; i < 0x2000; i++) {
      const inNameRecord = i >= NAME_BASE && i < NAME_BASE + 16
      if (!inNameRecord) expect(out[i], `byte 0x${i.toString(16)}`).toBe(RAW[i])
    }
    expect(UVK5_NAME.read(out, NAME_BASE).name).toBe('W4ABC')
  })

  it('writes the name NUL-padded, as the radio itself does', () => {
    const image = realImage()
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'W4ABC' })
    const out = flat(driver.encode(cp, image))
    expect([...out.subarray(NAME_BASE, NAME_BASE + 16)]).toEqual([
      0x57, 0x34, 0x41, 0x42, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ])
  })

  it('truncates a name to the ten characters the radio displays', () => {
    const image = realImage()
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'ABCDEFGHIJKLMNOP' })
    const out = flat(driver.encode(cp, image))
    expect(UVK5_NAME.read(out, NAME_BASE).name).toBe('ABCDEFGHIJ')
  })

  it('changing a frequency touches exactly one channel record', () => {
    const image = realImage()
    const cp = driver.decode(image)
    cp.channels.set(3, { ...cp.channels.get(3)!, rxFreq: hz(145_500_000) })
    const out = flat(driver.encode(cp, image))
    const addr = channelAddr(2)
    for (let i = 0; i < 0x2000; i++) {
      if (i < addr || i >= addr + 16) expect(out[i], `byte 0x${i.toString(16)}`).toBe(RAW[i])
    }
    expect(UVK5_CHANNEL.read(out, addr).freq).toBe(145_500_000)
  })

  it('preserves the reserved bits of a record it edits', () => {
    // A used record is patched in place rather than rebuilt, so bits this
    // driver does not model carry through from the radio's own data.
    const image = realImage()
    const poked = flat(image)
    const addr = channelAddr(0)
    poked[addr + 0x0c] = poked[addr + 0x0c]! | 0b1110_0000 // the reserved top bits
    const region = image.regions.find((r) => r.start === 0)!
    region.data.set(poked.subarray(0, region.data.length))

    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'ZZZ' })
    const out = flat(driver.encode(cp, image))
    expect(out[addr + 0x0c]! & 0b1110_0000).toBe(0b1110_0000)
  })
})

describe('deleting a channel', () => {
  it('erases the record, the name and the attribute byte', () => {
    const image = realImage()
    const cp = driver.decode(image)
    cp.channels.delete(1)
    const out = flat(driver.encode(cp, image))

    expect(isErasedRecord(out, channelAddr(0))).toBe(true)
    expect([...out.subarray(NAME_BASE, NAME_BASE + 16)]).toEqual(Array(16).fill(0xff))
    // CHIRP marks a free slot with is_free = 1 and band = 7.
    const attr = UVK5_ATTRIBUTES.read(out, ATTR_BASE).attr
    expect(attr).toMatchObject({ isFree: 1, band: 7, isScanlist1: 0, isScanlist2: 0, compander: 0 })
  })

  it('leaves neighbouring channels alone', () => {
    const image = realImage()
    const cp = driver.decode(image)
    cp.channels.delete(5)
    const out = flat(driver.encode(cp, image))
    expect(equalBytes(out.subarray(channelAddr(5), channelAddr(6)), RAW.subarray(channelAddr(5), channelAddr(6)))).toBe(
      true,
    )
    expect(UVK5_NAME.read(out, nameAddr(5)).name).toBe('CH006')
  })

  it('round-trips a deletion: decoding the result no longer sees the channel', () => {
    const image = realImage()
    const cp = driver.decode(image)
    cp.channels.delete(1)
    const written = driver.encode(cp, image)
    expect(driver.decode(written).channels.has(1)).toBe(false)
    expect(driver.decode(written).channels.has(2)).toBe(true)
  })
})

describe('creating a channel in an empty slot', () => {
  const fresh = (over: Partial<Channel> = {}): Channel => ({
    index: 50,
    name: 'NEW',
    rxFreq: hz(146_940_000),
    tx: { kind: 'offset', direction: 'minus', offset: hz(600_000) },
    txAllowed: true,
    tone: { rx: null, tx: ctcss(885), rxInverted: false },
    modulation: 'FM',
    bandwidthHz: 25_000,
    power: { mW: 5000 as never, label: 'High' },
    tuningStep: hz(12_500),
    skip: 'none',
    comment: '',
    extras: {},
    ...over,
  })

  it('zeroes the erased record first, so reserved bits do not start set', () => {
    const image = realImage()
    const cp = driver.decode(image)
    expect(isErasedRecord(RAW, channelAddr(49))).toBe(true)
    cp.channels.set(50, fresh())
    const out = flat(driver.encode(cp, image))
    const rec = UVK5_CHANNEL.read(out, channelAddr(49))
    expect(rec.freq).toBe(146_940_000)
    expect(rec.offset).toBe(600_000)
    // Unmodelled bits are zero rather than the 0xFF they would have inherited.
    expect(rec.flags1.unknown7).toBe(0)
    expect(rec.flags2.unknown7).toBe(0)
  })

  it('marks the attribute byte in use with the right band', () => {
    const image = realImage()
    const cp = driver.decode(image)
    cp.channels.set(50, fresh())
    const out = flat(driver.encode(cp, image))
    const attr = UVK5_ATTRIBUTES.read(out, attrAddr(49)).attr
    expect(attr.isFree).toBe(0)
    expect(attr.band).toBe(2) // 137-174 MHz
  })

  it('survives a decode', () => {
    const image = realImage()
    const cp = driver.decode(image)
    cp.channels.set(50, fresh())
    const back = driver.decode(driver.encode(cp, image)).channels.get(50)!
    expect(back).toMatchObject({ name: 'NEW', rxFreq: 146_940_000, modulation: 'FM' })
    expect(back.tx).toEqual({ kind: 'offset', direction: 'minus', offset: 600_000 })
    expect(back.tone.tx).toEqual({ kind: 'ctcss', deciHz: 885 })
  })
})

describe('transmit inhibit', () => {
  const ch = (over: Partial<Channel>): Channel => ({
    index: 60, name: 'WX', rxFreq: hz(162_550_000), tx: { kind: 'simplex' }, txAllowed: true,
    tone: NO_TONE, modulation: 'FM', bandwidthHz: 12_500,
    power: { mW: 1500 as never, label: 'Low' }, tuningStep: hz(5000),
    skip: 'none', comment: '', extras: {}, ...over,
  })

  it('parks the transmit frequency at 0 MHz', () => {
    // The radio has no inhibit bit; CHIRP fakes it with a minus shift whose
    // offset equals the receive frequency.
    const { shift, offset } = encodeShift(ch({ txAllowed: false }))
    expect(shift).toBe(0b10)
    expect(offset).toBe(162_550_000)
  })

  it('wins over a repeater shift the channel also carries', () => {
    const { shift, offset } = encodeShift(
      ch({ txAllowed: false, tx: { kind: 'offset', direction: 'plus', offset: hz(600_000) } }),
    )
    expect(shift).toBe(0b10)
    expect(offset).toBe(162_550_000)
  })

  it('round-trips through the image', () => {
    const image = realImage()
    const cp = driver.decode(image)
    cp.channels.set(60, ch({ txAllowed: false }))
    const back = driver.decode(driver.encode(cp, image)).channels.get(60)!
    expect(back.txAllowed).toBe(false)
    expect(back.txInhibitReason).toMatch(/0 MHz/)
  })

  it('refuses a split, which this radio cannot store', () => {
    expect(() => encodeShift(ch({ tx: { kind: 'split', txFreq: hz(147_000_000) } }))).toThrow(/split/)
  })
})

describe('tones', () => {
  it('maps CTCSS and DTCS to the radio’s flag and index', () => {
    expect(encodeToneField(ctcss(885), 'x')).toEqual({ flag: 1, code: 8 })
    expect(encodeToneField(dtcs(23, 'N'), 'x')).toEqual({ flag: 2, code: 0 })
    expect(encodeToneField(dtcs(31, 'R'), 'x')).toEqual({ flag: 3, code: 3 })
    expect(encodeToneField(null, 'x')).toEqual({ flag: 0, code: 0 })
  })

  it('refuses an unsupported tone rather than silently dropping it', () => {
    // Quietly turning 12.3 Hz into "no tone" changes a channel that opens on a
    // specific tone into one that opens on anything.
    expect(() => encodeToneField(ctcss(123), 'Channel 9 transmit tone')).toThrow(/not one of the 50 CTCSS/)
    expect(() => encodeToneField(dtcs(999), 'Channel 9')).toThrow(/DTCS code 999/)
  })

  it('round-trips every supported tone through a real image', () => {
    const image = realImage()
    const base = driver.decode(image)
    for (const deciHz of [670, 885, 1000, 2541]) {
      const cp = { ...base, channels: new Map(base.channels) }
      cp.channels.set(1, { ...base.channels.get(1)!, tone: { rx: ctcss(deciHz), tx: ctcss(deciHz), rxInverted: false } })
      const back = driver.decode(driver.encode(cp, image)).channels.get(1)!
      expect(back.tone.tx).toEqual({ kind: 'ctcss', deciHz })
      expect(back.tone.rx).toEqual({ kind: 'ctcss', deciHz })
    }
  })
})

describe('encode rejects what it cannot honour', () => {
  it('refuses a codeplug for a different radio', () => {
    const image = realImage()
    const cp = driver.decode(image)
    expect(() => driver.encode({ ...cp, radio: 'dm32uv' }, image)).toThrow(DriverError)
  })

  it('refuses an image from a different radio', () => {
    const image = realImage()
    const cp = driver.decode(image)
    expect(() => driver.encode(cp, { ...image, radioId: 'dm32uv' })).toThrow(/Not a UV-K5 image/)
  })

  it('refuses single sideband rather than quietly writing it as FM', () => {
    // Stock firmware has one bit for the demodulator. Egzumer channels do
    // decode as USB now, and one carried across to a stock image would
    // otherwise land as wideband FM on a frequency chosen for SSB.
    const image = realImage()
    const cp = driver.decode(image)
    const ch = cp.channels.get(1)!
    cp.channels.set(1, { ...ch, modulation: 'USB' })
    expect(() => driver.encode(cp, image)).toThrow(/can store FM or AM, not USB/)
  })
})

describe('arbitrary edits still preserve everything unowned', () => {
  it('holds across randomised channel changes', () => {
    const image = realImage()
    const owned = driver.ownedRanges(0)
    const isOwned = (i: number) => owned.some(([s, e]) => i >= s && i < e)

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 17 }),
        fc.string({ minLength: 0, maxLength: 10, unit: fc.constantFrom(...'ABCDEFG0123 '.split('')) }),
        fc.integer({ min: 136_000_000, max: 173_000_000 }),
        fc.boolean(),
        (slot, name, freq, txAllowed) => {
          const cp = driver.decode(image)
          cp.channels.set(slot, {
            ...cp.channels.get(slot)!,
            name,
            rxFreq: hz(freq - (freq % 2500)),
            txAllowed,
          })
          const out = flat(driver.encode(cp, image))
          for (let i = 0; i < 0x2000; i++) {
            if (!isOwned(i)) expect(out[i]).toBe(RAW[i])
          }
        },
      ),
      { numRuns: 120 },
    )
    /*
     * A real budget, not the 5s default.
     *
     * 120 runs, each encoding a whole 8 KiB image and then comparing every byte
     * outside the owned ranges - that is genuinely seconds of work, and it sat
     * close enough to the default to fail perhaps one run in three on a loaded
     * machine. That was tolerable while it only cost a re-run; it stopped being
     * tolerable when releases started gating on this suite across three
     * platforms, where a flake means a tag builds nothing.
     *
     * The budget moves rather than `numRuns`, because the run count is the
     * coverage: this is the test that would catch an encoder touching a byte it
     * does not own, and there is no version of it worth making faster by
     * looking at less.
     */
  }, 30_000)
})

describe('eraseChannel', () => {
  it('does not touch a VFO slot’s non-existent name or attributes', () => {
    const mem = RAW.slice()
    const before = mem.slice()
    eraseChannel(mem, 205) // a VFO pseudo-channel
    for (let i = 0; i < mem.length; i++) {
      const inRecord = i >= channelAddr(205) && i < channelAddr(205) + 16
      if (!inRecord) expect(mem[i], `byte 0x${i.toString(16)}`).toBe(before[i])
    }
  })
})
