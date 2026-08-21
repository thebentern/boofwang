// SPDX-License-Identifier: GPL-3.0-or-later
import { ascii, chirpBits, scaled, u8, u32le } from '../../codec/fields.js'
import { at, defineStruct } from '../../codec/struct.js'
import { MEM_SIZE, PROG_SIZE } from './protocol.js'

/**
 * UV-K5 EEPROM layout.
 *
 * Offsets and bit orders transcribed from `MEM_FORMAT` in CHIRP's
 * `chirp/drivers/uvk5.py` (GPL-3.0). CHIRP's `bitwise` declarations are
 * MSB-first, so `chirpBits` takes them in the same order they are written
 * there - the transcription is a copy rather than a re-derivation, which is
 * where this kind of port usually goes wrong.
 *
 * Placeholder names (`flags1_unknown7`) are kept rather than dropped: a named
 * reserved slice is covered by `coverage()` and protected by the masking
 * setter, so it round-trips instead of being zeroed.
 */

/** One past the last programmable byte; everything above is calibration. */
export const PROG_END = PROG_SIZE

export const CHANNEL_BASE = 0x0000
/** 200 real channels plus 14 VFO pseudo-channels. */
export const CHANNEL_COUNT = 214
export const NAMED_CHANNEL_COUNT = 200
export const ATTR_BASE = 0x0d60
export const NAME_BASE = 0x0f50
export const NAME_SIZE = 16

/** Frequencies are stored in units of 10 Hz (`mem.freq = int(_mem.freq)*10`). */
const FREQ_SENTINELS = [0x00000000, 0xffffffff]
const freq10 = scaled(u32le, 10, FREQ_SENTINELS)

export const EMPTY_FREQ = 0xffffffff

export const UVK5_CHANNEL = defineStruct(16, {
  freq: at(0x00, freq10),
  offset: at(0x04, freq10),
  rxCode: at(0x08, u8),
  txCode: at(0x09, u8),
  codeFlags: at(
    0x0a,
    chirpBits(1, [
      ['txCodeFlag', 4],
      ['rxCodeFlag', 4],
    ]),
  ),
  flags1: at(
    0x0b,
    chirpBits(1, [
      ['unknown7', 1],
      ['unknown6', 1],
      ['unknown5', 1],
      ['enableAm', 1],
      ['unknown3', 1],
      ['isInScanlist', 1],
      ['shift', 2],
    ]),
  ),
  flags2: at(
    0x0c,
    chirpBits(1, [
      ['unknown7', 1],
      ['unknown6', 1],
      ['unknown5', 1],
      ['bclo', 1],
      ['txPower', 2],
      ['bandwidth', 1],
      ['freqReverse', 1],
    ]),
  ),
  dtmfFlags: at(
    0x0d,
    chirpBits(1, [
      ['unknown7', 1],
      ['unknown6', 1],
      ['unknown5', 1],
      ['unknown4', 1],
      ['unknown3', 1],
      ['dtmfPttId', 2],
      ['dtmfDecode', 1],
    ]),
  ),
  step: at(0x0e, u8),
  scrambler: at(0x0f, u8),
})

export const UVK5_ATTRIBUTES = defineStruct(1, {
  attr: at(
    0x00,
    chirpBits(1, [
      ['isScanlist1', 1],
      ['isScanlist2', 1],
      ['compander', 2],
      ['isFree', 1],
      ['band', 3],
    ]),
  ),
})

/**
 * Channel name, 16 bytes.
 *
 * Padded with NUL on write, which is what the radio itself does - a factory
 * `CH001` is five characters followed by eleven `0x00`. (CHIRP writes
 * `name.ljust(10)` plus six NULs, which reads back identically.) An erased slot
 * is 0xFF filled, so 0xFF terminates on read too.
 *
 * The usable length is 10 even though the field is 16, matching CHIRP's
 * `valid_name_length`.
 */
export const UVK5_NAME = defineStruct(NAME_SIZE, {
  name: at(0x00, ascii(NAME_SIZE, { pad: 0x00, terminators: [0x00, 0xff] })),
})

// ------------------------------------------------------------ field values --

/** `flags1.shift`. */
export const SHIFT_NONE = 0b00
export const SHIFT_PLUS = 0b01
export const SHIFT_MINUS = 0b10

/** `flags2.txPower`. */
export const POWER_LOW = 0b00
export const POWER_MEDIUM = 0b01
export const POWER_HIGH = 0b10

/**
 * `codeFlags.txCodeFlag` / `rxCodeFlag`, indexing CHIRP's `TMODES`.
 * Index 3 is DTCS with the code inverted.
 */
export const TONE_NONE = 0
export const TONE_CTCSS = 1
export const TONE_DTCS_N = 2
export const TONE_DTCS_R = 3

