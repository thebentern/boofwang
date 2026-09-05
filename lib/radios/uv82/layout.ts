// SPDX-License-Identifier: GPL-3.0-or-later
import { ascii, bytes, chirpBits, lbcdFreq, u16le, u8 } from '../../codec/fields.js'
import { at, defineStruct } from '../../codec/struct.js'
import { DTCS_CODES } from '../../model/tones.js'
import { IDENT_SIZE, IMAGE_SIZE } from './protocol.js'

/**
 * Baofeng UV-82 memory layout.
 *
 * Transcribed from `MEM_FORMAT` in CHIRP's `uv5r.py` (GPL-3.0). Every offset
 * there is relative to the start of the *image*, which begins with the 8 ident
 * bytes - so the channel table sits at image 0x0008 while the radio itself
 * calls that address 0x0000. Keeping CHIRP's convention means the numbers here
 * can be compared with the source directly.
 */

export const CHANNEL_BASE = 0x0008
export const CHANNEL_COUNT = 128
export const NAME_BASE = 0x1008
export const NAME_SIZE = 16
/** Only the first seven bytes are the name; the rest is unknown padding. */
export const NAME_LENGTH = 7

export const SETTINGS_BASE = 0x0e28
/**
 * What the writer must claim for the settings block.
 *
 * Blocks go to the radio as 16 bytes at an address, so a claim that ended
 * mid-block would have the writer sending bytes it never said it understood.
 * The struct is 0x2E; this rounds it up to the block the writer will actually
 * transmit. The two bytes past the struct are carried through from the radio,
 * never written, so rounding up claims nothing the encoder then changes.
 */
export const SETTINGS_CLAIM = 0x30
export const VFO_A_BASE = 0x0f10
export const VFO_B_BASE = 0x0f30
/**
 * The power-on message.
 *
 * CHIRP leaves this address as a `%04X` placeholder in `MEM_FORMAT` and fills
 * it from `_mem_params` at parse time. The UV-82 does not override the base
 * class, so 0x1828 is the value that applies - and the block at 0x1818 that
 * looks like it in a hex dump is `sixpoweron_msg`, a different thing.
 */
export const POWERON_MSG_BASE = 0x1828

/**
 * A channel record.
 *
 * Bit orders come straight from CHIRP's declarations, so `chirpBits` takes them
 * in the same MSB-first order they are written there.
 */
export const UV82_CHANNEL = defineStruct(16, {
  rxFreq: at(0x00, lbcdFreq(4)),
  txFreq: at(0x04, lbcdFreq(4)),
  rxTone: at(0x08, u16le),
  txTone: at(0x0a, u16le),
  f0c: at(
    0x0c,
    chirpBits(1, [
      ['unused1', 3],
      ['isUhf', 1],
      ['scode', 4],
    ]),
  ),
  f0d: at(
    0x0d,
    chirpBits(1, [
      ['unknown1', 7],
      ['txToneIcon', 1],
    ]),
  ),
  f0e: at(
    0x0e,
    chirpBits(1, [
      ['mailIcon', 3],
      ['unknown2', 3],
      ['lowPower', 2],
    ]),
  ),
  f0f: at(
    0x0f,
    chirpBits(1, [
      ['unknown3', 1],
      ['wide', 1],
      ['unknown4', 2],
      ['bcl', 1],
      ['scan', 1],
      ['pttId', 2],
    ]),
  ),
})

export const UV82_NAME = defineStruct(NAME_SIZE, {
  name: at(0x00, ascii(NAME_LENGTH, { pad: 0xff, terminators: [0x00, 0xff] })),
})

/**
 * The settings block, transcribed from the `settings` struct in `uv5r.py`.
 *
 * The `unknown` runs are named rather than skipped for the same reason the
 * channel record names its spare bits: `write()` only assigns the keys it is
 * handed, so anything that stays unnamed here is carried through from the
 * radio's own bytes - but anything that IS named can be checked against CHIRP,
 * and a gap in the middle of a struct is how an offset slips by one.
 */
