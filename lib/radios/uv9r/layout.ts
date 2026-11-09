// SPDX-License-Identifier: GPL-3.0-or-later
import type { Field } from '../../codec/fields.js'
import { at, defineStruct } from '../../codec/struct.js'
import { UV82_CHANNEL, UV82_DTCS, UV82_POWERON_MSG, UV82_SETTINGS, TUNING_STEPS_HZ as UV82_STEPS_HZ } from '../uv82/layout.js'
import { IDENT_OFFSET, IDENT_SIZE, IMAGE_SIZE } from './protocol.js'

/**
 * The WP970I family's memory layout.
 *
 * Transcribed from `MEM_FORMAT` on `WP970I` in CHIRP's `baofeng_wp970i.py`
 * (GPL-3.0), which every member of the family - the UV-9R and the UV-9G among
 * them - inherits unchanged.
 *
 * Every offset here is a radio address and an image offset at once. CHIRP
 * appends this family's ident to the end of the image rather than putting it
 * first, so nothing below 0x2000 is shifted. That is the opposite of the
 * UV-82's layout file, where every number is eight past the radio's own, and
 * it is the one thing to hold on to when comparing the two: the records are
 * identical and the addresses differ by exactly that eight.
 *
 * Identical, and checked rather than assumed. Laid side by side in radio
 * addresses, this `MEM_FORMAT` and uv5r.py's agree on every struct both
 * declare: channels at 0x0000, PTT ID codes at 0x0B00, the ANI code at 0x0CAA,
 * settings at 0x0E20, the VFOs at 0x0F00, names at 0x1000, the power-on and
 * firmware messages at 0x1ED0-0x1EFF, squelch tables at 0x1F60 and band
 * limits at 0x1FC0. So the struct definitions are the UV-82's, imported, and
 * only the addresses are this file's.
 */

export const CHANNEL_BASE = 0x0000
export const CHANNEL_COUNT = 128
export const NAME_BASE = 0x1000
export const NAME_SIZE = 16
/**
 * `LENGTH_NAME` on `UV9R` and `UV9G`. `WP970I` itself, the UV-82WP and the
 * RT6 keep six; the UV-9R's seven is CHIRP's, and CHIRP issue 9932 is a UV-9R
 * Pro owner finding the radio showed seven while CHIRP allowed six.
 */
export const NAME_LENGTH = 7

/** `#seekto 0x0E20` - the same 0x2E-byte struct as uv5r.py's at image 0x0E28. */
export const SETTINGS_BASE = 0x0e20
/**
 * The settings block rounded up to the sixteen-byte block the writer sends.
 *
 * 0x2E bytes of struct end at 0x0E4E, inside the block at 0x0E40. The two
 * bytes after it are carried through from the radio and never assigned, so
 * claiming them claims nothing the encoder then changes. 0x0E50 onwards -
 * `wmchannel` at 0x0E76 among it - is left alone.
 */
export const SETTINGS_CLAIM = 0x30
/** `#seekto 0x1EE0` - `poweron_msg`, two seven-character lines. */
export const POWERON_MSG_BASE = 0x1ee0

/**
 * The bytes that say which physical radio an image came from.
 *
 * CHIRP's own answer. Before an upload, `_get_aux_data_from_radio` reads
 * these three spans off the radio and compares them with the image, and
 * uploads its auxiliary range only when all three match - so they are the
 * bytes CHIRP treats as belonging to one unit. They are what the squelch
 * tables and band limits are not: `_ranges` writes 0x1F60, 0x1F80 and 0x1FC0,
 * and never these.
 *
 * What is in them is not documented. In every capture boofwang has they look
 * like per-frequency calibration curves, and they differ between two units
 * with the same date code, which is what a fingerprint needs. Two radios that
 * happened to calibrate identically would collide; that is the same weakness
 * the DM-32UV's calibration hash has.
 */
export const UNIT_AREAS: readonly (readonly [number, number])[] = [
  [0x1f00, 0x1f60],
  [0x1f70, 0x1f80],
  [0x1f90, 0x1fc0],
]

/**
 * The family's channel record, which is uv5r.py's byte for byte.
 *
 * Same sixteen bytes, same bit order, same `lowpower:2` - and same `wide` bit,
 * which reads 1 for wide here as there.
 */
export const WP970I_CHANNEL = UV82_CHANNEL

/** The settings block: the UV-82's struct, at this family's address. */
export const WP970I_SETTINGS = UV82_SETTINGS

export const WP970I_POWERON_MSG = UV82_POWERON_MSG

