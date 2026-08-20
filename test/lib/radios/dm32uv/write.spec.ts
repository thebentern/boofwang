// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { equalBytes } from '#core/codec/struct.js'
import { diffImages } from '#core/radio/diff.js'
import { BackupRequiredError, DriverError, type BackupRef } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver, encodeKeys } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { KEY_AREA, KEY_SLOTS, keySlotOffset } from '#core/radios/dm32uv/layout.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'

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

  it('claims only the key area, and only in block 0x10', () => {
    expect(writable.ownedRanges(KEY_BLOCK_ADDR)).toEqual([KEY_AREA])
    expect(writable.ownedRanges(logicalAddress(0x12))).toEqual([])
    expect(writable.ownedRanges(logicalAddress(0x02))).toEqual([])
  })

  it('never claims a byte outside block 0x10', () => {
    for (const b of INDEX.blocks) {
      if (b.id === 0x10) continue
      expect(writable.ownedRanges(logicalAddress(b.id)), `block 0x${b.id.toString(16)}`).toEqual([])
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