export const UV82_SETTINGS = defineStruct(0x2e, {
  squelch: at(0x00, u8),
  step: at(0x01, u8),
  unknown1: at(0x02, u8),
  save: at(0x03, u8),
  vox: at(0x04, u8),
  unknown2: at(0x05, u8),
  abr: at(0x06, u8),
  tdr: at(0x07, u8),
  beep: at(0x08, u8),
  timeout: at(0x09, u8),
  unknown3: at(0x0a, bytes(4)),
  voice: at(0x0e, u8),
  unknown4: at(0x0f, u8),
  dtmfst: at(0x10, u8),
  unknown5: at(0x11, u8),
  f12: at(
    0x12,
    chirpBits(1, [
      ['unknown12', 6],
      ['screv', 2],
    ]),
  ),
  pttid: at(0x13, u8),
  pttlt: at(0x14, u8),
  mdfa: at(0x15, u8),
  mdfb: at(0x16, u8),
  bcl: at(0x17, u8),
  autolk: at(0x18, u8),
  sftd: at(0x19, u8),
  unknown6: at(0x1a, bytes(3)),
  wtled: at(0x1d, u8),
  rxled: at(0x1e, u8),
  txled: at(0x1f, u8),
  almod: at(0x20, u8),
  band: at(0x21, u8),
  tdrab: at(0x22, u8),
  ste: at(0x23, u8),
  rpste: at(0x24, u8),
  rptrl: at(0x25, u8),
  ponmsg: at(0x26, u8),
  roger: at(0x27, u8),
  rogerrx: at(0x28, u8),
  tdrch: at(0x29, u8),
  f2a: at(
    0x2a,
    chirpBits(1, [
      ['displayab', 1],
      ['unknown7', 2],
      ['fmradio', 1],
      ['alarm', 1],
      ['unknown8', 1],
      ['reset', 1],
      ['menu', 1],
    ]),
  ),
  f2b: at(
    0x2b,
    chirpBits(1, [
      ['unknown9', 6],
      ['singleptt', 1],
      ['vfomrlock', 1],
    ]),
  ),
  workmode: at(0x2c, u8),
  keylock: at(0x2d, u8),
})

/**
 * Two lines of seven characters, shown while the radio powers up.
 *
 * Decoded but never written, and it cannot be until the writer grows an aux
 * pass: 0x1828 is past the end of the main block, and this driver's write path
 * sends the main block only. `ownedRanges` says so - it stops at the main block
 * - which is what keeps a change here from reaching the radio unnoticed.
 */
export const UV82_POWERON_MSG = defineStruct(14, {
  line1: at(0x00, ascii(7, { pad: 0xff, terminators: [0x00, 0xff] })),
  line2: at(0x07, ascii(7, { pad: 0xff, terminators: [0x00, 0xff] })),
})

// ------------------------------------------------------------ field values --

/** `lowPower` indexes the power table: 0 is High. */
export const POWER_HIGH = 0
export const POWER_LOW = 1

/**
 * `wide` is 1 for wide and 0 for narrow.
 *
 * Worth stating because it is the opposite sense to the UV-K5's `bandwidth`
 * bit, where 1 means narrow. Two radios in the same codebase, two conventions.
 */
export const BANDWIDTH_WIDE_HZ = 25_000
export const BANDWIDTH_NARROW_HZ = 12_500

/** Tone words below this are DTCS indices; at or above, CTCSS in deci-hertz. */
export const TONE_CTCSS_FLOOR = 0x0258
/** DTCS indices at or above this are the inverted (R) polarity set. */
export const TONE_DTCS_INVERTED = 0x6a

/**
 * This family's DTCS list is the standard 104 codes **plus 645**, sorted.
 *
 * The extra entry shifts every index above it, so using the standard table
 * would silently mis-decode a large part of the range.
 */
export const UV82_DTCS: readonly number[] = [...DTCS_CODES, 645].sort((a, b) => a - b)

/** From `STEPS` in uv5r.py, in hertz. */
export const TUNING_STEPS_HZ = [2_500, 5_000, 6_250, 10_000, 12_500, 20_000, 25_000, 50_000] as const

