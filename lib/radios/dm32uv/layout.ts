// SPDX-License-Identifier: GPL-3.0-or-later
import { array, ascii, bcdFreqLE, bits, bytes, chirpBits, u8, u16le, u24le } from '../../codec/fields.js'
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

// --------------------------------------------------------------- scan lists --

export const SCANLIST_BLOCK = 0x11
export const SCANLIST_SIZE = 57
/**
 * One byte, not two.
 *
 * Offset 0x001 is already the first character of the first name - `S` of
 * "Scan List 1" on this radio - so a 16-bit read here would swallow it and
 * report 21,250 scan lists. The same correction the zone count needed.
 */
export const SCANLIST_HEADER = 1
export const SCANLIST_MAX_MEMBERS = 16

export const DM32_SCANLIST = defineStruct(SCANLIST_SIZE, {
  name: at(0x00, ascii(11, { pad: 0x00, terminators: [0x00, 0xff] })),
  memberCount: at(0x0b, u8),
  /** Priority 1 and 2 kinds, a nibble each. 0 = none. */
  priorityTypes: at(0x0e, u8),
  priorityChannel1: at(0x0f, u16le),
  priorityChannel2: at(0x13, u16le),
  members: at(0x18, array(SCANLIST_MAX_MEMBERS, u16le)),
})

// ---------------------------------------------------------------- rx groups --

export const RXGROUP_BLOCK = 0x0f
export const RXGROUP_SIZE = 109
export const RXGROUP_HEADER = 17
export const RXGROUP_MAX_MEMBERS = 32
/** The bitmask is 32 bits wide, which is the only evidence for the slot cap. */
export const RXGROUP_SLOTS = 32

export const DM32_RXGROUP = defineStruct(RXGROUP_SIZE, {
  name: at(0x00, ascii(11, { pad: 0x00, terminators: [0x00, 0xff] })),
  /** 32 slots of 24-bit DMR contact numbers. A slot of 0 is unused. */
  members: at(0x0b, array(RXGROUP_MAX_MEMBERS, u24le)),
})

// ---------------------------------------------------------------- radio IDs --

export const RADIOID_BLOCK = 0x67
export const RADIOID_SIZE = 16
export const RADIOID_HEADER = 16
/** The reference implementation's own cap. 254 would physically fit. */
export const RADIOID_SLOTS = 250

export const DM32_RADIOID = defineStruct(RADIOID_SIZE, {
  dmrId: at(0x00, u24le),
  name: at(0x03, ascii(12, { pad: 0x00, terminators: [0x00, 0xff] })),
})

// ------------------------------------------------- talk group quick index --

/**
 * Block 0x0B, the radio's own index of which talk-group slots are live and in
 * what order it lists them.
 *
 * Named "Quick Access Contact List" by the reference, which invites the wrong
 * conclusion: it is not an address book. It holds two sorted index tables into
 * the talk-group bank - one by name, one by DMR number - plus a bitmask of
 * which slots are occupied. Decoded here so that a gap in the talk-group bank
 * is visible rather than silently renumbered; deliberately never written.
 */
export const TG_INDEX_BLOCK = 0x0b
export const TG_INDEX_BITMASK = 0x010
export const TG_INDEX_TABLE_BY_NAME = 0x100
export const TG_INDEX_TABLE_BY_NUMBER = 0x740
export const TG_INDEX_SLOTS = 128

// ----------------------------------------------------------------- settings --

export const SETTINGS_BLOCK = 0x04

/**
 * Radio settings, block 0x04.
 *
 * One flat struct rather than a record array. Only the fields the reference
 * establishes are modelled; the ~3.8 KiB of the page nobody has named is never
 * assigned, so it survives a write by never being touched.
 *
 * Confidence is not uniform and the driver treats it that way - the schema only
 * offers the fields below that the reference marks CONFIRMED, plus the handful
 * of DERIVED ones whose meaning this radio's own bytes corroborate. Fields
 * modelled but not offered are still round-tripped.
 */
export const DM32_SETTINGS = defineStruct(0x600, {
  powerOnInterface: at(0x00, u8),
  powerOnLine1: at(0x01, ascii(14, { pad: 0x00, terminators: [0x00] })),
  powerOnLine2: at(0x0f, ascii(14, { pad: 0x00, terminators: [0x00] })),
  autoPowerOff: at(0x1e, u8),
  backlightBrightness: at(0x30, u8),
  autoBacklightDuration: at(0x31, u8),
  callsignColour: at(0x34, bits(1, { colour: [0, 4], reserved: [4, 4] })),
  standbyTextColour: at(0x35, bits(1, { colour: [0, 4], reserved: [4, 4] })),
  channelAColour: at(0x38, bits(1, { colour: [0, 4], reserved: [4, 4] })),
  channelBColour: at(0x39, bits(1, { colour: [0, 4], reserved: [4, 4] })),
  zoneAColour: at(0x3a, bits(1, { colour: [0, 4], reserved: [4, 4] })),
  zoneBColour: at(0x3b, bits(1, { colour: [0, 4], reserved: [4, 4] })),
  gpsFlags: at(
    0x40,
    bits(1, {
      gpsSwitch: [0, 1],
      distanceUnit: [1, 1],
      gpsMode: [2, 2],
      speedUnit: [4, 2],
      gpsDisplayFormat: [6, 1],
      reserved: [7, 1],
    }),
  ),
  gpsReportInterval: at(0x42, u8),
  digitalDecodeFlags: at(0x60, bits(1, { privateCallMatch: [0, 1], groupCallMatch: [1, 1], reserved: [2, 6] })),
  callHoldTime: at(0x61, u8),
  activeRetriesTime: at(0x63, u8),
  keyLockFlags: at(0x85, bits(1, { lockKey: [0, 1], knobLock: [1, 1], sideKeyLock: [2, 1], reserved: [3, 5] })),
  autoKeypadLockDelay: at(0x86, u8),
  sk1Short: at(0x87, u8),
  sk1Long: at(0x88, u8),
  sk2Short: at(0x89, u8),
  sk2Long: at(0x8a, u8),
  p1Short: at(0x8d, u8),
  p1Long: at(0x8e, u8),
  p2Short: at(0x8f, u8),
  p2Long: at(0x90, u8),
  longPressTime: at(0x93, u8),
  latitude: at(0x306, ascii(9, { pad: 0x00, terminators: [0x00] })),
  latitudeDirection: at(0x30f, ascii(1, { pad: 0x00, terminators: [] })),
  longitude: at(0x310, ascii(9, { pad: 0x00, terminators: [0x00] })),
  longitudeDirection: at(0x319, ascii(1, { pad: 0x00, terminators: [] })),
})

