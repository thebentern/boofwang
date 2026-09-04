// SPDX-License-Identifier: GPL-3.0-or-later
import { BASETYPE_UV5R } from '../uv82/layout.js'

/**
 * The Radioddity UV-5G, a GMRS radio in the classic UV-5R family.
 *
 * Four different radios are sold under some spelling of "UV-5G", split across
 * two protocols that share nothing: the UV-5G Plus and UV-5G Mini are UV-17
 * Pro family radios (115200 baud, obfuscated blocks), while this one and the
 * UV-5G Pro speak the classic UV-5R protocol. The name alone cannot tell them
 * apart; the ident magic below can, and it is what settled which radio was on
 * the bench.
 *
 * Everything on the wire - 9600 baud, the byte-at-a-time magic, 'S'/'X' block
 * commands, the firmware probe, the dropped-byte quirk - is the uv82 module's
 * protocol, shared because CHIRP's `RadioddityUV5GRadio` (uv5r.py, GPL-3.0) is
 * a bare subclass of `BaofengUV5R`. Only the magic and the accepted firmware
 * strings differ, so this file holds those and nothing else.
 */

/** `UV5R_MODEL_UV5G` in uv5r.py. No other CHIRP model shares this magic. */
export const MAGIC_UV5G = Uint8Array.from([0x50, 0xbb, 0xff, 0x20, 0x12, 0x06, 0x25])

/**
 * The basetype list CHIRP assigns this radio is the plain UV-5R's own, so it
 * lives with the family's other shared tables rather than being copied here.
 *
 * Kept under this name because that is what this module calls it, and because
 * the indirection is the point: if the table ever changes, both radios change
 * with it.
 */
export const BASETYPE_UV5G: readonly string[] = BASETYPE_UV5R

/**
 * Sort a firmware version string into a recognised model, or null.
 *
 * Never tri-power: no tri-power radio answers this magic, and the strings that
 * would mean tri-power behind other magics (`N5RV` is also `BASETYPE_F8HP`,
 * `N5R2` also `BASETYPE_UV82HP`) mean plain two-level firmware behind this
 * one. The magic has already narrowed the field before this string is read.
 *
 * `BFB` firmware below 291 is refused outright. CHIRP calls those radios
 * "original" and gives them different auxiliary-area handling on upload; no
 * UV-5G has ever been seen with one, so rather than carrying untestable code
 * for it, such a radio is offered read-only.
 */
export function classifyBasetype(version: string): { model: string; triPower: boolean } | null {
  if (!BASETYPE_UV5G.some((p) => version.includes(p))) return null
  if (version.includes('BFB')) {
    // Fail closed: a BFB string whose number cannot be read is refused along
    // with the pre-291 ones, not waved through. CHIRP would raise on it.
    const bfb = /BFB(\d{3})/.exec(version)
    if (!bfb || Number(bfb[1]) < 291) return null
  }
  return { model: 'UV-5G', triPower: false }
}
