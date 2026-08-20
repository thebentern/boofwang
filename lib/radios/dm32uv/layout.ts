// SPDX-License-Identifier: GPL-3.0-or-later
import { ascii, bcdFreqLE, bytes, chirpBits, u8, u16le, u24le } from '../../codec/fields.js'
import { at, defineStruct } from '../../codec/struct.js'
import { ctcss, dtcs, type ToneSpec } from '../../model/tones.js'

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

/** Records in the first channel block, which gives up 16 bytes to a header. */
export const CHANNEL_SLOTS_FIRST = Math.floor((0x1000 - CHANNEL_HEADER - 1) / CHANNEL_SIZE)
/** Records in every later channel block. */
export const CHANNEL_SLOTS_REST = Math.floor((0x1000 - 1) / CHANNEL_SIZE)

/**
 * Where channel `n` (1-based) lives, or null if it is past the bank.
 *
 * The block id is absolute, straight from the reference's entry-offset formula
 * (`05-DATA-STRUCTURES.md:53-58`), never "the next block that happens to
 * exist". This radio has channel-bank blocks 0x12, 0x13, 0x14 and then 0x18 -
 * 0x15 through 0x17 are not allocated - so walking the blocks it has would put
 * channel 255 in 0x18, which the radio reads as channel 510. The gap is real
 * and it means those channel numbers have nowhere to go, not that the ones
 * after them shuffle down.
 */