/**
 * The colour enum shared by all six colour bytes.
 *
 * Values 8-15 are storable in the nibble but the reference names none of them.
 */
export const DM32_COLOURS = [
  'White',
  'Black',
  'Orange',
  'Red',
  'Yellow',
  'Green',
  'Cyan',
  'Blue',
] as const

/**
 * Side and programmable key functions, 0-42.
 *
 * Transcribed from `reference/dm32/05-DATA-STRUCTURES.md:2253-2271`, value by
 * value. An earlier version of this table claimed the same provenance and did
 * not have it: it was a plausible-looking DMR function list that agreed with the
 * reference for the first fourteen entries and invented every one after. Because
 * the schema builds the dropdown as `map((label, value) => ...)`, the index IS
 * the byte written to the radio, so a wrong label here is a wrong byte - picking
 * "Monitor" would have stored 16, which this radio reads as Zone Up.
 *
 * This radio's own bytes are the check: 0x088=0x1c, 0x089=0x19, 0x08d=0x11,
 * 0x08f=0x10 read as Keypad Lock, Monitor, Zone Down, Zone Up - a coherent
 * Zone Down/Zone Up pair on the two programmable keys, which the old table
 * rendered as "Squelch Off" and "Monitor".
 */
export const DM32_KEY_FUNCTIONS = [
  'None', 'Power Select', 'Volt', 'Talkaround', 'Digital Encrypt', 'Call', 'VOX',
  'V/M', 'Alarm', 'One Touch Call 1', 'One Touch Call 2', 'One Touch Call 3',
  'One Touch Call 4', 'One Touch Call 5', 'SMS', 'CSV Contacts', 'Zone Up',
  'Zone Down', 'Scan', 'Record Switch', 'Previous Record', 'Next Record',
  'FM Radio', 'FM Search', 'GPS Information', 'Monitor', 'Switch Main Channel',
  'Lone Work', 'Keypad Lock', 'Nuisance Channel Delete', 'TBST Send', 'APRS Send',
  'Channel Type', 'Display Mode', 'CTC Scan', 'CTC Setting', 'Silent Tone',
  'Roaming', 'Sub-PTT', 'Analog Scramble Switch', 'One Key Scan Freq',
  'Flashlight', 'Man Down Alarm',
] as const

// ----------------------------------------------------------------- contacts --

/**
 * The DMR address book.
 *
 * Not a block. It lives in a raw region of its own - roughly 4.4 MiB on this
 * firmware - located per session by V-frame 0x0F, with no logical block id and
 * no flash translation layer: these are real physical addresses that stay put.
 *
 * Three different things in this radio are called a contact and the reference
 * warns about it explicitly: this address book, a talk group in block 0x44, and
 * a 12-bit per-channel index into that block. Only the first is this.
 */
export const CONTACT_SIZE = 92
/** Count word, then twelve bytes nobody has explained, then entry 0. */
export const CONTACT_REGION_HEADER = 16
/**
 * Entries do not straddle a 4 KiB page: 44 x 92 = 4048, and the rest of the page
 * is fill. The flat `index * 92` formula in circulation is wrong twice over -
 * it omits the header and it walks straight across the page boundary.
 */
export const CONTACTS_PER_PAGE = 44

export const DM32_CONTACT = defineStruct(CONTACT_SIZE, {
  name: at(0x00, ascii(16, { pad: 0xff, terminators: [0x00, 0xff] })),
  dmrId: at(0x10, u24le),
  callsign: at(0x14, ascii(8, { pad: 0xff, terminators: [0x00, 0xff] })),
  city: at(0x1c, ascii(16, { pad: 0xff, terminators: [0x00, 0xff] })),
  province: at(0x2c, ascii(16, { pad: 0xff, terminators: [0x00, 0xff] })),
  country: at(0x3c, ascii(16, { pad: 0xff, terminators: [0x00, 0xff] })),
  remark: at(0x4c, ascii(16, { pad: 0xff, terminators: [0x00, 0xff] })),
})

/** Where contact `n` (0-based) sits: which page of the region, and where in it. */
export function contactSlot(n: number): { page: number; offset: number } {
  const page = Math.floor(n / CONTACTS_PER_PAGE)
  const within = n % CONTACTS_PER_PAGE
  // Only the first page gives up its first sixteen bytes to the header.
  return { page, offset: (page === 0 ? CONTACT_REGION_HEADER : 0) + within * CONTACT_SIZE }
}
