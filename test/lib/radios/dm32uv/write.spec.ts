// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { equalBytes } from '#core/codec/struct.js'
import { diffImages } from '#core/radio/diff.js'
import { BackupRequiredError, DriverError, type BackupRef } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import type { Channel } from '#core/model/channel.js'
import { createDm32uvDriver, decodeChannel, encodeChannel, encodeKeys } from '#core/radios/dm32uv/driver.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import {
  CHANNEL_BLOCK_FIRST,
  CHANNEL_BLOCK_LAST,
  RADIOID_BLOCK,
  TXCONTACT_BLOCK_LOW,
  TXCONTACT_BLOCK_HIGH,
  MESSAGE_BLOCK,
  ROAMCHANNEL_BLOCK,
  RXGROUP_BLOCK,
  SCANLIST_BLOCK,
  SETTINGS_BLOCK,
  CHANNEL_HEADER,
  CHANNEL_SIZE,
  channelSlot,
  KEY_AREA,
  KEY_BLOCK,
  KEY_SLOTS,
  TALKGROUP_BLOCK_FIRST,
  TALKGROUP_BLOCK_LAST,
  ZONE_BLOCK_FIRST,
  ZONE_BLOCK_LAST,
  keySlotOffset,
} from '#core/radios/dm32uv/layout.js'

const BLOB = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.blocks.bin', import.meta.url))),
)
const INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.index.json', import.meta.url)), 'utf8'),
) as { firmware: string; model: string; blocks: { id: number; physical: number; offset: number }[] }

function image(): RadioImage {
  return {
    radioId: 'dm32uv',
    variant: INDEX.firmware,
    layout: INDEX.model,
    createdAt: '2026-08-19T22:00:00.000Z',
    regions: INDEX.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: BLOB.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
    meta: {},
    sha256: '',
  }
}

const driver = createDm32uvDriver()
const writable = createDm32uvDriver({ enableWrite: true })
const KEY_BLOCK_ADDR = logicalAddress(0x10)
const blockOf = (img: RadioImage) => img.regions.find((r) => r.start === KEY_BLOCK_ADDR)!.data

describe('the round-trip invariant, on a real block 0x10', () => {
  it('encode(decode(image), image) is byte-identical', () => {
    const img = image()
    const round = writable.encode(writable.decode(img), img)
    for (const region of round.regions) {
      const original = img.regions.find((r) => r.start === region.start)!
      expect(equalBytes(region.data, original.data), `block 0x${(region.start >>> 12).toString(16)}`).toBe(true)
    }
  })

  it('does not mutate the image it was given', () => {
    const img = image()
    const before = blockOf(img).slice()
    writable.encode(writable.decode(img), img)
    expect(equalBytes(blockOf(img), before)).toBe(true)
  })
})

describe('what a key write touches', () => {
  it('changes only the key area, never the rest of the block', () => {
    const img = image()
    const cp = writable.decode(img)
    cp.encryptionKeys[0] = { ...cp.encryptionKeys[0]!, keyHex: 'AB'.repeat(32) }
    const out = blockOf(writable.encode(cp, img))
    const before = blockOf(img)
    const [from, to] = KEY_AREA

    for (let i = 0; i < PAGE_SIZE; i++) {
      if (i < from || i >= to) {
        expect(out[i], `byte 0x${i.toString(16)} outside the key area`).toBe(before[i])
      }
    }
  })

  it('leaves the ~3 KB after the keys that nothing has explained', () => {
    const img = image()
    const cp = writable.decode(img)
    cp.encryptionKeys[3] = { ...cp.encryptionKeys[3]!, name: 'Renamed' }
    const out = blockOf(writable.encode(cp, img))
    const before = blockOf(img)
    expect(equalBytes(out.subarray(KEY_AREA[1]), before.subarray(KEY_AREA[1]))).toBe(true)
    // And the emergency settings before them.
    expect(equalBytes(out.subarray(0, KEY_AREA[0]), before.subarray(0, KEY_AREA[0]))).toBe(true)
  })

  it('claims the key area in block 0x10, and only that area', () => {
    expect(writable.ownedRanges(KEY_BLOCK_ADDR)).toEqual([KEY_AREA])
  })

  it('never claims calibration', () => {
    // Block 0x02 holds the unit's calibration. It is captured in every backup so
    // a restore can put it back, and it is never a write candidate - losing it
    // is not something a codeplug edit should ever be able to do.
    expect(writable.ownedRanges(logicalAddress(0x02))).toEqual([])
  })

  it('claims nothing in the blocks nobody has decoded', () => {
    // 22 of the 59 allocated blocks have no documented meaning. Claiming one
    // would assert an understanding that does not exist, and the diff check
    // that blocks a stray write would stop catching it.
    // Taken from the layout rather than written out here: hardcoding the ranges
    // in a test only proves the test agrees with itself. The zone blocks are
    // 0x5c-0x64 and the talk group blocks 0x44-0x48, which is not the tidy
    // ordering a guess would produce.
    const decoded = new Set<number>([
      KEY_BLOCK,
      SCANLIST_BLOCK,
      RXGROUP_BLOCK,
      RADIOID_BLOCK,
      SETTINGS_BLOCK,
      TXCONTACT_BLOCK_LOW,
      TXCONTACT_BLOCK_HIGH,
      MESSAGE_BLOCK,
      ROAMCHANNEL_BLOCK,
    ])
    for (let id = CHANNEL_BLOCK_FIRST; id <= CHANNEL_BLOCK_LAST; id++) decoded.add(id)
    for (let id = ZONE_BLOCK_FIRST; id <= ZONE_BLOCK_LAST; id++) decoded.add(id)
    for (let id = TALKGROUP_BLOCK_FIRST; id <= TALKGROUP_BLOCK_LAST; id++) decoded.add(id)

    for (const b of INDEX.blocks) {
      if (decoded.has(b.id)) continue
      expect(
        writable.ownedRanges(logicalAddress(b.id)),
        `block 0x${b.id.toString(16)} is undecoded and must not be claimed`,
      ).toEqual([])
    }
  })

  it('never claims the last byte of a page, which carries the block id', () => {
    // The flash translation layer identifies a page by its final byte. A write
    // that touched it would make the page unfindable on the next scan.
    for (const b of INDEX.blocks) {
      for (const [, end] of writable.ownedRanges(logicalAddress(b.id))) {
        expect(end, `block 0x${b.id.toString(16)}`).toBeLessThanOrEqual(PAGE_SIZE - 1)
      }
    }
  })
})