/** `_steps` in uvk5.py, in hertz rather than kHz floats. */
export const TUNING_STEPS_HZ = [2_500, 5_000, 6_250, 10_000, 12_500, 25_000] as const

/** `bandwidth` is 1 for narrow, 0 for wide. */
export const BANDWIDTH_WIDE_HZ = 25_000
export const BANDWIDTH_NARROW_HZ = 12_500

/**
 * The seven sub-bands the attribute byte's `band` nibble encodes, in hertz.
 * From `BANDS` in uvk5.py. `BANDS_NOLIMITS` widens the first and last for
 * modified firmware, but the stored nibble means the same thing either way.
 */
export const BANDS_HZ: readonly (readonly [number, number])[] = [
  [50_000_000, 76_000_000],
  [108_000_000, 136_999_900],
  [137_000_000, 173_999_900],
  [174_000_000, 349_999_900],
  [350_000_000, 399_999_900],
  [400_000_000, 469_999_900],
  [470_000_000, 600_000_000],
]

/** The band nibble for a frequency, or 0 when it falls outside every band. */
export function bandForFreq(hz: number): number {
  for (let i = 0; i < BANDS_HZ.length; i++) {
    const [lo, hi] = BANDS_HZ[i]!
    if (hz >= lo && hz <= hi) return i
  }
  return 0
}

/** From `SPECIALS` in uvk5.py: the 14 VFO pseudo-channels, 0-based 200..213. */
export const VFO_CHANNEL_NAMES: readonly string[] = [
  'F1(50M-76M)A', 'F1(50M-76M)B',
  'F2(108M-136M)A', 'F2(108M-136M)B',
  'F3(136M-174M)A', 'F3(136M-174M)B',
  'F4(174M-350M)A', 'F4(174M-350M)B',
  'F5(350M-400M)A', 'F5(350M-400M)B',
  'F6(400M-470M)A', 'F6(400M-470M)B',
  'F7(470M-600M)A', 'F7(470M-600M)B',
]

// ---------------------------------------------------------------- addresses --

export const channelAddr = (i: number) => CHANNEL_BASE + i * UVK5_CHANNEL.size
export const attrAddr = (i: number) => ATTR_BASE + i
export const nameAddr = (i: number) => NAME_BASE + i * NAME_SIZE

export interface RegionSpec {
  readonly start: number
  readonly length: number
  readonly label: string
  readonly readOnly: boolean
}

/**
 * The two memory regions, split wherever this firmware puts the calibration
 * boundary.
 *
 * Calibration is a separate, read-only region rather than a range some code
 * path has to remember to skip. `writeImage` filters on the flag, so excluding
 * it is structural.
 *
 * Where the boundary falls is a property of the firmware, not of the radio:
 * stock keeps calibration from 0x1D00, egzumer from 0x1E00, which gives it
 * another 256 bytes of programmable space. Taking it from the variant rather
 * than from a constant is what stops those 256 bytes being classed read-only on
 * a radio that programs them.
 */
export function regionsFor(calStart: number): readonly [RegionSpec, RegionSpec] {
  if (!Number.isInteger(calStart) || calStart <= 0 || calStart >= MEM_SIZE) {
    throw new RangeError(`UV-K5 calibration boundary 0x${calStart.toString(16)} is not inside the EEPROM`)
  }
  return [
    { start: 0x0000, length: calStart, label: 'programmable', readOnly: false },
    { start: calStart, length: MEM_SIZE - calStart, label: 'calibration', readOnly: true },
  ]
}

/** The stock firmware's split, which is also what a bare `.bin` is assumed to be. */
export const REGIONS = regionsFor(PROG_SIZE)

/**
 * Byte ranges of the programmable region this driver claims to understand.
 *
 * Anything outside these is read, stored and written back verbatim, and a diff
 * that lands outside them means the encoder has a bug.
 */
// ------------------------------------------------------------- stock settings --

/**
 * The stock firmware's settings, which live in seven small blocks rather than
 * one.
 *
 * Transcribed from `MEM_FORMAT` in CHIRP's `uvk5.py`. Egzumer gathers all of
 * this into one contiguous window, which is why that layout has a single
 * struct and this one has seven - the addresses are not a rearrangement of
 * each other and neither can be derived from the other.
 *
 * The eight password bytes at 0xE98 are deliberately not modelled. They round
 * trip because nothing names them, which is the behaviour wanted for a secret:
 * boofwang neither shows it nor rewrites it.
 */
