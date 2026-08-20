// SPDX-License-Identifier: GPL-3.0-or-later
import { bytes, chirpBits, lbcdFreq, u8, u16le } from '../../codec/fields.js'
import { at, defineStruct } from '../../codec/struct.js'
import { ctcss, dtcs, type ToneSpec } from '../../model/tones.js'

/**
 * Channel records, transcribed from CHIRP's `struct memory_obj`
 * (`baofeng_uv17Pro.py`, GPL-3.0).
 *
 * 32 bytes each, a thousand of them from 0x0000. The two bitfield bytes are
 * declared most-significant-bit first, which is how CHIRP's bitwise DSL reads
 * them, so they are transcribed in that order rather than reversed.
 */
export const CHANNEL_SIZE = 32
export const CHANNEL_BASE = 0x0000
export const CHANNEL_COUNT = 1000
export const NAME_LENGTH = 12

export const UV5RM_CHANNEL = defineStruct(CHANNEL_SIZE, {
  rxFreq: at(0x00, lbcdFreq(4)),
  txFreq: at(0x04, lbcdFreq(4)),
  rxTone: at(0x08, u16le),
  txTone: at(0x0a, u16le),
  scode: at(0x0c, u8),
  pttid: at(0x0d, u8),
  power: at(
    0x0e,
    chirpBits(1, [
      ['unknown7', 2],
      ['scramble', 2],
      ['unknown8', 2],
      ['lowpower', 2],
    ]),
  ),
  flags: at(
    0x0f,
    chirpBits(1, [
      ['unknown1', 1],
      ['wide', 1],
      ['sqmode', 2],
      ['bcl', 1],
      ['scan', 1],
      ['unknown2', 1],
      ['fhss', 1],
    ]),
  ),
  nameBytes: at(0x14, bytes(NAME_LENGTH)),
})

/**
 * The DTCS codes this family uses: CHIRP's standard table **plus 645**.
 *
 * `DTCS_CODES = tuple(sorted(chirp_common.DTCS_CODES + (645,)))`. One extra
 * code, inserted in sorted order at index 93, which shifts every code above it
 * by one. Using the ordinary 104-entry table would decode D654 as D645 and
 * every higher code one place out - a channel that looks right and will not
 * open squelch.
 */
export const UV17PRO_DTCS_CODES: readonly number[] = [
   23,  25,  26,  31,  32,  36,  43,  47,  51,  53,
   54,  65,  71,  72,  73,  74, 114, 115, 116, 122,
  125, 131, 132, 134, 143, 145, 152, 155, 156, 162,
  165, 172, 174, 205, 212, 223, 225, 226, 243, 244,
  245, 246, 251, 252, 255, 261, 263, 265, 266, 271,
  274, 306, 311, 315, 325, 331, 332, 343, 346, 351,
  356, 364, 365, 371, 411, 412, 413, 423, 431, 432,
  445, 446, 452, 454, 455, 462, 464, 465, 466, 503,
  506, 516, 523, 526, 532, 546, 565, 606, 612, 624,
  627, 631, 632, 645, 654, 662, 664, 703, 712, 723,
  731, 732, 734, 743, 754,
]


/**
 * Decode a channel name the way CHIRP does.
 *
 * `mem.name = str(name).replace('\xFF', ' ').replace('\x00', ' ').rstrip()`.
 * Both fill bytes become spaces rather than ending the string, so a name that
 * happens to contain one keeps everything after it. Treating them as
 * terminators - the usual convention, and what the shared `ascii` field does -
 * would silently truncate such a name.
 */
export function decodeName(raw: Uint8Array): string {
  let s = ''
  for (const b of raw) s += b === 0xff || b === 0x00 ? ' ' : String.fromCharCode(b)
  return s.replace(/ +$/, '')
}

/** The inverse: pad to width with 0xFF, which is what the radio writes. */
export function encodeName(name: string, width = NAME_LENGTH): Uint8Array {
  const out = new Uint8Array(width).fill(0xff)
  for (let i = 0; i < Math.min(name.length, width); i++) out[i] = name.charCodeAt(i) & 0xff
  return out
}

/** The boundary CHIRP uses between a DTCS index and a CTCSS frequency. */
const TONE_SPLIT = 0x0258 // 600, i.e. 60.0 Hz
const DTCS_REVERSE_BASE = 0x6a // 106