describe('encoding a key', () => {
  it('round-trips a full AES-256 key through the block', () => {
    const img = image()
    const cp = writable.decode(img)
    const key = '00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF'
    cp.encryptionKeys[0] = { ...cp.encryptionKeys[0]!, name: 'Ops 1', type: 'aes256', keyHex: key }
    const back = writable.decode(writable.encode(cp, img)).encryptionKeys.find((k) => k.slot === 1)!
    expect(back.name).toBe('Ops 1')
    expect(back.type).toBe('aes256')
    expect(back.keyHex).toBe(key)
  })

  it('fills the whole 32-byte field, as this radio does', () => {
    // The specification calls AES-256 "right-aligned at +0x24" from a sample
    // where a short key had been entered. A real key occupies the field.
    const block = new Uint8Array(PAGE_SIZE)
    encodeKeys(block, [{ id: 'k', slot: 1, name: 'X', type: 'aes256', keyHex: 'FF'.repeat(32) }])
    const off = keySlotOffset(1)
    expect([...block.subarray(off + 0x0c, off + 0x2c)]).toEqual(Array(32).fill(0xff))
  })

  it('clears an absent slot the way the radio erases one', () => {
    // All zeros. This originally asserted an id byte followed by 0xFF filler,
    // taken from the specification's erase pattern; every unused record in a
    // real DM-32UV's key table is 44 zero bytes instead.
    //
    // The slot has to be a decodable one first: an uninterpretable record is
    // deliberately preserved rather than erased, so filling the page with
    // arbitrary bytes would exercise that path instead of this one.
    const block = new Uint8Array(PAGE_SIZE).fill(0x5a)
    encodeKeys(block, [{ id: 'key-3', slot: 3, name: 'Gone', type: 'aes256', keyHex: 'A'.repeat(64) }])
    encodeKeys(block, [])
    const off = keySlotOffset(3)
    expect([...block.subarray(off, off + 0x2c)]).toEqual(Array(0x2c).fill(0x00))
  })

  it('round-trips every slot independently', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: KEY_SLOTS }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (slot, bytes) => {
          const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
          const img = image()
          const cp = writable.decode(img)
          cp.encryptionKeys = [{ id: `k${slot}`, slot, name: `S${slot}`, type: 'aes256', keyHex: hex.toUpperCase() }]
          const back = writable.decode(writable.encode(cp, img)).encryptionKeys
          expect(back).toHaveLength(1)
          expect(back[0]!.slot).toBe(slot)
          expect(back[0]!.keyHex).toBe(hex.toUpperCase())
        },
      ),
      { numRuns: 60 },
    )
  })
})

