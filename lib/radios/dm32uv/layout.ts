// SPDX-License-Identifier: GPL-3.0-or-later
import { ascii, bcdFreqLE, bytes, chirpBits, u8, u16le, u24le } from '../../codec/fields.js'
import { at, defineStruct } from '../../codec/struct.js'

/**
 * DM-32UV record layouts.
 *
 * From the MIT-licensed DM32-Protocol-Spec, corrected where a real radio
 * disagreed. Corrections are called out individually, because the specification
 * marks much of this DERIVED from two captures of a single unit and it is
 * important to know which parts have now been seen on a second radio.
 */

export const CHANNEL_SIZE = 48
/** The first channel block carries a 16-byte header; records follow it. */
export const CHANNEL_HEADER = 0x10
export const CHANNEL_BLOCK_FIRST = 0x12
export const CHANNEL_BLOCK_LAST = 0x41

export const ZONE_SIZE = 145
export const ZONE_HEADER = 0x10
export const ZONE_BLOCK_FIRST = 0x5c
export const ZONE_BLOCK_LAST = 0x64
export const ZONE_MAX_CHANNELS = 64

export const TALKGROUP_SIZE = 24
export const TALKGROUP_BLOCK_FIRST = 0x44
export const TALKGROUP_BLOCK_LAST = 0x48

export const KEY_BLOCK = 0x10
export const KEY_BASE = 0x300
export const KEY_SIZE = 0x2c
/**
 * How many encryption key slots this radio really has.
 *
 * The specification says eight. A real DM-32UV has **22**: block 0x10 holds 22
 * consecutive 0x2C records, ids 1-22, each type 0x04 (AES-256) and named
 * "Encrypt 1" through "Encrypt 22", followed by zeroed records. Eight was taken
 * from the specification and never checked against hardware.
 *
 * That mistake was not cosmetic. It scoped `KEY_AREA` to the first 352 bytes,
 * hid 14 of the radio's key slots from the UI, and - because the fixture
 * redaction pass and the test that guards against checked-in key material both
 * derived their bounds from this constant - let fourteen real AES-256 keys into
 * a fixture while a green test asserted none were there. Anything that reads
 * key slots must not assume this number is right; the guard test now scans the
 * whole block independently of it.
 */
export const KEY_SLOTS = 22

export const DM32_CHANNEL = defineStruct(CHANNEL_SIZE, {
  name: at(0x00, ascii(16, { pad: 0x00, terminators: [0x00, 0xff] })),
  rxFreq: at(0x10, bcdFreqLE(4)),
  txFreq: at(0x14, bcdFreqLE(4)),
  mode: at(
    0x18,
    chirpBits(1, [
      ['channelMode', 4],
      ['unknown', 2],
      ['txForbid', 1],
      ['power', 1],
    ]),
  ),
  bandwidth: at(0x19, u8),
  digital: at(
    0x1d,
    chirpBits(1, [
      ['encryptEnable', 1],
      ['unknown', 3],
      ['timeSlot', 1],
      ['colorCode', 3],
    ]),
  ),
  rxTone: at(0x21, u16le),
  txTone: at(0x23, u16le),
  /** 0 = no encryption, 1-8 = a key slot. Marked DERIVED in the spec. */
  encryptionKeyId: at(0x2a, u8),
  radioIdIndex: at(0x2b, u8),
})

/**
 * A zone.
 *
 * The spec's record layout matches hardware exactly. What did **not** match is
 * the block header: the zone count is a **single byte** at +0x000, not a
 * 16-bit word. Reading two bytes on the test radio gave 1796 for what are
 * plainly four zones, because the neighbouring byte is something else.
 */
export const DM32_ZONE = defineStruct(ZONE_SIZE, {
  name: at(0x00, ascii(11, { pad: 0x00, terminators: [0x00, 0xff] })),
  channelCount: at(0x10, u8),
  channels: at(0x11, bytes(ZONE_MAX_CHANNELS * 2)),
})

/**
 * A talk group.
 *
 * Records are 24 bytes, but the first sits at offset 0 and carries one extra
 * leading byte, so entry N begins at `25 + (N-2)*24` for N >= 2. Confirmed on
 * hardware: the name offsets land exactly on 0x02, 0x32, 0x4A, 0x7A, 0x92 and
 * 0xDA for the populated slots, with the gaps being genuinely empty entries.
 */
export const DM32_TALKGROUP = defineStruct(TALKGROUP_SIZE, {
  flag: at(0x00, u8),
  name: at(0x01, ascii(16, { pad: 0x00, terminators: [0x00, 0xff] })),
  number: at(0x12, u24le),
  callType: at(0x15, u8),
})

export const CALL_TYPE_PRIVATE = 0x03
export const CALL_TYPE_GROUP = 0x04
export const CALL_TYPE_ALL = 0x05

/** Talk-group record offset within its block, 1-based. */
export function talkgroupOffset(n: number): number {
  return n === 1 ? 1 : 25 + (n - 2) * 24
}

export const ENCRYPTION_TYPES: Readonly<Record<number, string>> = {
  0: 'none',
  1: 'custom',
  2: 'arc4',
  3: 'aes128',
  4: 'aes256',
}

/**
 * An encryption key slot.
 *
 * The specification says a 32-byte key field at +0x0C in which AES-256 is
 * "right-aligned at +0x24", derived from two samples. On the test radio all
 * eight slots hold AES-256 keys occupying the **entire** 32-byte field from
 * +0x0C. The spec's sample almost certainly had a short key entered, which the
 * vendor software right-aligns; that is not where a full AES-256 key lives.
 *
 * The field is therefore carried verbatim, and interpretation of a short key's
 * placement is left to whoever can attest it - trimming or realigning bytes
 * here would corrupt a real key.
 */
export const DM32_KEY_SLOT = defineStruct(KEY_SIZE, {
  id: at(0x00, u8),
  name: at(0x01, ascii(10, { pad: 0x00, terminators: [0x00, 0xff] })),
  type: at(0x0b, u8),
  keyField: at(0x0c, bytes(32)),
})

export const keySlotOffset = (n: number) => KEY_BASE + (n - 1) * KEY_SIZE

/**
 * The only bytes this driver will write, and why they are the only ones.
 *
 * The 22 key slots occupy a contiguous 968 bytes inside block 0x10. Everything
 * else in that block - the emergency settings before it, and the roughly 2.4 KB
 * after it that nothing has ever explained - is read, preserved and never
 * touched.
 *
 * Writing is scoped this narrowly on purpose. This radio's pages move between
 * sessions, 22 of its 59 allocated blocks have no documented meaning, and a bad
 * write is not recoverable from the radio's own state. Each additional region
 * should be added the same way: documented, exercised against hardware, and
 * verified by read-back.
 */
export const KEY_AREA: readonly [number, number] = [KEY_BASE, KEY_BASE + KEY_SLOTS * KEY_SIZE]

/** An erased slot reads as 0x00 then 0xFF filler, so both count as empty. */
export function isKeySlotEmpty(slot: Uint8Array): boolean {
  return slot.every((b) => b === 0x00 || b === 0xff)
}