/**
 * Decode one 16-bit tone word.
 *
 * Below 600 the value is an index into the DTCS table - 1-based for normal
 * polarity, and offset by 106 for reversed. At or above 600 it is a CTCSS
 * frequency already in tenths of a hertz, so it needs no conversion. Zero and
 * 0xFFFF both mean no tone.
 */
export function decodeToneWord(word: number): ToneSpec | null {
  if (word === 0 || word === 0xffff) return null

  if (word >= TONE_SPLIT) return ctcss(word)

  const reversed = word >= DTCS_REVERSE_BASE
  const index = reversed ? word - DTCS_REVERSE_BASE : word - 1
  const code = UV17PRO_DTCS_CODES[index]
  // An index outside the table is not a tone this build understands. Reporting
  // no tone beats inventing one: a wrong DCS code keeps squelch shut.
  if (code === undefined) return null
  return dtcs(code, reversed ? 'R' : 'N')
}

/**
 * The inverse, kept beside the decoder so the two cannot drift apart.
 *
 * "No tone" is written as zero, which is what the radio writes. Blank memory
 * reads 0xFFFF and decodes to no tone as well, so both spellings are accepted
 * on the way in - but only one is ever produced.
 */
export function encodeToneWord(tone: ToneSpec | null): number {
  if (!tone) return 0
  if (tone.kind === 'ctcss') return tone.deciHz
  const index = UV17PRO_DTCS_CODES.indexOf(tone.code)
  if (index < 0) return 0xffff
  return tone.polarity === 'R' ? index + DTCS_REVERSE_BASE : index + 1
}

/**
 * Whether a channel record is unused.
 *
 * CHIRP tests the very first byte for 0xFF, and nothing else.
 */
export function isChannelEmpty(record: Uint8Array): boolean {
  return record[0] === 0xff
}

/**
 * Whether transmit is disabled on this channel.
 *
 * The transmit frequency is filled with 0xFF or 0x00 rather than a flag being
 * set. This is the radio's only way of saying "receive only", so it is what
 * `txAllowed` has to be built from.
 */
export function isTxInhibited(record: Uint8Array): boolean {
  const tx = record.subarray(0x04, 0x08)
  return tx.every((b) => b === 0xff) || tx.every((b) => b === 0x00)
}

/**
 * Where the rest of the image lives.
 *
 * CHIRP's `#seekto` values are offsets into the downloaded image, not radio
 * addresses, which is what makes them land where they do: the image is the
 * three regions concatenated, so image 0x8040 is the start of the 64-byte
 * region the radio serves from 0x9000.
 */
export const VFO_A_BASE = 0x8000
export const VFO_B_BASE = 0x8020
export const SETTINGS_BASE = 0x8040
export const ANI_BASE = 0x8080
export const PTTID_BASE = 0x80a0

/**
 * Radio-wide settings, transcribed from `settings_obj` in
 * `baofeng_uv17Pro.py`.
 *
 * Only the fields whose meaning is unambiguous are named. The rest of the
 * 64-byte block keeps whatever the radio had - the same rule the channel
 * records follow, and the reason a read/edit/write cycle stays byte-exact.
 */
export const UV5RM_SETTINGS = defineStruct(0x40, {
  squelch: at(0x00, u8),
  saveMode: at(0x01, u8),
  vox: at(0x02, u8),
  backlight: at(0x03, u8),
  dualStandby: at(0x04, u8),
  timeout: at(0x05, u8),
  beep: at(0x06, u8),
  voiceSwitch: at(0x07, u8),
  voice: at(0x08, u8),
  sideTone: at(0x09, u8),
  scanMode: at(0x0a, u8),
  pttId: at(0x0b, u8),
  pttDelay: at(0x0c, u8),
  chADisplayType: at(0x0d, u8),
  chBDisplayType: at(0x0e, u8),
  busyChannelLockout: at(0x0f, u8),
  autoLock: at(0x10, u8),
  alarmMode: at(0x11, u8),
  alarmTone: at(0x12, u8),
  tailClear: at(0x14, u8),
  repeaterTailClear: at(0x15, u8),
  repeaterTailDetect: at(0x16, u8),
  roger: at(0x17, u8),
  activeVfo: at(0x18, u8),
  fmRadio: at(0x19, u8),
  keyLock: at(0x1b, u8),
  powerOnDisplayType: at(0x1c, u8),
  tone: at(0x1d, u8),
  voxDelay: at(0x20, u8),
  menuQuitTime: at(0x21, u8),
  bluetooth: at(0x22, u8),
  displayAni: at(0x24, u8),
})