export function channelSlot(n: number): { blockId: number; offset: number } | null {
  if (!Number.isInteger(n) || n < 1) return null
  if (n <= CHANNEL_SLOTS_FIRST) {
    return { blockId: CHANNEL_BLOCK_FIRST, offset: CHANNEL_HEADER + (n - 1) * CHANNEL_SIZE }
  }
  const past = n - CHANNEL_SLOTS_FIRST - 1
  const blockId = CHANNEL_BLOCK_FIRST + 1 + Math.floor(past / CHANNEL_SLOTS_REST)
  if (blockId > CHANNEL_BLOCK_LAST) return null
  return { blockId, offset: (past % CHANNEL_SLOTS_REST) * CHANNEL_SIZE }
}

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
  /**
   * Byte 0x18. Bit positions per `reference/dm32/05-DATA-STRUCTURES.md:296-308`,
   * its Python decoder at :742 and its Go decoder at :1023, all agreeing, and
   * pinned by two worked examples with real hex: `0x14` is "digital, forbid TX
   * 0, power (bits 2-1) = 2 = High" and the analog `0x04` is "analog, power
   * High".
   *
   * This radio's own image agrees: `LR DMR` and three siblings hold `0x1c`
   * (bit 3 set = forbid TX) and the OEM CPS shows them as receive-only, while
   * `MURS-1` holds `0x04` and shows as High power.
   */
  mode: at(
    0x18,
    chirpBits(1, [
      ['channelMode', 4],
      ['txForbid', 1],
      ['power', 2],
      ['loneWorker', 1],
    ]),
  ),
  /**
   * Byte 0x19. Modelled bit by bit rather than as a `u8` so that writing the
   * bandwidth cannot take scan-list membership with it: `u8.set` stores all
   * eight bits, so a channel in scan list 3 with Auto Scan on (`0xcc`) came
   * back as `0x00`.
   *
   * Bits 6 and 5-2 are unhedged in the reference and bits 1-0 are explicitly
   * marked "preserve". The bandwidth polarity at bit 7 is marked DERIVED there
   * (:319-330) and this radio cannot settle it - all 49 of its channels hold
   * `0x19 = 0x00`. Following the reference, and the hedge stands.
   */
  scan: at(
    0x19,
    chirpBits(1, [
      ['bandwidth', 1],
      ['scanAdd', 1],
      ['scanList', 4],
      ['unknown', 2],
    ]),
  ),
  /**
   * Byte 0x1D on a digital channel. The timeslot is bit 4 and the colour code
   * is the whole low nibble - attested by the reference's OEM CPS capture,
   * where the user named channels after their slot: `RIC Monitor TS1` stores
   * `0x01` and `RIC Monitor TS2` stores `0x11`.
   *
   * Declaring the colour code as three bits put the timeslot on bit 3, so
   * switching a channel to TS2 wrote `0x0a` - which the radio reads as colour
   * code 10, still on TS1.
   */
  digital: at(
    0x1d,
    chirpBits(1, [
      ['encryptEnable', 1],
      ['shortDataConfirm', 1],
      ['tdmaDirect', 1],
      ['timeSlot', 1],
      ['colorCode', 4],
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

/**
 * Decode one of this radio's CTCSS/DCS tone words.
 *
 * Stored as two bytes `[low, high]`, read here as a little-endian u16, and the
 * digits are **packed BCD** rather than a binary count of tenths of a hertz.
 * Reading the word as deciHz - which is what this driver did until it was
 * checked against the specification - turns 127.3 Hz into 472.3 Hz and D023
 * into 3.5 Hz. Most such values fall outside CHIRP's valid tone range, so an
 * exported channel is discarded on import; the ones that land inside it are
 * worse, because they import as a plausible and wrong tone.
 *
 * `high >= 0x80` marks DCS, with `>= 0xC0` meaning the inverted polarity.
 * Anything else is CTCSS. Both `FF FF` (what the radio writes) and `00 00`
 * (what some other tools write) mean no tone.
 *
 * Layout and worked values from `reference/dm32/05-DATA-STRUCTURES.md`, whose
 * one hardware-attested example is `44 07` = 74.4 Hz.
 */
export function decodeToneWord(word: number): ToneSpec | null {
  if (word === 0x0000 || word === 0xffff) return null

  const low = word & 0xff
  const high = (word >> 8) & 0xff
  const digit = (nibble: number) => nibble & 0x0f

  if (high >= 0x80) {
    const code = digit(high) * 100 + digit(low >> 4) * 10 + digit(low)
    // The code is three BCD digits; anything else is not a tone word we know.
    if (code === 0) return null
    return dtcs(code, high >= 0xc0 ? 'R' : 'N')
  }

  const whole = digit(high >> 4) * 100 + digit(high) * 10 + digit(low >> 4)
  const deciHz = whole * 10 + digit(low)
  if (deciHz === 0) return null
  return ctcss(deciHz)
}

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

/**
 * The inverse of {@link decodeToneWord}, kept beside it so the two cannot drift.
 *
 * Produces the packed-BCD spelling the radio itself writes: `FF FF` for no tone,
 * `high >= 0x80` for DCS with `>= 0xC0` marking the inverted polarity, and
 * plain BCD digits for CTCSS. Writing the word as tenths of a hertz - which is
 * what this driver did until it was checked - turns 127.3 Hz into 472.3 Hz.
 */
export function encodeToneWord(tone: ToneSpec | null): number {
  if (!tone) return 0xffff

  if (tone.kind === 'dtcs') {
    const code = tone.code
    const hundreds = Math.floor(code / 100) % 10
    const tens = Math.floor(code / 10) % 10
    const ones = code % 10
    const high = (tone.polarity === 'R' ? 0xc0 : 0x80) | hundreds
    const low = (tens << 4) | ones
    return low | (high << 8)
  }

  // CTCSS: the value is tenths of a hertz spread over four BCD nibbles as
  // hundreds, tens, ones, tenths.
  const deciHz = tone.deciHz
  const hundreds = Math.floor(deciHz / 1000) % 10
  const tens = Math.floor(deciHz / 100) % 10
  const ones = Math.floor(deciHz / 10) % 10
  const tenths = deciHz % 10
  const high = (hundreds << 4) | tens
  const low = (ones << 4) | tenths
  return low | (high << 8)
}