describe('what encode refuses', () => {
  it('refuses a codeplug for a different radio', () => {
    const img = image()
    expect(() => writable.encode({ ...writable.decode(img), radio: 'uvk5' }, img)).toThrow(DriverError)
  })

  it('refuses an image from a different radio', () => {
    const img = image()
    expect(() => writable.encode(writable.decode(img), { ...img, radioId: 'uvk5' })).toThrow(/Not a DM-32UV/)
  })

  it('refuses an image with no block 0x10', () => {
    const img = image()
    const stripped = { ...img, regions: img.regions.filter((r) => r.start !== KEY_BLOCK_ADDR) }
    expect(() => writable.encode(writable.decode(img), stripped)).toThrow(/no block 0x10/)
  })
})

describe('the write gate', () => {
  const backup: BackupRef = { id: 'b', identHash: 'x', createdAt: '2026-08-19T00:00:00Z' }

  it('refuses when the driver is not cleared to write', async () => {
    await expect(
      driver.writeImage(null as never, image(), { backup, readTimeoutMs: 100 }),
    ).rejects.toThrow(/not enabled in this build/)
  })

  it('refuses without a backup', async () => {
    await expect(writable.writeImage(null as never, image(), { readTimeoutMs: 100 })).rejects.toBeInstanceOf(
      BackupRequiredError,
    )
  })

  it('refuses an image from a different radio before touching the port', async () => {
    await expect(
      writable.writeImage(null as never, { ...image(), radioId: 'uvk5' }, { backup, readTimeoutMs: 100 }),
    ).rejects.toThrow(/Not a DM-32UV/)
  })
})

describe('regressions from the write-path review', () => {
  it('only sends the key slots the user actually changed', () => {
    // Copying the whole key area from a stored image would revert the other
    // seven slots to whatever they held when it was read. Real sequence: read
    // on Monday, change a key on the radio itself, then open Monday's backup,
    // edit one slot and write - six untouched keys quietly go back in time.
    const img = image()
    const cp = writable.decode(img)
    cp.encryptionKeys[0] = { ...cp.encryptionKeys[0]!, keyHex: 'AB'.repeat(32) }
    const out = blockOf(writable.encode(cp, img))
    const before = blockOf(img)

    // Slot 1 changed; slots 2..8 are byte-identical in the encoded image, so
    // the per-slot merge in writeImage will not send them.
    const slot1 = keySlotOffset(1)
    expect(equalBytes(out.subarray(slot1, slot1 + 0x2c), before.subarray(slot1, slot1 + 0x2c))).toBe(false)
    for (let slot = 2; slot <= KEY_SLOTS; slot++) {
      const off = keySlotOffset(slot)
      expect(
        equalBytes(out.subarray(off, off + 0x2c), before.subarray(off, off + 0x2c)),
        `slot ${slot}`,
      ).toBe(true)
    }
  })

  it('never lets the merge touch a byte outside the key area', () => {
    // Asserted in writeImage as well, as a last line of defence: a merge that
    // strays is a defect in boofwang and must not reach the radio.
    const img = image()
    const cp = writable.decode(img)
    for (let slot = 1; slot <= KEY_SLOTS; slot++) {
      cp.encryptionKeys[slot - 1] = {
        id: `k${slot}`, slot, name: `S${slot}`, type: 'aes256', keyHex: 'CD'.repeat(32),
      }
    }
    const out = blockOf(writable.encode(cp, img))
    const before = blockOf(img)
    const [from, to] = KEY_AREA
    expect(equalBytes(out.subarray(0, from), before.subarray(0, from))).toBe(true)
    expect(equalBytes(out.subarray(to), before.subarray(to))).toBe(true)
  })
})

describe('what the confirmation dialog will say, on the real image', () => {
  // Pins the numbers from the verified hardware session of 2026-08-20:
  // renaming key slot 8 diffed to 9 bytes in block 0x10 with nothing unowned,
  // and the radio came back byte-identical afterwards.
  it('a slot rename is 9 bytes, one 4 KiB block, and nothing unowned', () => {
    const img = image()
    const doc = writable.decode(img)
    const slot8 = doc.encryptionKeys.find((k) => k.slot === 8)!
    expect(slot8.name).toBe('Encrypt 8')
    slot8.name = 'BOOFWANG'

    const next = writable.encode(doc, img)
    const d = diffImages(img, next, writable)

    expect(d.changedBytes).toBe(9)
    expect(d.unowned).toEqual([])
    expect(d.changedBlocks).toEqual([KEY_BLOCK_ADDR])
  })

  it('does not report a change when nothing was edited', () => {
    const img = image()
    const d = diffImages(img, writable.encode(writable.decode(img), img), writable)
    expect(d.changedBytes).toBe(0)
    expect(d.changedBlocks).toEqual([])
  })

  it('writes a whole page for a one-byte edit, and says so', () => {
    // The user is agreeing to send 4096 bytes even though 9 changed. The block
    // count is what makes that visible.
    const img = image()
    const doc = writable.decode(img)
    doc.encryptionKeys.find((k) => k.slot === 8)!.name = 'X'
    const d = diffImages(img, writable.encode(doc, img), writable)
    expect(d.changedBlocks).toHaveLength(1)
    expect(writable.writeBlockBytes).toBe(PAGE_SIZE)
  })
})