/**
 * A channel name, read the way `get_memory` in baofeng_common.py reads it.
 *
 * Seven characters, each 0xFF taken as a space - "The OEM software may have
 * 0xFF mid-name" - and the result stripped on the right. The UV-82's field
 * stops at the first 0xFF instead, which agrees with CHIRP on every name that
 * has no gap in it and disagrees on every name that has one; this file follows
 * the parser it was checked against.
 *
 * Written idempotently, like every text field in this codebase: if the bytes
 * already read as the name being written they are left exactly as they are,
 * so a name with a 0xFF in the middle survives a round trip. A new name goes
 * out as CHIRP's `set_memory` writes one - its characters, then 0xFF to the
 * seventh byte - and the nine bytes after it are never touched.
 */
/** The single-byte characters `str.isspace()` is true of. */
const PYTHON_WHITESPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0])

export function chirpName(n: number): Field<string> {
  return {
    size: n,
    get(buf, off) {
      let s = ''
      for (let i = 0; i < n; i++) {
        const b = buf[off + i]!
        s += b === 0xff ? ' ' : String.fromCharCode(b)
      }
      // `rstrip()` with no argument: every character Python counts as
      // whitespace, which in one byte is more than the space.
      let end = s.length
      while (end > 0 && PYTHON_WHITESPACE.has(s.charCodeAt(end - 1))) end--
      return s.slice(0, end)
    },
    set(buf, off, v) {
      if (this.get(buf, off) === v) return
      for (let i = 0; i < n; i++) {
        const c = i < v.length ? v.charCodeAt(i) : 0xff
        if (c > 0xff) throw new RangeError(`chirpName(${n}): code point U+${c.toString(16)} is not single-byte`)
        buf[off + i] = c
      }
    },
  }
}

export const WP970I_NAME = defineStruct(NAME_SIZE, {
  name: at(0x00, chirpName(NAME_LENGTH)),
})

// ------------------------------------------------------------ field values --

/**
 * `lowpower` indexes `POWER_LEVELS`: 0 High, 1 Med, 2 Low.
 *
 * Three levels on the UV-9R and the UV-9G, where the UV-5R family has two. A
 * value of 3 is not in the table. `get_memory` means to read it as High, and
 * cannot: its `except IndexError` handler formats `_mem.power`, which this
 * struct does not have, so the handler raises and CHIRP cannot read the
 * channel at all. This comment said CHIRP fell back to High until the fixture
 * generator asked it. The decoder here does what CHIRP meant - High - and the
 * encoder leaves such a byte exactly as it found it unless the power is
 * actually changed.
 */
export const POWER_RAW = { high: 0, med: 1, low: 2 } as const

export const BANDWIDTH_WIDE_HZ = 25_000
export const BANDWIDTH_NARROW_HZ = 12_500

/** `DTCS_CODES` on `WP970I`: the standard 104 plus 645, sorted, as in uv5r.py. */
export const WP970I_DTCS: readonly number[] = UV82_DTCS

/** `STEPS` in baofeng_wp970i.py - the same eight steps as uv5r.py's. */
export const TUNING_STEPS_HZ = UV82_STEPS_HZ

/**
 * `_vhf_range` and `_uhf_range` on `WP970I`, which `VALID_BANDS` is built from.
 *
 * Not the band plan a schema shows - the UV-9G's lists its GMRS windows first
 * - but the pair CHIRP's `is_split` is asked about. Whether a channel's
 * transmit frequency is a shift or a split is decided against these, the way
 * `get_memory` decides it, so that a GMRS repeater channel 5 MHz up reads as
 * a shift on both radios rather than as a split between two display bands.
 */
export const VALID_BANDS: readonly (readonly [number, number])[] = [
  [130_000_000, 180_000_000],
  [400_000_000, 521_000_000],
]

// ---------------------------------------------------------------- addresses --

export const channelAddr = (i: number) => CHANNEL_BASE + i * WP970I_CHANNEL.size
export const nameAddr = (i: number) => NAME_BASE + i * NAME_SIZE

/**
 * One region: the memory, then the eight ident bytes CHIRP appends to it.
 *
 * The ident is not radio memory and is never written - it falls outside every
 * owned range - but it travels with the image so that a CHIRP `.img` made from
 * it is the 0x2008 bytes CHIRP itself would have saved.
 */
export const REGIONS = [{ start: 0x0000, length: IMAGE_SIZE, label: 'image', readOnly: false }] as const

export const IDENT_RANGE: readonly [number, number] = [IDENT_OFFSET, IDENT_OFFSET + IDENT_SIZE]

/** Byte ranges this driver understands well enough to rewrite. */
export function ownedRanges(): (readonly [number, number])[] {
  return [
    [CHANNEL_BASE, CHANNEL_BASE + CHANNEL_COUNT * WP970I_CHANNEL.size],
    [SETTINGS_BASE, SETTINGS_BASE + SETTINGS_CLAIM],
    [NAME_BASE, NAME_BASE + CHANNEL_COUNT * NAME_SIZE],
  ]
}