/** From `BASETYPE_UV82`: firmware prefixes that identify a plain UV-82. */
export const BASETYPE_UV82: readonly string[] = ['US2S2', 'B82S', 'BF82', 'N82-2', 'N822']
/** The tri-power variants, which have a different power table. */
export const BASETYPE_UV82HP: readonly string[] = ['N82-3', 'N823', 'N5R2']

/*
 * The rest of `BASETYPE_*` from uv5r.py, kept here because more than one
 * member of the family needs them and a second copy of a safety table is a
 * table that can drift. `BASETYPE_UV5R` is the plain UV-5R's list and also
 * the UV-5G's, because CHIRP's `RadioddityUV5GRadio` sets `_basetype` to it.
 *
 * These are matched by containment rather than by prefix, which is CHIRP's own
 * test (`any(type in rid ...)` in `model_match`). The UV-5G bench unit is why:
 * it reports `HN5RV011`, which contains `N5RV` but starts with none of them.
 */

/**
 * What a firmware string turned out to mean, or why it could not be settled.
 *
 * A bare `null` used to be the whole answer, and the driver turned every one
 * of them into the same sentence: "not one this build recognizes". That is
 * true of a string matching no family at all, and false of the case that
 * actually reaches people - the UV-5R's `N5RV`, which this build recognises
 * perfectly well and which names both a 4 W UV-5R and an 8 W BF-F8HP. Sending
 * someone to look for a missing table entry when the real answer is "your
 * radio is one of two radios" costs them the afternoon.
 *
 * Only the classifier knows which of its refusals happened, so the refusal
 * carries the reason. It is a cause clause and nothing more: the driver
 * appends what follows from it, so every radio says the same thing about what
 * is still possible.
 */
export type Basetype =
  | { readonly model: string; readonly triPower: boolean }
  | { readonly model: null; readonly reason: string }

/** `BASETYPE_UV5R`: the firmware families of the plain UV-5R. */
export const BASETYPE_UV5R: readonly string[] = ['BFS', 'BFB', 'N5R-2', 'N5R2', 'N5RV', 'BTS', 'D5R2', 'B5R2']
/** `BASETYPE_F8HP`: the tri-power BF-F8HP, which answers the UV-5R's magic. */
export const BASETYPE_F8HP: readonly string[] = ['BFP3V3 F', 'N5R-3', 'N5R3', 'F5R3', 'BFT', 'N5RV']
/** `BASETYPE_KT980HP`: the Intek KT-980HP, tri-power, same magic again. */
export const BASETYPE_KT980HP: readonly string[] = ['BFP3V3 B']

export const VHF_RANGE: readonly [number, number] = [130_000_000, 176_000_000]
export const UHF_RANGE: readonly [number, number] = [400_000_000, 521_000_000]

// ---------------------------------------------------------------- addresses --

export const channelAddr = (i: number) => CHANNEL_BASE + i * UV82_CHANNEL.size
export const nameAddr = (i: number) => NAME_BASE + i * NAME_SIZE

/**
 * One region covering the whole image.
 *
 * Unlike the UV-K5 there is no separate calibration area to protect: the ident
 * prefix is not radio memory at all, and the aux block is part of the same
 * logical image.
 */
export const REGIONS = [{ start: 0x0000, length: IMAGE_SIZE, label: 'image', readOnly: false }] as const

/** Byte ranges this driver understands well enough to rewrite. */
export function ownedRanges(): (readonly [number, number])[] {
  return [
    [CHANNEL_BASE, CHANNEL_BASE + CHANNEL_COUNT * UV82_CHANNEL.size],
    [SETTINGS_BASE, SETTINGS_BASE + SETTINGS_CLAIM],
    [NAME_BASE, NAME_BASE + CHANNEL_COUNT * NAME_SIZE],
  ]
}

/** The ident bytes are metadata, not memory, and are never written back. */
export const IDENT_RANGE: readonly [number, number] = [0, IDENT_SIZE]