describe('erasing a key slot', () => {
  const SLOT_SIZE = 0x2c

  it('leaves an already-empty slot completely alone', () => {
    // The invariant this protects: decode() skips empty slots, so if encode()
    // wrote an erase pattern over them, every untouched empty slot would come
    // back as a difference and the round trip would stop being byte-exact.
    const img = image()
    const block = blockOf(img)
    const empty: number[] = []
    for (let slot = 1; slot <= KEY_SLOTS; slot++) {
      const off = keySlotOffset(slot)
      if (block.subarray(off, off + SLOT_SIZE).every((b) => b === 0 || b === 0xff)) empty.push(slot)
    }

    const patched = block.slice()
    encodeKeys(patched, writable.decode(img).encryptionKeys)
    for (const slot of empty) {
      const off = keySlotOffset(slot)
      expect(equalBytes(patched.subarray(off, off + SLOT_SIZE), block.subarray(off, off + SLOT_SIZE))).toBe(true)
    }
  })

  it('erases a cleared slot to zeros, the way the radio does', () => {
    // Unused records in a real DM-32UV's key table are 44 zero bytes. The
    // specification's 0x00-then-43x0xFF pattern does not appear on hardware.
    const img = image()
    const doc = writable.decode(img)
    doc.encryptionKeys = doc.encryptionKeys.filter((k) => k.slot !== 3)

    const patched = blockOf(img).slice()
    encodeKeys(patched, doc.encryptionKeys)
    const off = keySlotOffset(3)
    expect([...patched.subarray(off, off + SLOT_SIZE)]).toEqual(new Array(SLOT_SIZE).fill(0))
  })

  it('does not disturb its neighbours when erasing', () => {
    const img = image()
    const doc = writable.decode(img)
    doc.encryptionKeys = doc.encryptionKeys.filter((k) => k.slot !== 3)

    const before = blockOf(img).slice()
    const patched = before.slice()
    encodeKeys(patched, doc.encryptionKeys)
    for (const neighbour of [2, 4]) {
      const off = keySlotOffset(neighbour)
      expect(equalBytes(patched.subarray(off, off + SLOT_SIZE), before.subarray(off, off + SLOT_SIZE))).toBe(true)
    }
  })
})

describe('a key slot this build does not understand', () => {
  const SLOT_SIZE = 0x2c

  it('is preserved rather than erased', () => {
    // A record with an unrecognised type byte never reaches the document, so
    // "absent from the document" cannot be read as "the user deleted it".
    // Erasing on that basis would destroy a working key on any firmware using
    // a type this build has not seen.
    const img = image()
    const block = blockOf(img).slice()
    const off = keySlotOffset(4)
    block[off + 0x0b] = 0x7f // a type nothing maps to
    const before = block.slice(off, off + SLOT_SIZE)

    const doc = writable.decode({ ...img, regions: img.regions.map((r) => (r.start === KEY_BLOCK_ADDR ? { ...r, data: block } : r)) })
    expect(doc.encryptionKeys.some((k) => k.slot === 4)).toBe(false)

    const patched = block.slice()
    encodeKeys(patched, doc.encryptionKeys)
    expect(equalBytes(patched.subarray(off, off + SLOT_SIZE), before)).toBe(true)
  })

  it('still lets a slot the user really deleted be erased', () => {
    const img = image()
    const doc = writable.decode(img)
    doc.encryptionKeys = doc.encryptionKeys.filter((k) => k.slot !== 5)
    const patched = blockOf(img).slice()
    encodeKeys(patched, doc.encryptionKeys)
    const off = keySlotOffset(5)
    expect([...patched.subarray(off, off + SLOT_SIZE)]).toEqual(new Array(SLOT_SIZE).fill(0))
  })
})

