// SPDX-License-Identifier: GPL-3.0-or-later
import { array, ascii, bcdFreqLE, bcdLE, bits, bytes, chirpBits, u16le, u24le, u8, utf16le } from '../../codec/fields.js'
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
  allowReset: at(0x1d, bits(1, { allowReset: [0, 1], reserved: [1, 7] })),
  autoPowerOff: at(0x1e, u8),
  alertTones: at(
    0x20,
    bits(1, {
      keyPress: [0, 1],
      keyRelease: [1, 1],
      menuExit: [2, 1],
      callEnd: [3, 1],
      talkPermit: [4, 1],
      startUpSound: [5, 1],
      voicePrompt: [6, 1],
      scanStop: [7, 1],
    }),
  ),
  alertTonesCont: at(
    0x21,
    bits(1, { batteryLow: [0, 1], analogTxEnd: [1, 1], analogTxAlert: [2, 1], unknownHigh: [3, 5] }),
  ),
  displayFlags: at(
    0x33,
    bits(1, { volumeChangePrompt: [0, 1], timeDisplay: [1, 1], unknown2: [2, 1], dateFormat: [3, 1], unknownHigh: [4, 4] }),
  ),
  menuExitTime: at(0x36, u8),
  standbyCharColour1: at(0x37, u8),
  utcZone: at(0x41, u8),
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
  /**
   * Raw bytes, deliberately.
   *
   * The reference gives scaling formulas for the four timers below - active
   * wait is `(raw-1)*30 + 300` ms, pre-carrier `(raw+1)*120` ms, SMS format
   * `(raw+1)*10` s - but marks every one of them derived from *model comments*
   * rather than from a capture, and says its own code stores the raw byte and
   * labels the control "(raw)". Applying an unverified formula would show a
   * confident wrong number; the byte is at least true.
   */
  activeWaitTime: at(0x62, u8),
  activeRetriesTime: at(0x63, u8),
  preCarrierTime: at(0x64, u8),
  digitalFlags: at(
    0x65,
    bits(1, {
      missedCallAlert: [0, 1],
      dataService: [1, 2],
      callAlertDecode: [3, 1],
      radioEnableDecode: [4, 1],
      radioCheckDecode: [5, 1],
      radioDisableDecode: [6, 1],
      remoteMonitorDecode: [7, 1],
    }),
  ),
  smsFormat: at(0x66, u8),
  nameDisplayFlags: at(
    0x67,
    bits(1, {
      unknownLow: [0, 2],
      nameDisplayPriority: [2, 1],
      sendTxName: [3, 1],
      unknownMid: [4, 2],
      nameDataFormat: [6, 2],
    }),
  ),
  txDwellTime: at(0x81, u8),
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

  /**
   * One Touch Call, base 0x200, five entries of five bytes.
   *
   * Layout confirmed: all five entries in the factory dump decode inside their
   * enums, which a wrong alignment would not manage five times running.
   */
  oneTouch1Type: at(0x200, u8),
  oneTouch1Object: at(0x201, u16le),
  oneTouch1CallType: at(0x203, u8),
  oneTouch1Sms: at(0x204, u8),
  oneTouch2Type: at(0x205, u8),
  oneTouch2Object: at(0x206, u16le),
  oneTouch2CallType: at(0x208, u8),
  oneTouch2Sms: at(0x209, u8),
  oneTouch3Type: at(0x20a, u8),
  oneTouch3Object: at(0x20b, u16le),
  oneTouch3CallType: at(0x20d, u8),
  oneTouch3Sms: at(0x20e, u8),
  oneTouch4Type: at(0x20f, u8),
  oneTouch4Object: at(0x210, u16le),
  oneTouch4CallType: at(0x212, u8),
  oneTouch4Sms: at(0x213, u8),
  oneTouch5Type: at(0x214, u8),
  oneTouch5Object: at(0x215, u16le),
  oneTouch5CallType: at(0x217, u8),
  oneTouch5Sms: at(0x218, u8),

  /**
   * Fun+, base 0x230, ten entries of seven bytes.
   *
   * The reference's two internal sources disagreed by one byte over where the
   * entry starts; the factory dump settles it, because under the shifted
   * reading Operate Mode would hold values up to 13 against a 0-1 range. The
   * `+0x02` padding byte is left unclaimed rather than written as zero.
   *
   * The Fun+ number is the entry index and is not stored in the entry.
   */
  funPlus1Mode: at(0x230, u8),
  funPlus1Menu: at(0x231, u8),
  funPlus1CallWay: at(0x233, u8),
  funPlus1CallObject: at(0x234, u8),
  funPlus1CallType: at(0x235, u8),
  funPlus1Sms: at(0x236, u8),
  funPlus2Mode: at(0x237, u8),
  funPlus2Menu: at(0x238, u8),
  funPlus2CallWay: at(0x23a, u8),
  funPlus2CallObject: at(0x23b, u8),
  funPlus2CallType: at(0x23c, u8),
  funPlus2Sms: at(0x23d, u8),
  funPlus3Mode: at(0x23e, u8),
  funPlus3Menu: at(0x23f, u8),
  funPlus3CallWay: at(0x241, u8),
  funPlus3CallObject: at(0x242, u8),
  funPlus3CallType: at(0x243, u8),
  funPlus3Sms: at(0x244, u8),
  funPlus4Mode: at(0x245, u8),
  funPlus4Menu: at(0x246, u8),
  funPlus4CallWay: at(0x248, u8),
  funPlus4CallObject: at(0x249, u8),
  funPlus4CallType: at(0x24a, u8),
  funPlus4Sms: at(0x24b, u8),
  funPlus5Mode: at(0x24c, u8),
  funPlus5Menu: at(0x24d, u8),
  funPlus5CallWay: at(0x24f, u8),
  funPlus5CallObject: at(0x250, u8),
  funPlus5CallType: at(0x251, u8),
  funPlus5Sms: at(0x252, u8),
  funPlus6Mode: at(0x253, u8),
  funPlus6Menu: at(0x254, u8),
  funPlus6CallWay: at(0x256, u8),
  funPlus6CallObject: at(0x257, u8),
  funPlus6CallType: at(0x258, u8),
  funPlus6Sms: at(0x259, u8),
  funPlus7Mode: at(0x25a, u8),
  funPlus7Menu: at(0x25b, u8),
  funPlus7CallWay: at(0x25d, u8),
  funPlus7CallObject: at(0x25e, u8),
  funPlus7CallType: at(0x25f, u8),
  funPlus7Sms: at(0x260, u8),
  funPlus8Mode: at(0x261, u8),
  funPlus8Menu: at(0x262, u8),
  funPlus8CallWay: at(0x264, u8),
  funPlus8CallObject: at(0x265, u8),
  funPlus8CallType: at(0x266, u8),
  funPlus8Sms: at(0x267, u8),
  funPlus9Mode: at(0x268, u8),
  funPlus9Menu: at(0x269, u8),
  funPlus9CallWay: at(0x26b, u8),
  funPlus9CallObject: at(0x26c, u8),
  funPlus9CallType: at(0x26d, u8),
  funPlus9Sms: at(0x26e, u8),
  funPlus10Mode: at(0x26f, u8),
  funPlus10Menu: at(0x270, u8),
  funPlus10CallWay: at(0x272, u8),
  funPlus10CallObject: at(0x273, u8),
  funPlus10CallType: at(0x274, u8),
  funPlus10Sms: at(0x275, u8),

  /** APRS. The position strings below are hardware-confirmed; the rest is derived. */
  aprsScheduledSendTime: at(0x301, u8),
  aprsFixedBeacon: at(0x302, bits(1, { enabled: [0, 1], unknownHigh: [1, 7] })),
  aprsReportChannel1: at(0x320, u16le),
  aprsReportChannel2: at(0x322, u16le),
  aprsReportChannel3: at(0x324, u16le),
  aprsReportChannel4: at(0x326, u16le),
  aprsReportChannel5: at(0x328, u16le),
  aprsReportChannel6: at(0x32a, u16le),
  aprsReportChannel7: at(0x32c, u16le),
  aprsReportChannel8: at(0x32e, u16le),
  aprsRepeaterActiveDelay: at(0x330, u8),
  aprsCallType: at(0x331, bits(1, { group: [0, 1], unknownHigh: [1, 7] })),
  /**
   * Little-endian, on the evidence rather than by preference.
   *
   * The byte order is disputed, and both captured values are only plausible
   * DMR IDs read little-endian - factory `C8 01 00` is 456 one way and
   * 13,107,456 the other. Two samples is not proof, so this is the reading to
   * revisit if a radio ever shows a different ID than the one written here.
   */
  aprsUploadId: at(0x332, u24le),

  /**
   * Menu enable bits, 0x500-0x507 - one bit per menu item, set meaning shown.
   *
   * The polarity is derived, and an inverted reading circulates. What is not in
   * doubt is that the unlabelled bits carry data: the OEM write capture has
   * bits set at 0x500 bits 2-7, 0x503 bit 7, 0x505 bits 4-7 and 0x507 bits 5-7,
   * so these bytes are read-modify-written a bit at a time and never rebuilt.
   */
  menuZone: at(0x500, bits(1, { zoneList: [0, 1], newZone: [1, 1], unknownHigh: [2, 6] })),
  menuCall: at(
    0x501,
    bits(1, {
      callAlert: [0, 1],
      radioCheck: [1, 1],
      remoteMonitor: [2, 1],
      radioEnable: [3, 1],
      radioDisable: [4, 1],
      measurePeriod: [5, 1],
      unknownHigh: [6, 2],
    }),
  ),
  menuSettingsA: at(
    0x502,
    bits(1, {
      talkaround: [0, 1],
      alertTone: [1, 1],
      txPower: [2, 1],
      startDisplay: [3, 1],
      langSelect: [4, 1],
      matchPrivate: [5, 1],
      matchGroup: [6, 1],
      displayMode: [7, 1],
    }),
  ),
  menuSettingsB: at(
    0x503,
    bits(1, {
      smsFormat: [0, 1],
      subChannelMode: [1, 1],
      powerSave: [2, 1],
      fmRadio: [3, 1],
      gps: [4, 1],
      aprs: [5, 1],
      record: [6, 1],
      unknownHigh: [7, 1],
    }),
  ),
  menuContact: at(
    0x504,
    bits(1, {
      addContact: [0, 1],
      delContact: [1, 1],
      editContact: [2, 1],
      sendMessage: [3, 1],
      functionality: [4, 1],
      manualDial: [5, 1],
      csvContacts: [6, 1],
      unknownHigh: [7, 1],
    }),
  ),
  menuLog: at(
    0x505,
    bits(1, {
      missedCall: [0, 1],
      answeredCall: [1, 1],
      sentCall: [2, 1],
      delLog: [3, 1],
      unknownHigh: [4, 4],
    }),
  ),
  menuChannelA: at(
    0x506,
    bits(1, {
      rxFrequency: [0, 1],
      txFrequency: [1, 1],
      ctcDcs: [2, 1],
      txContact: [3, 1],
      colorCode: [4, 1],
      timeSlot: [5, 1],
      radioId: [6, 1],
      radioName: [7, 1],
    }),
  ),
  menuChannelB: at(
    0x507,
    bits(1, {
      channelType: [0, 1],
      tdmaDirectMode: [1, 1],
      rxGroupList: [2, 1],
      addChannel: [3, 1],
      channelName: [4, 1],
      unknownHigh: [5, 3],
    }),
  ),
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

