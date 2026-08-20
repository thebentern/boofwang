// SPDX-License-Identifier: GPL-3.0-or-later
import { ascii, chirpBits, lbcdFreq, u16le } from '../../codec/fields.js'
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
export const VFO_A_BASE = 0x0f10
export const VFO_B_BASE = 0x0f30

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
    [NAME_BASE, NAME_BASE + CHANNEL_COUNT * NAME_SIZE],
  ]
}

/** The ident bytes are metadata, not memory, and are never written back. */
export const IDENT_RANGE: readonly [number, number] = [0, IDENT_SIZE]