describe('channels, zones and talk groups now write too', () => {
  it('round-trips the whole document byte-for-byte', () => {
    // The invariant everything else rests on, now that encode() touches four
    // kinds of record instead of one.
    const img = image()
    const out = writable.encode(writable.decode(img), img)
    for (let i = 0; i < img.regions.length; i++) {
      expect(
        equalBytes(out.regions[i]!.data, img.regions[i]!.data),
        `block 0x${(img.regions[i]!.start >>> 12).toString(16)}`,
      ).toBe(true)
    }
  })

  it('changes only the channel that was edited', () => {
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()][0]!
    doc.channels.set(slot, { ...doc.channels.get(slot)!, name: 'RENAMED' })

    const out = writable.encode(doc, img)
    const moved = diffImages(img, out, writable)
    expect(moved.changedBlocks.length).toBe(1)
    expect(moved.unowned).toEqual([])

    expect(writable.decode(out).channels.get(slot)!.name).toBe('RENAMED')
  })

  it('carries a tone onto a channel and reads it back', () => {
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.values()].find((c) => c.modulation === 'FM')?.index
    expect(slot, 'the fixture has no analog channel to tone').toBeTruthy()

    doc.channels.set(slot!, {
      ...doc.channels.get(slot!)!,
      tone: { rx: { kind: 'ctcss', deciHz: 1273 }, tx: { kind: 'ctcss', deciHz: 1273 }, rxInverted: false },
    })
    const back = writable.decode(writable.encode(doc, img)).channels.get(slot!)!
    expect(back.tone.rx).toEqual({ kind: 'ctcss', deciHz: 1273 })
    expect(back.tone.tx).toEqual({ kind: 'ctcss', deciHz: 1273 })
  })

  it('carries a DCS code with its polarity', () => {
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.values()].find((c) => c.modulation === 'FM')!.index
    doc.channels.set(slot, {
      ...doc.channels.get(slot)!,
      tone: { rx: { kind: 'dtcs', code: 754, polarity: 'R' }, tx: null, rxInverted: false },
    })
    const back = writable.decode(writable.encode(doc, img)).channels.get(slot)!
    expect(back.tone.rx).toEqual({ kind: 'dtcs', code: 754, polarity: 'R' })
  })

  it('keeps a receive-only channel receive-only', () => {
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()][0]!
    doc.channels.set(slot, {
      ...doc.channels.get(slot)!,
      txAllowed: false,
      txInhibitReason: 'test',
    })
    expect(writable.decode(writable.encode(doc, img)).channels.get(slot)!.txAllowed).toBe(false)
  })

  it('renames a zone without disturbing its channel list', () => {
    const img = image()
    const doc = writable.decode(img)
    expect(doc.zones.length).toBeGreaterThan(0)
    const before = doc.zones[0]!
    doc.zones[0] = { ...before, name: 'ZONE X' }

    const back = writable.decode(writable.encode(doc, img))
    expect(back.zones[0]!.name).toBe('ZONE X')
    expect(back.zones[0]!.channels).toEqual(before.channels)
  })

  it('renames a talk group and keeps its number and call type', () => {
    const img = image()
    const doc = writable.decode(img)
    expect(doc.talkGroups.length).toBeGreaterThan(0)
    const before = doc.talkGroups[0]!
    doc.talkGroups[0] = { ...before, name: 'TG EDIT' }

    const back = writable.decode(writable.encode(doc, img)).talkGroups[0]!
    expect(back.name).toBe('TG EDIT')
    expect(back.number).toBe(before.number)
    expect(back.callType).toBe(before.callType)
  })

  it('never moves a byte outside the ranges it claims', () => {
    // The check that would have caught the encoder writing somewhere it does
    // not understand, on a radio where 22 of 59 blocks are undocumented.
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()][0]!
    doc.channels.set(slot, { ...doc.channels.get(slot)!, name: 'X', bandwidthHz: 25_000 })
    doc.zones[0] = { ...doc.zones[0]!, name: 'Z' }
    doc.talkGroups[0] = { ...doc.talkGroups[0]!, name: 'T' }

    expect(diffImages(img, writable.encode(doc, img), writable).unowned).toEqual([])
  })
})

/**
 * These assert the bit positions the protocol reference documents, against raw
 * hex, rather than asking boofwang whether it agrees with itself.
 *
 * The distinction matters here. Decoder and encoder shared the same wrong bit
 * for transmit-forbid, so `encode(decode(image)) === image` was byte-identical
 * and a test that set `txAllowed: false` and read it back passed - while the
 * radio went on transmitting. Only raw bytes catch that.
 */