export const SETTINGS_MAIN_BASE = 0x0e70
export const SETTINGS_KEYS_BASE = 0x0e90
export const SETTINGS_TONE_BASE = 0x0ea0
export const SETTINGS_ALARM_BASE = 0x0ea8
export const LOGO_BASE = 0x0eb0
export const SCANLIST_BASE = 0x0f18
export const LOCK_BASE = 0x0f40

export const UVK5_SETTINGS_MAIN = defineStruct(16, {
  callChannel: at(0x00, u8),
  squelch: at(0x01, u8),
  maxTalkTime: at(0x02, u8),
  noaaAutoscan: at(0x03, u8),
  keyLock: at(0x04, u8),
  voxSwitch: at(0x05, u8),
  voxLevel: at(0x06, u8),
  micGain: at(0x07, u8),
  unknown3: at(0x08, u8),
  channelDisplayMode: at(0x09, u8),
  crossband: at(0x0a, u8),
  batterySave: at(0x0b, u8),
  dualWatch: at(0x0c, u8),
  backlightAutoMode: at(0x0d, u8),
  tailNoteElimination: at(0x0e, u8),
  vfoOpen: at(0x0f, u8),
})

/** Stops at 8 bytes: `password[8]` follows and is left alone on purpose. */
export const UVK5_SETTINGS_KEYS = defineStruct(8, {
  beepControl: at(0x00, u8),
  key1ShortpressAction: at(0x01, u8),
  key1LongpressAction: at(0x02, u8),
  key2ShortpressAction: at(0x03, u8),
  key2LongpressAction: at(0x04, u8),
  scanResumeMode: at(0x05, u8),
  autoKeypadLock: at(0x06, u8),
  powerOnDispMode: at(0x07, u8),
})

export const UVK5_SETTINGS_TONE = defineStruct(2, {
  keypadTone: at(0x00, u8),
  language: at(0x01, u8),
})

export const UVK5_SETTINGS_ALARM = defineStruct(3, {
  alarmMode: at(0x00, u8),
  remindingOfEndTalk: at(0x01, u8),
  repeaterTailElimination: at(0x02, u8),
})

/** The two lines shown while the radio powers up. */
export const UVK5_LOGO = defineStruct(32, {
  logoLine1: at(0x00, ascii(16, { pad: 0xff, terminators: [0x00, 0xff] })),
  logoLine2: at(0x10, ascii(16, { pad: 0xff, terminators: [0x00, 0xff] })),
})

export const UVK5_SCANLIST = defineStruct(8, {
  scanlistDefault: at(0x00, u8),
  scanlist1PriorityScan: at(0x01, u8),
  scanlist1PriorityCh1: at(0x02, u8),
  scanlist1PriorityCh2: at(0x03, u8),
  scanlist2PriorityScan: at(0x04, u8),
  scanlist2PriorityCh1: at(0x05, u8),
  scanlist2PriorityCh2: at(0x06, u8),
  scanlistUnknown0xff: at(0x07, u8),
})

/**
 * The transmit locks, and `killed`.
 *
 * `killed` is the DTMF remote-kill flag. It is decoded so it round-trips and so
 * a person can see it, and it is not offered as a control: the only thing
 * setting it does is stop the radio working.
 */
export const UVK5_LOCK = defineStruct(7, {
  flock: at(0x00, u8),
  tx350: at(0x01, u8),
  killed: at(0x02, u8),
  tx200: at(0x03, u8),
  tx500: at(0x04, u8),
  en350: at(0x05, u8),
  enscramble: at(0x06, u8),
})

/** Every stock settings block, with the base each sits at. */
export const STOCK_SETTINGS_BLOCKS = [
  { base: SETTINGS_MAIN_BASE, struct: UVK5_SETTINGS_MAIN },
  { base: SETTINGS_KEYS_BASE, struct: UVK5_SETTINGS_KEYS },
  { base: SETTINGS_TONE_BASE, struct: UVK5_SETTINGS_TONE },
  { base: SETTINGS_ALARM_BASE, struct: UVK5_SETTINGS_ALARM },
  { base: LOGO_BASE, struct: UVK5_LOGO },
  { base: SCANLIST_BASE, struct: UVK5_SCANLIST },
  { base: LOCK_BASE, struct: UVK5_LOCK },
] as const

export function ownedRangesProgrammable(): (readonly [number, number])[] {
  return [
    [CHANNEL_BASE, CHANNEL_BASE + CHANNEL_COUNT * UVK5_CHANNEL.size],
    [ATTR_BASE, ATTR_BASE + NAMED_CHANNEL_COUNT],
    ...STOCK_SETTINGS_BLOCKS.flatMap(({ base, struct }) =>
      struct.ranges().map(([s, e]) => [base + s, base + e] as const),
    ),
    [NAME_BASE, NAME_BASE + NAMED_CHANNEL_COUNT * NAME_SIZE],
  ]
}
