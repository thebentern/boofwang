// SPDX-License-Identifier: GPL-3.0-or-later
import { BASETYPE_F8HP, BASETYPE_KT980HP, BASETYPE_UV5R, type Basetype } from '../uv82/layout.js'

/**
 * The Baofeng UV-5R itself, the radio the whole classic family is named for.
 *
 * Nothing on the wire is this radio's own. 9600 baud, the byte-at-a-time
 * magic, the 'S'/'X' block commands, the firmware probe and the dropped-byte
 * quirk are all the uv82 module's, shared because CHIRP's `BaofengUV5R`
 * (uv5r.py, GPL-3.0) is the class the UV-82 and UV-5G drivers subclass rather
 * than the other way round. So this file holds the magics and the firmware
 * classifier, and nothing else.
 *
 * Not to be confused with the UV-5R **Mini**, which boofwang also supports and
 * which shares nothing with this radio: it is a UV-17 Pro family radio running
 * at 115200 baud with obfuscated 64-byte blocks. Same shelf at the same
 * retailer, two unrelated memory formats.
 */

/**
 * `UV5R_MODEL_291` in uv5r.py: what a UV-5R on BFB291 firmware or later
 * answers, which is every UV-5R sold since about 2013.
 *
 * One byte from the UV-5G's `\x50\xbb\xff\x20\x12\x06\x25` - the sixth is 0x07
 * here and 0x06 there. CHIRP takes that pair seriously enough to keep the
 * UV-5G's magic in an `IDENT_BLACKLIST` that its UV-5R driver probes for after
 * every real magic has failed, purely so it can tell the user they picked the
 * wrong model. boofwang does not probe: the connect screen already made the
 * user choose, and a wrong choice fails to identify rather than reading
 * garbage.
 */
export const MAGIC_UV5R_291 = Uint8Array.from([0x50, 0xbb, 0xff, 0x20, 0x12, 0x07, 0x25])

/**
 * `UV5R_MODEL_ORIG`: what the pre-BFB291 radios of 2012 answer.
 *
 * Carried so that an original UV-5R identifies and can be read and backed up.
 * It cannot be written by this build - `classifyBasetype` refuses BFB below
 * 291 - and a backup is exactly what a radio nobody can write needs. Without
 * this magic such a radio would not answer at all, which is a worse thing to
 * tell its owner than "read only".
 */
export const MAGIC_UV5R_ORIG = Uint8Array.from([0x50, 0xbb, 0xff, 0x01, 0x25, 0x98, 0x4d])

/** `_idents` in `BaofengUV5R`, in CHIRP's order: the current magic first. */
export const MAGICS_UV5R: readonly Uint8Array[] = [MAGIC_UV5R_291, MAGIC_UV5R_ORIG]

/**
 * Sort a firmware version string into a recognized model, or null.
 *
 * This is the one place where the UV-5R is harder than its siblings, and the
 * reason is the magic. For the UV-82 and the UV-5G the magic has already
 * settled how many power levels the radio has before this string is read. For
 * the UV-5R it has not: `UV5R_MODEL_291` is `_idents` for the two-power UV-5R,
 * the tri-power BF-F8HP **and** the tri-power Intek KT-980HP. The firmware
 * string is the only thing left to tell them apart.
 *
 * And it cannot always do it. `N5RV` is in `BASETYPE_UV5R` and in
 * `BASETYPE_F8HP` both, so a radio reporting it is either a 4 W UV-5R or an
 * 8 W BF-F8HP and nothing on the wire says which. That returns null. CHIRP has
 * the same ambiguity and resolves it by making the user pick the model from a
 * list; boofwang has no such list at this point in the conversation, so it
 * declines to guess. Guessing wrong in the two-power direction would write a
 * Low channel back at 8 W on a radio whose owner never touched it.
 *
 * Null means read-only, never a refusal to connect.
 */
export function classifyBasetype(version: string): Basetype {
  const matches = (list: readonly string[]) => list.some((p) => version.includes(p))

  const twoPower = matches(BASETYPE_UV5R)
  const f8hp = matches(BASETYPE_F8HP)
  const kt980 = matches(BASETYPE_KT980HP)

  // Ambiguous between two and three power levels: fail closed. The reason
  // names both radios, because "unrecognised" would be a lie about a string
  // this build reads perfectly well and would send its owner looking for a
  // missing table entry instead of at the label on their radio.
  if (twoPower && (f8hp || kt980)) {
    return {
      model: null,
      reason:
        `Firmware ${JSON.stringify(version)} names both the two-power UV-5R and the tri-power ` +
        `${f8hp ? 'BF-F8HP' : 'KT-980HP'}, and nothing on the wire says which one is on the cable. ` +
        'Writing to the wrong one would change the power on channels you did not touch.',
    }
  }

  if (f8hp) return { model: 'BF-F8HP', triPower: true }
  if (kt980) return { model: 'KT-980HP', triPower: true }
  if (!twoPower) {
    return {
      model: null,
      reason:
        `Firmware ${JSON.stringify(version)} carries no UV-5R firmware family this build knows, ` +
        'so its memory layout cannot be assumed.',
    }
  }

  if (version.includes('BFB')) {
    /*
     * BFB firmware below 291 is the "original" radio, and it is refused.
     *
     * CHIRP uploads a different set of auxiliary ranges to those radios and
     * checks that an image's era matches the radio's before it will write at
     * all. None of that has been exercised here against hardware, so rather
     * than carry an untested second write path this build reads them and
     * stops. A BFB string whose number cannot be read is refused with them,
     * not waved through - CHIRP raises on it too.
     */
    const bfb = /BFB(\d{3})/.exec(version)
    if (!bfb || Number(bfb[1]) < 291) {
      return {
        model: null,
        reason:
          `Firmware ${JSON.stringify(version)} is a pre-BFB291 radio, whose auxiliary memory this ` +
          'build has never written.',
      }
    }
  }

  return { model: 'UV-5R', triPower: false }
}