describe('channel flag bytes, against the reference hex', () => {
  const REC = 0 // where in `mem` the worked-example record sits
  const mem = () => new Uint8Array(CHANNEL_SIZE).fill(0)

  function decodeOne(bytes: Partial<Record<number, number>>): Channel {
    const m = mem()
    // A plausible frequency, or decodeChannel discards the record.
    m.set([0x50, 0x12, 0x00, 0x43], 0x10)
    m.set([0x50, 0x12, 0x00, 0x43], 0x14)
    for (const [off, v] of Object.entries(bytes)) m[Number(off)] = v!
    return decodeChannel(m, REC, 0)!
  }

  // reference/dm32/05-DATA-STRUCTURES.md:701 - "0x18 = 14: mode 1 = Digital,
  // forbid TX 0, power (bits 2-1) = 2 = High, lone worker 0"
  it('reads the reference worked example 0x18 = 0x14 as digital, transmit allowed, High', () => {
    const ch = decodeOne({ 0x18: 0x14 })
    expect(ch.modulation).toBe('DMR')
    expect(ch.txAllowed).toBe(true)
    expect(ch.power.label).toBe('High')
  })

  // Same page: the analog channel in that block is 0x18 = 0x04, power High.
  it('reads the reference analog example 0x18 = 0x04 as analog, High', () => {
    const ch = decodeOne({ 0x18: 0x04 })
    expect(ch.modulation).toBe('FM')
    expect(ch.txAllowed).toBe(true)
    expect(ch.power.label).toBe('High')
  })

  // This radio's own LR DMR / AR DMR / USA DMR / Test DMR all hold 0x1c, and
  // the OEM CPS shows them receive-only. boofwang used to call them writable.
  it('reads this radio’s 0x18 = 0x1c as transmit-forbidden', () => {
    const ch = decodeOne({ 0x18: 0x1c })
    expect(ch.txAllowed).toBe(false)
    expect(ch.power.label).toBe('High')
  })

  it('writes transmit-forbid to bit 3, leaving the power bits alone', () => {
    const m = mem()
    m.set([0x50, 0x12, 0x00, 0x43], 0x10)
    m.set([0x50, 0x12, 0x00, 0x43], 0x14)
    m[0x18] = 0x04 // analog, transmit allowed, High
    const ch = decodeChannel(m, REC, 0)!
    encodeChannel(m, REC, { ...ch, txAllowed: false, txInhibitReason: 'receive only' })
    // 0x04 | 0x08 = 0x0c. Writing bit 1 instead gave 0x06: transmit still
    // allowed, and the power level changed to a value the reference does not
    // define.
    expect(m[0x18]).toBe(0x0c)
  })

  it('round-trips all three power levels through bits 2-1', () => {
    for (const [raw, label] of [
      [0x00, 'Low'],
      [0x02, 'Medium'],
      [0x04, 'High'],
    ] as const) {
      const ch = decodeOne({ 0x18: raw })
      expect(ch.power.label, `0x18 = 0x${raw.toString(16)}`).toBe(label)

      const m = mem()
      m.set([0x50, 0x12, 0x00, 0x43], 0x10)
      m.set([0x50, 0x12, 0x00, 0x43], 0x14)
      encodeChannel(m, REC, ch)
      expect(m[0x18], `re-encoding ${label}`).toBe(raw)
    }
  })

  it('keeps the lone worker bit, which shares the byte with power', () => {
    const m = mem()
    m.set([0x50, 0x12, 0x00, 0x43], 0x10)
    m.set([0x50, 0x12, 0x00, 0x43], 0x14)
    m[0x18] = 0x05 // analog, High, lone worker on
    const ch = decodeChannel(m, REC, 0)!
    encodeChannel(m, REC, { ...ch, name: 'RENAMED' })
    expect(m[0x18]).toBe(0x05)
  })

  // reference:309-317 - bit 7 bandwidth, bit 6 scan add, bits 5-2 scan list,
  // bits 1-0 preserve. The whole byte used to be rewritten as 0 or 1.
  it('keeps scan-add and scan-list membership when only the name changes', () => {
    const m = mem()
    m.set([0x50, 0x12, 0x00, 0x43], 0x10)
    m.set([0x50, 0x12, 0x00, 0x43], 0x14)
    m[0x19] = 0xcc // wide, auto scan on, scan list 3
    const ch = decodeChannel(m, REC, 0)!
    expect(ch.bandwidthHz).toBe(25_000)
    encodeChannel(m, REC, { ...ch, name: 'RENAMED' })
    expect(m[0x19]).toBe(0xcc)
  })

  it('narrows bandwidth without dropping the channel out of its scan list', () => {
    const m = mem()
    m.set([0x50, 0x12, 0x00, 0x43], 0x10)
    m.set([0x50, 0x12, 0x00, 0x43], 0x14)
    m[0x19] = 0xcf // ...and both preserve bits set
    const ch = decodeChannel(m, REC, 0)!
    encodeChannel(m, REC, { ...ch, bandwidthHz: 12_500 })
    // Only bit 7 clears; scan add, scan list and the two preserve bits stay.
    expect(m[0x19]).toBe(0x4f)
  })

  // reference:392-406 - timeslot is bit 4, colour code is the low nibble,
  // attested by an OEM CPS capture where TS1 stores 0x01 and TS2 stores 0x11.
  it('writes time slot 2 to bit 4, as the CPS capture does', () => {
    const m = mem()
    m.set([0x50, 0x12, 0x00, 0x43], 0x10)
    m.set([0x50, 0x12, 0x00, 0x43], 0x14)
    m[0x18] = 0x10 // digital
    m[0x1d] = 0x01 // colour code 1, TS1
    const ch = decodeChannel(m, REC, 0)!
    expect(ch.extras.vendor?.timeSlot).toBe('1')
    expect(ch.extras.vendor?.colorCode).toBe('1')

    encodeChannel(m, REC, {
      ...ch,
      extras: { ...ch.extras, vendor: { ...ch.extras.vendor, timeSlot: '2' } },
    })
    // Writing bit 3 instead gave 0x09, which the radio reads as colour code 9
    // on time slot 1 - the slot unchanged and the colour code destroyed.
    expect(m[0x1d]).toBe(0x11)
  })

  it('carries colour codes above 7, which three bits could not hold', () => {
    const m = mem()
    m.set([0x50, 0x12, 0x00, 0x43], 0x10)
    m.set([0x50, 0x12, 0x00, 0x43], 0x14)
    m[0x18] = 0x10
    m[0x1d] = 0x1d // colour code 13, TS2
    const ch = decodeChannel(m, REC, 0)!
    expect(ch.extras.vendor?.colorCode).toBe('13')
    expect(ch.extras.vendor?.timeSlot).toBe('2')
    encodeChannel(m, REC, { ...ch, name: 'RENAMED' })
    expect(m[0x1d]).toBe(0x1d)
  })

  it('leaves a receive-only channel’s transmit frequency where the radio put it', () => {
    const m = mem()
    m.set([0x50, 0x12, 0x00, 0x43], 0x10) // rx 430.01250
    m.set([0x00, 0x50, 0x02, 0x44], 0x14) // tx elsewhere
    m[0x18] = 0x0c // analog, transmit forbidden, High
    const before = m.slice(0x14, 0x18)
    const ch = decodeChannel(m, REC, 0)!
    expect(ch.txAllowed).toBe(false)
    encodeChannel(m, REC, { ...ch, name: 'RENAMED' })
    // The old code wrote the receive frequency here, so clearing the
    // receive-only flag later would have keyed up on the wrong pair.
    expect(equalBytes(m.slice(0x14, 0x18), before)).toBe(true)
  })
})