/**
 * What byte 0x13 of a contact record holds.
 *
 * Unexplained, and not the top of the DMR ID - that would put every id above
 * four billion, and they are 24-bit. It reads 0xF0 on all 147 entries of the
 * development radio and in the reference's only sample, so 148 for 148. An
 * existing record keeps whatever it has; a brand-new one gets this, because
 * leaving the 0xFF that an erased region is filled with would make it the only
 * record on the radio that differs.
 */
export const CONTACT_UNKNOWN_13 = 0xf0

export const DM32_CONTACT = defineStruct(CONTACT_SIZE, {
  name: at(0x00, ascii(16, { pad: 0xff, terminators: [0x00, 0xff] })),
  dmrId: at(0x10, u24le),
  unknown13: at(0x13, u8),
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

// ---------------------------------------------------------------- the VFOs --

/**
 * VFO A and VFO B, which are ordinary 48-byte channel records living at fixed
 * offsets in the last channel block.
 *
 * The two abut and finish exactly on the block's id byte - `0x0F9F + 48 =
 * 0x0FCF`, `0x0FCF + 48 = 0x0FFF` - and that is what pins them. Starting a byte
 * later decodes the same frequency but runs VFO B over the id byte, so the
 * geometry settles an offset the frequency alone cannot.
 *
 * The reference calls them channels 4001 and 4002. They are not in the channel
 * bank, are not counted by its header, and a zone cannot point at them.
 */
export const VFO_BLOCK = CHANNEL_BLOCK_LAST
export const VFO_A = 0x0f9f
export const VFO_B = VFO_A + CHANNEL_SIZE
export const VFO_AREA = [VFO_A, VFO_B + CHANNEL_SIZE] as const

// ------------------------------------------------ per-channel TX contact --

/**
 * Which talk group a channel transmits to.
 *
 * The channel record does not carry it. Byte 0x2B of a channel is the DMR
 * *radio ID* index, not a contact - a distinction the reference calls out
 * because three different things in this radio are called a contact. The TX
 * contact lives in two dedicated blocks, two bytes per channel.
 *
 * Only 0x42 is written. It covers channels 1-2047, which is every channel any
 * observed radio has; 0x43 is decoded but left alone, because on the
 * development radio its tail holds "Zone 1" strings rather than contact data
 * and nothing explains why.
 */
export const TXCONTACT_BLOCK_LOW = 0x42
export const TXCONTACT_BLOCK_HIGH = 0x43
/** Channel 2048's entry is at offset 0 of 0x43, so the split is 2047/2048. */
export const TXCONTACT_SPLIT = 2047
/**
 * Where the usable part of block 0x43 stops.
 *
 * From 0x0EF6 the page holds two stale zone records the flash layer left
 * behind - "Zone 1", count 1, member channel 1, a default no zone on the
 * development radio uses. They are dead: off the zone bank's own 145-byte grid
 * by 44 bytes, and the second runs 25 bytes past the page's last payload byte.
 * Dead or not, they are not contact data, so neither the encoder nor
 * `ownedRanges` goes past here. Channels 3963 and up need channel block 0x40,
 * which no radio this has been read from allocates.
 */
export const TXCONTACT_HIGH_LIMIT = 0x0ef6

/** Where channel `n` (1-based) keeps its TX contact, or null if it has nowhere. */
export function txContactSlot(n: number): { blockId: number; offset: number } | null {
  if (!Number.isInteger(n) || n < 1) return null
  if (n <= TXCONTACT_SPLIT) return { blockId: TXCONTACT_BLOCK_LOW, offset: (n - 1) * 2 }
  if (n > 4000) return null
  return { blockId: TXCONTACT_BLOCK_HIGH, offset: (n & 0x7ff) * 2 }
}

/**
 * A TX contact entry: a 12-bit talk-group slot split across two bytes, plus a
 * digital flag in the low bit of the first.
 *
 * Bits 3-1 of byte 0 are unexplained and are preserved rather than cleared.
 */
export function decodeTxContact(b0: number, b1: number): { slot: number; digital: boolean } {
  return { slot: ((b0 >> 4) << 8) | b1, digital: (b0 & 1) === 1 }
}

export function encodeTxContact(slot: number, digital: boolean, previous: number): [number, number] {
  const keep = previous & 0b0000_1110 // bits 3-1, meaning unestablished
  return [((slot >> 8) << 4) | keep | (digital ? 1 : 0), slot & 0xff]
}

// ------------------------------------------------------- quick text messages --

/**
 * Canned text messages, block 0x0A.
 *
 * One count byte, a fifteen-byte header nobody has explained, then
 * length-prefixed ASCII. The simplest structure in this radio and the only one
 * whose geometry is uniquely determined rather than merely consistent: a
 * brute-force search over (base, stride) leaves exactly one pair standing.
 */
export const MESSAGE_BLOCK = 0x0a
export const MESSAGE_SIZE = 0x81
export const MESSAGE_HEADER = 0x10
/** What fits before the block id byte: slot 31 ends at 0xFAE. */
export const MESSAGE_SLOTS = Math.floor((0x1000 - 1 - MESSAGE_HEADER) / MESSAGE_SIZE)
/** 128 bytes of field, the last reserved as a terminator. */
export const MESSAGE_MAX_CHARS = 127

export const DM32_MESSAGE = defineStruct(MESSAGE_SIZE, {
  textLength: at(0x00, u8),
  text: at(0x01, ascii(MESSAGE_MAX_CHARS, { pad: 0x00, terminators: [0x00, 0xff] })),
})

export const messageOffset = (n: number) => MESSAGE_HEADER + n * MESSAGE_SIZE

// ------------------------------------------------------------------ roaming --

/**
 * Roaming channels, block 0x66 - a repeater pair the radio can fall back to.
 *
 * No header, and the count is a *trailer* at 0x0FF0 rather than a header byte.
 * That is unique in this radio and worth stating plainly: every other counted
 * structure here puts its count first.
 */
export const ROAMCHANNEL_BLOCK = 0x66
export const ROAMCHANNEL_SIZE = 26
export const ROAMCHANNEL_COUNT_AT = 0x0ff0
export const ROAMCHANNEL_SLOTS = Math.floor(ROAMCHANNEL_COUNT_AT / ROAMCHANNEL_SIZE)

export const DM32_ROAMCHANNEL = defineStruct(ROAMCHANNEL_SIZE, {
  name: at(0x00, ascii(16, { pad: 0x00, terminators: [0x00, 0xff] })),
  rxFreq: at(0x10, bcdFreqLE(4)),
  txFreq: at(0x14, bcdFreqLE(4)),
  // Only the low bits are understood in either byte, so both are modelled as
  // bitfields: a whole-byte write here is the mistake that once erased
  // scan-list membership from channel byte 0x19.
  colour: at(0x18, bits(1, { colorCode: [0, 4], unknownHigh: [4, 4] })),
  slot: at(0x19, bits(1, { timeSlot: [0, 1], unknownHigh: [1, 7] })),
})

/**
 * Roaming zones, block 0x65.
 *
 * Records run from the top of the page with no header, 33 bytes each, and the
 * name sits at `+0x10` rather than at the start. That is the reference's own
 * field table, and this radio's bytes agree: record 0 begins `03 00 01 01`
 * while records 1 and 2 begin `ff ff ff ff`, which is per-record flags in an
 * erased state rather than a page header.
 *
 * The `03` in record 0 is not a zone count. It reads as one - this radio has
 * three zones - and that coincidence is exactly what makes it worth writing
 * down. Occupancy is by content, like the talk groups.
 *
 * There is no channel list. Flags at `+0x00`, name at `+0x10` and the count or
 * index byte at `+0x20` account for all 33 bytes, and the reference says in as
 * many words that where the list lives is unresolved. It is not that the entry
 * width is unknown; there is nowhere in the record for entries to be.
 */
/**
 * Block 0x03 - the "Call" list.
 *
 * The one block the reference classes as unknown that the OEM CPS nonetheless
 * both reads and writes, so it is real codeplug data rather than a scratch
 * buffer. The record layout is confirmed twice over: the reference's capture
 * and this radio agree byte for byte, down to the same four reference values.
 *
 * What the records are *for* is still unknown. The two reference fields draw
 * from a set of exactly four values and the six populated entries enumerate
 * every unordered pair of that set - C(4,2) = 6 - which reads like factory
 * demonstration data and matches nothing else in the codeplug. So the names are
 * editable and the two references are carried, shown, and left alone.
 *
 * This is also the only block whose names are UTF-16LE.
 */
export const CALLLIST_BLOCK = 0x03
export const CALLLIST_BASE = 0x218
export const CALLLIST_SIZE = 0x28
export const CALLLIST_NAME_AT = 0x08
export const CALLLIST_NAME_BYTES = 32
/**
 * Thirty-two records, which is neither the reference's figure nor the page's.
 *
 * The reference says 92. That cannot be right: 92 records of 40 bytes from
 * 0x218 would end at 0x1078, past the end of a 4 KiB page. Filling the page
 * instead gives 88, and that is wrong too - the records stop well before it.
 *
 * A different structure begins at exactly `0x218 + 32 * 0x28` = 0x718: DTMF
 * digit runs (`01 02 03 04 05`, `0a 0b 0c 0d` for A-D) and the words "Enable"
 * and "Disable" in plain single-byte ASCII, which no record in this block uses.
 * Read as call records that region decodes to sixteen-character strings of
 * U+FFFF and reference values that are really the letters of "Disable" - which
 * is what the 88-slot reading produced before this bound existed, and it would
 * have let a write put a name over it.
 *
 * Thirty-two is also what this radio caps its RX groups and scan lists at.
 */
export const CALLLIST_SLOTS = 32
/** Where the unrelated structure after the records starts. Nothing here writes past it. */
export const CALLLIST_END = CALLLIST_BASE + CALLLIST_SLOTS * CALLLIST_SIZE

export const DM32_CALLLIST = defineStruct(CALLLIST_SIZE, {
  /** `FE FF` where the CPS populated the entry, `FF FF` where it did not. */
  inUse: at(0x00, u16le),
  referenceA: at(0x02, u16le),
  referenceB: at(0x04, u16le),
  name: at(CALLLIST_NAME_AT, utf16le(CALLLIST_NAME_BYTES)),
})

export const ROAMZONE_BLOCK = 0x65
export const ROAMZONE_SIZE = 33
export const ROAMZONE_NAME_AT = 0x10
export const ROAMZONE_SLOTS = Math.floor((0x1000 - 1) / ROAMZONE_SIZE)

export const DM32_ROAMZONE = defineStruct(ROAMZONE_SIZE, {
  flags: at(0x00, bits(1, { enabled: [0, 1], unknownHigh: [1, 7] })),
  name: at(ROAMZONE_NAME_AT, ascii(16, { pad: 0x00, terminators: [0x00, 0xff] })),
  /** Called "channel count / index" by the reference. 0 on every record here. */
  channelIndex: at(0x20, u8),
})

// -------------------------------------------------------- digital emergency --

/**
 * Digital emergency systems, block 0x10 at 0x000.
 *
 * Eight fixed records of 20 bytes sharing a page with the encryption key slots
 * at 0x300. No count and no bitmask: a record is empty when all twenty bytes
 * are 0x00 or 0xFF, the same either-fill test the key slots use.
 *
 * Read only. Every field past the name is DERIVED, all eight records on this
 * radio hold factory defaults byte-identical to the reference's capture of a
 * different unit, and no channel references one.
 */
export const EMERGENCY_SIZE = 0x14
export const EMERGENCY_SLOTS = 8
export const EMERGENCY_AREA = [0x000, EMERGENCY_SLOTS * EMERGENCY_SIZE] as const

export const DM32_EMERGENCY = defineStruct(EMERGENCY_SIZE, {
  name: at(0x00, ascii(8, { pad: 0x00, terminators: [0x00, 0xff] })),
  alarmType: at(0x0a, u8),
  alarmMode: at(0x0b, u8),
  revertChannel: at(0x0c, u16le),
})

// ------------------------------------------------------------ analog config --

/**
 * Block 0x06: DTMF signalling and two analog contact lists.
 *
 * Eight sub-structures in one page rather than an array. Read only - the
 * settings record at 0x100 is almost entirely unexplained, and a control for a
 * byte whose meaning is a guess is worse than none.
 */
export const ANALOG_BLOCK = 0x06
export const DTMF_CODE_SLOTS = 16
export const DTMF_CODE_SIZE = 16
export const DTMF_SPECIAL_BASE = 0x110
export const DTMF_SPECIAL_SLOTS = 4
export const ANALOG_CONTACT_COUNT_AT = 0x1ff
export const ANALOG_CONTACT_BASE = 0x200
export const ANALOG_CONTACT_SIZE = 32
export const BDC_COUNT_AT = 0xa90
export const BDC_BASE = 0xaa0
export const BDC_SIZE = 20

export const DM32_ANALOG_CONTACT = defineStruct(ANALOG_CONTACT_SIZE, {
  name: at(0x00, ascii(16, { pad: 0x00, terminators: [0x00, 0xff] })),
})

export const DM32_BDC_CONTACT = defineStruct(BDC_SIZE, {
  name: at(0x00, ascii(16, { pad: 0x00, terminators: [0x00, 0xff] })),
  /**
   * Packed BCD, not a plain byte.
   *
   * Nine of this radio's ten records read 01-09, where hex and decimal
   * coincide and nothing is settled. The tenth is the discriminator: it holds
   * 0x10 against a name ending "10", which is 16 read as a byte. The same
   * encoding the frequencies use.
   */
  number: at(0x10, bcdLE(1)),
})

/**
 * A DTMF code: one digit per byte, 0xFF ends it.
 *
 * 0x0E is not a terminator - this radio's first slot is `04 05 06 0e 01 02 03
 * ff`, a seven-digit code with a symbol in the middle. Which symbol 0x0E and
 * 0x0F are is the reference's claim, not the bytes'.
 */
export const DTMF_DIGITS = '0123456789ABCD*#'

export function decodeDtmf(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) {
    if (b === 0xff) break
    out += DTMF_DIGITS[b] ?? '?'
  }
  return out
}
