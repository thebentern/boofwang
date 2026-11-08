// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Channel } from '#core/model/channel.js'
import type { Codeplug } from '#core/model/codeplug.js'
import { hz, mW } from '#core/model/units.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { BLANK_CHANNEL, CHANNEL_SIZE, channelSlot, isChannelRecordEmpty } from '#core/radios/dm32uv/layout.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'

/**
 * A channel that arrives with nothing to say about a field.
 *
 * `createChannel`, preset staging, CSV import and the repeater directories all
 * place channels with no `extras.vendor`, so the record they land on decided
 * the color code, the slot, encryption and the rest. On a record boofwang had
 * erased to 0xFF - every deletion does that - and on the 0xFF records that
 * fill most of this radio's channel blocks, that meant encryption on with key
 * 255, color code 15 and time slot 2, on a channel nobody had configured.
 */
const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/images/${name}`, import.meta.url))
const BLOB = new Uint8Array(readFileSync(fixture('dm32uv-DM32.01.01.040.blocks.bin')))
const INDEX = JSON.parse(readFileSync(fixture('dm32uv-DM32.01.01.040.index.json'), 'utf8')) as {
  model: string
  firmware: string
  blocks: { id: number; physical: number; offset: number }[]
}

function image(): RadioImage {
  return {
    radioId: 'dm32uv',
    variant: INDEX.firmware,
    layout: INDEX.model,
    createdAt: '2026-08-19T21:30:00.000Z',
    regions: INDEX.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: BLOB.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
    meta: { placements: INDEX.blocks.map((b) => ({ blockId: b.id, physical: b.physical })) },
    sha256: '',
  }
}

const driver = createDm32uvDriver()

/** Channel `n`'s 48 bytes, as a copy. */
function record(img: RadioImage, n: number): Uint8Array {
  const at = channelSlot(n)!
  const page = img.regions.find((r) => r.start === logicalAddress(at.blockId))!.data
  return page.slice(at.offset, at.offset + CHANNEL_SIZE)
}

/** Channel `n`'s record in place, for arranging what a radio might hold. */
function recordIn(img: RadioImage, n: number): { page: Uint8Array; at: number } {
  const slot = channelSlot(n)!
  return { page: img.regions.find((r) => r.start === logicalAddress(slot.blockId))!.data, at: slot.offset }
}

/** A channel as `createChannel` makes one: every field the model has, and no vendor block. */
function fresh(index: number, modulation: 'FM' | 'DMR'): Channel {
  return {
    index,
    name: 'FRESH',
    rxFreq: hz(451_012_500),
    tx: { kind: 'simplex' },
    txAllowed: true,
    tone: { rx: null, tx: null, rxInverted: false },
    modulation,
    bandwidthHz: 12_500,
    power: { mW: mW(1000), label: 'Low' },
    tuningStep: hz(12_500),
    skip: 'none',
    comment: '',
    extras: {},
  }
}

/** Written and then read in a fresh session, as far as the bytes go. */
const reread = (doc: Codeplug, base: RadioImage) => driver.decode(driver.encode(doc, base))

/** What a decoded channel reports for the fields a fresh one never mentioned. */
function unsaid(c: Channel | undefined) {
  const v = c?.extras.vendor ?? {}
  return {
    encryptEnabled: v.encryptEnabled,
    encryptionKeyId: v.encryptionKeyId,
    colorCode: v.colorCode,
    timeSlot: v.timeSlot,
    loneWorker: v.loneWorker,
    scanAdd: v.scanAdd,
    scanList: v.scanList,
  }
}

/** The radio's own blank record, read as a channel's fields. */
const CLEAN = {
  encryptEnabled: '0',
  encryptionKeyId: '0',
  colorCode: '0',
  timeSlot: '1',
  loneWorker: '0',
  scanAdd: '0',
  scanList: '0',
}

describe('the blank record', () => {
  it('is what this radio holds in the slots it has never used', () => {
    // Pinned to the capture rather than restated, so the constant cannot drift
    // from the radio it was read off. Slots 72-75 hold stale records from an
    // older codeplug and 77-84 are zeros; the rest of the block's tail is this.
    const base = image()
    const matching: number[] = []
    for (let n = 46; n <= 84; n++) {
      if (record(base, n).every((b, i) => b === BLANK_CHANNEL[i])) matching.push(n)
    }
    expect(matching).toEqual([...Array.from({ length: 26 }, (_, i) => 46 + i), 76])
  })

  it('counts erased and zeroed records as empty, and nothing that holds a value', () => {
    // The reference's own definition of an empty slot: every byte 0xFF or
    // 0x00. A real channel and the blank record both hold more than fill.
    expect(isChannelRecordEmpty(new Uint8Array(CHANNEL_SIZE).fill(0xff))).toBe(true)
    expect(isChannelRecordEmpty(new Uint8Array(CHANNEL_SIZE))).toBe(true)
    const mixed = new Uint8Array(CHANNEL_SIZE).fill(0xff)
    mixed.fill(0x00, 0x10)
    expect(isChannelRecordEmpty(mixed)).toBe(true)
    expect(isChannelRecordEmpty(BLANK_CHANNEL)).toBe(false)
    expect(isChannelRecordEmpty(record(image(), 1))).toBe(false)
  })
})

describe('a channel created where one was deleted', () => {
  // The first write erases channel 45's record, as every deletion does. The
  // channel is created in a later session, from a read of that radio.
  const base = image()
  const gone = driver.decode(base)
  gone.channels.delete(45)
  const erased = driver.encode(gone, base)

  it('starts from the record a deletion leaves, which the radio reads as empty', () => {
    expect(record(erased, 45).every((b) => b === 0xff)).toBe(true)
  })

  for (const modulation of ['FM', 'DMR'] as const) {
    it(`comes back with nothing it was not given, as ${modulation}`, () => {
      const doc = driver.decode(erased)
      doc.channels.set(45, fresh(45, modulation))
      const back = reread(doc, erased).channels.get(45)
      expect(back?.modulation).toBe(modulation)
      expect(unsaid(back)).toEqual(CLEAN)
    })

    it(`is byte for byte the channel created where none ever was, as ${modulation}`, () => {
      // Slot 46 is past the count and holds the radio's blank record, which is
      // the case the 2026-08-20 session put on the radio and read back. A
      // channel created over an erased record should be that case exactly.
      const there = driver.decode(erased)
      there.channels.set(45, fresh(45, modulation))
      const pastCount = driver.decode(base)
      pastCount.channels.set(46, fresh(46, modulation))
      expect(record(driver.encode(there, erased), 45)).toEqual(record(driver.encode(pastCount, base), 46))
    })
  }
})

describe('a channel created where the radio left nothing', () => {
  it('comes back clean in block 0x13, whose records are all 0xFF on this radio', () => {
    // Not a corner: every slot from 85 up in this unit's allocated channel
    // blocks is erased fill, so this was the ordinary result of creating a
    // channel past the first block.
    const base = image()
    expect(record(base, 85).every((b) => b === 0xff)).toBe(true)
    const doc = driver.decode(base)
    doc.channels.set(85, fresh(85, 'DMR'))
    expect(unsaid(reread(doc, base).channels.get(85))).toEqual(CLEAN)
  })

  it('carries nothing over from residue past the count', () => {
    // Slot 72 holds a stale DMR record from an older codeplug. The count says
    // it is not a channel, so a channel created there is built on the blank
    // record, the same as one created at 46.
    const base = image()
    expect(isChannelRecordEmpty(record(base, 72))).toBe(false)
    const atResidue = driver.decode(base)
    atResidue.channels.set(72, fresh(72, 'DMR'))
    const atBlank = driver.decode(base)
    atBlank.channels.set(46, fresh(46, 'DMR'))
    expect(record(driver.encode(atResidue, base), 72)).toEqual(record(driver.encode(atBlank, base), 46))
  })
})

describe('a channel placed over another', () => {
  /*
   * Channel 42 given encryption on key 7, lone worker and scan-list membership
   * in its bytes, as another CPS might leave a channel. Then replaced in the
   * document by a channel with no vendor block - which is what staging a
   * preset or importing a CSV over an occupied slot does.
   */
  function occupied(): RadioImage {
    const base = image()
    const { page, at } = recordIn(base, 42)
    // Encryption on (0x1F bit 6) with key slot 7 (0x1E), where the OEM CPS
    // puts them.
    page[at + 0x1f] = page[at + 0x1f]! | 0x40
    page[at + 0x1e] = 7
    page[at + 0x18] = page[at + 0x18]! | 0x01
    page[at + 0x19] = page[at + 0x19]! | 0x40
    return base
  }

  it('does not take the encryption, key, slot or flags of the channel it replaced', () => {
    const base = occupied()
    const doc = driver.decode(base)
    // What the decoder made of the arranged bytes, so a pass below means
    // something.
    expect(unsaid(doc.channels.get(42))).toMatchObject({
      encryptEnabled: '1',
      encryptionKeyId: '7',
      loneWorker: '1',
      scanAdd: '1',
      colorCode: '2',
    })
    doc.channels.set(42, fresh(42, 'DMR'))
    expect(unsaid(reread(doc, base).channels.get(42))).toEqual(CLEAN)
  })

  it('still carries the bytes nobody has decoded', () => {
    // That record held a real channel, so its unexplained bytes are that
    // radio's, and stay where they are. Only an empty or uncounted record is
    // rebuilt from the blank one.
    const base = occupied()
    const before = record(base, 42)
    const doc = driver.decode(base)
    doc.channels.set(42, fresh(42, 'DMR'))
    const after = record(driver.encode(doc, base), 42)
    for (const off of [0x1a, 0x1b, 0x1c, 0x20, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2c, 0x2d, 0x2e, 0x2f]) {
      expect(after[off], `byte 0x${off.toString(16)}`).toBe(before[off])
    }
    // 0x1F is the enable bit and six bits of RX group list nobody models.
    expect(after[0x1f]! & ~0x40, 'byte 0x1f, all but bit 6').toBe(before[0x1f]! & ~0x40)
  })

  it('keeps every field a channel does carry, which is every channel the decoder made', () => {
    // The other direction of the same rule: a channel read from this radio
    // names all of these, so nothing about it falls back to anything.
    const base = occupied()
    const doc = driver.decode(base)
    const back = reread(doc, base).channels.get(42)
    expect(unsaid(back)).toEqual(unsaid(doc.channels.get(42)))
  })
})