describe('adding and removing channels', () => {
  const countOf = (img: RadioImage) => {
    const b = img.regions.find((r) => r.start === logicalAddress(CHANNEL_BLOCK_FIRST))!.data
    return b[0]! | (b[1]! << 8)
  }

  it('leaves the count alone when nothing was added or removed', () => {
    const img = image()
    expect(countOf(writable.encode(writable.decode(img), img))).toBe(countOf(img))
  })

  it('raises the count and programs the slot when a channel is added', () => {
    const img = image()
    const doc = writable.decode(img)
    const before = countOf(img)
    const next = before + 1

    const template = doc.channels.get([...doc.channels.keys()][0]!)!
    doc.channels.set(next, { ...template, index: next, name: 'BRAND NEW' })

    const out = writable.encode(doc, img)
    expect(countOf(out)).toBe(next)

    const back = writable.decode(out)
    expect(back.channels.get(next)!.name).toBe('BRAND NEW')
    // And it did not disturb the channel that was already there.
    expect(back.channels.get(template.index)!.name).toBe(template.name)
  })

  it('fills the gap when a channel is added past the end', () => {
    // Slots are positional: adding channel n+3 has to leave n+1 and n+2 as
    // records the radio reads as empty, not as whatever the flash held.
    const img = image()
    const doc = writable.decode(img)
    const before = countOf(img)
    const target = before + 3

    const template = doc.channels.get([...doc.channels.keys()][0]!)!
    doc.channels.set(target, { ...template, index: target, name: 'FAR' })

    const back = writable.decode(writable.encode(doc, img))
    expect(countOf(writable.encode(doc, img))).toBe(target)
    expect(back.channels.get(target)!.name).toBe('FAR')
    expect(back.channels.has(before + 1)).toBe(false)
    expect(back.channels.has(before + 2)).toBe(false)
  })

  it('erases the record when a channel is deleted', () => {
    const img = image()
    const doc = writable.decode(img)
    const victim = [...doc.channels.keys()][3]!
    const survivor = [...doc.channels.keys()][4]!
    const survivorName = doc.channels.get(survivor)!.name
    doc.channels.delete(victim)

    const back = writable.decode(writable.encode(doc, img))
    expect(back.channels.has(victim), 'the deleted channel came back').toBe(false)
    // Deleting does not renumber: zone and scan-list entries hold absolute
    // channel numbers, so the slot stays empty where it was.
    expect(back.channels.get(survivor)!.name).toBe(survivorName)
  })

  it('does not shrink the count when the last channel is deleted', () => {
    const img = image()
    const doc = writable.decode(img)
    const last = Math.max(...doc.channels.keys())
    doc.channels.delete(last)
    const out = writable.encode(doc, img)
    expect(countOf(out)).toBe(countOf(img))
    expect(writable.decode(out).channels.has(last)).toBe(false)
  })

  it('refuses a slot number past the end of the channel bank', () => {
    const img = image()
    const doc = writable.decode(img)
    const template = doc.channels.get([...doc.channels.keys()][0]!)!
    doc.channels.set(99_999, { ...template, index: 99_999, name: 'NOPE' })
    expect(() => writable.encode(doc, img)).toThrow(/past the end/)
  })

  it('refuses a channel whose block the radio has not allocated', () => {
    // Block ids are absolute. This radio has channel-bank blocks 0x12, 0x13,
    // 0x14 and then 0x18 - so channel 255, which belongs in 0x15, has nowhere
    // to go. Putting it in 0x18 instead would store it as channel 510 and
    // silently break every zone entry pointing at either number.
    const img = image()
    const doc = writable.decode(img)
    const template = doc.channels.get([...doc.channels.keys()][0]!)!
    expect(channelSlot(255)!.blockId).toBe(0x15)
    expect(img.regions.some((r) => r.start === logicalAddress(0x15)), 'fixture unexpectedly has 0x15').toBe(false)

    doc.channels.set(255, { ...template, index: 255, name: 'NO BLOCK' })
    expect(() => writable.encode(doc, img)).toThrow(/block 0x15, which this radio has not allocated/)
  })

  it('numbers channels by absolute block, not by the blocks that happen to exist', () => {
    // The reference's entry-offset formula, checked at every boundary.
    expect(channelSlot(1)).toEqual({ blockId: 0x12, offset: CHANNEL_HEADER })
    expect(channelSlot(84)).toEqual({ blockId: 0x12, offset: CHANNEL_HEADER + 83 * CHANNEL_SIZE })
    expect(channelSlot(85)).toEqual({ blockId: 0x13, offset: 0 })
    expect(channelSlot(169)).toEqual({ blockId: 0x13, offset: 84 * CHANNEL_SIZE })
    expect(channelSlot(170)).toEqual({ blockId: 0x14, offset: 0 })
    expect(channelSlot(255)).toEqual({ blockId: 0x15, offset: 0 })
    // 48 slots: 84 + 47 * 85.
    expect(channelSlot(84 + 47 * 85)).toEqual({ blockId: CHANNEL_BLOCK_LAST, offset: 84 * CHANNEL_SIZE })
    expect(channelSlot(84 + 47 * 85 + 1)).toBeNull()
    expect(channelSlot(0)).toBeNull()
  })

  it('does not renumber the channels after a block the radio is missing', () => {
    // A gap in the bank means those numbers are unusable, not that later
    // channels shuffle down into them.
    const img = image()
    const doc = writable.decode(img)
    const numbers = [...doc.channels.keys()].sort((x, y) => x - y)
    expect(numbers[0]).toBe(1)
    expect(numbers.at(-1)).toBeLessThanOrEqual(84)
  })

  it('claims the count word, and none of the header fill around it', () => {
    const ranges = writable.ownedRanges(logicalAddress(CHANNEL_BLOCK_FIRST))
    expect(ranges).toContainEqual([0, 2])
    // Bytes 0x02-0x0F are fill in both hardware captures. Claiming them would
    // let a write put our idea of "fill" over whatever the radio keeps there.
    for (let i = 2; i < CHANNEL_HEADER; i++) {
      expect(ranges.some(([from, to]) => i >= from && i < to), `byte 0x${i.toString(16)}`).toBe(false)
    }
  })

  it('keeps the header fill untouched when the count changes', () => {
    const img = image()
    const doc = writable.decode(img)
    const template = doc.channels.get([...doc.channels.keys()][0]!)!
    const next = countOf(img) + 1
    doc.channels.set(next, { ...template, index: next, name: 'X' })

    const was = img.regions.find((r) => r.start === logicalAddress(CHANNEL_BLOCK_FIRST))!.data
    const now = writable.encode(doc, img).regions.find((r) => r.start === logicalAddress(CHANNEL_BLOCK_FIRST))!.data
    expect(equalBytes(now.subarray(2, CHANNEL_HEADER), was.subarray(2, CHANNEL_HEADER))).toBe(true)
  })
})
