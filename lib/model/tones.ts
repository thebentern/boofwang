// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * CTCSS and DTCS, normalised.
 *
 * CHIRP spreads this across seven CSV fields - `Tone`, `rToneFreq`,
 * `cToneFreq`, `DtcsCode`, `RxDtcsCode`, `DtcsPolarity`, `CrossMode` - whose
 * meanings shift depending on the value of the first. That is a faithful record
 * of how radios evolved, but it makes every consumer re-derive the same logic.
 *
 * Here it collapses to the question actually being asked: what does the radio
 * require to open squelch, and what does it send while transmitting?
 */

/** CTCSS in tenths of a hertz: 885 is 88.5 Hz. */
export type ToneSpec =
  | { readonly kind: 'ctcss'; readonly deciHz: number }
  | { readonly kind: 'dtcs'; readonly code: number; readonly polarity: 'N' | 'R' }

export interface TonePair {
  /** What must be present to open squelch. */
  readonly rx: ToneSpec | null
  /** What is sent while transmitting. */
  readonly tx: ToneSpec | null
  /**
   * CHIRP's `TSQL-R` / `DTCS-R`: squelch opens when the tone is *absent*.
   *
   * Lives on the pair rather than inside `ToneSpec` because CHIRP only ever
   * expresses it for the receive side as a whole, and because it must not be
   * confused with DTCS `polarity`, which inverts the code itself.
   */
  readonly rxInverted: boolean
}

export const NO_TONE: TonePair = { rx: null, tx: null, rxInverted: false }

export const ctcss = (deciHz: number): ToneSpec => ({ kind: 'ctcss', deciHz })
export const dtcs = (code: number, polarity: 'N' | 'R' = 'N'): ToneSpec => ({ kind: 'dtcs', code, polarity })

/**
 * The 50 standard CTCSS tones, in tenths of a hertz.
 * Transcribed from `chirp_common.TONES` (GPL-3.0).
 */
export const CTCSS_DECIHZ: readonly number[] = [
  670, 693, 719, 744, 770, 797, 825, 854, 885, 915,
  948, 974, 1000, 1035, 1072, 1109, 1148, 1188, 1230, 1273,
  1318, 1365, 1413, 1462, 1514, 1567, 1598, 1622, 1655, 1679,
  1713, 1738, 1773, 1799, 1835, 1862, 1899, 1928, 1966, 1995,
  2035, 2065, 2107, 2181, 2257, 2291, 2336, 2418, 2503, 2541,
]

/**
 * The 104 standard DTCS codes.
 * Transcribed from `chirp_common.DTCS_CODES` (GPL-3.0).
 */
export const DTCS_CODES: readonly number[] = [
  23, 25, 26, 31, 32, 36, 43, 47, 51, 53,
  54, 65, 71, 72, 73, 74, 114, 115, 116, 122,
  125, 131, 132, 134, 143, 145, 152, 155, 156, 162,
  165, 172, 174, 205, 212, 223, 225, 226, 243, 244,
  245, 246, 251, 252, 255, 261, 263, 265, 266, 271,
  274, 306, 311, 315, 325, 331, 332, 343, 346, 351,
  356, 364, 365, 371, 411, 412, 413, 423, 431, 432,
  445, 446, 452, 454, 455, 462, 464, 465, 466, 503,
  506, 516, 523, 526, 532, 546, 565, 606, 612, 624,
  627, 631, 632, 654, 662, 664, 703, 712, 723, 731,
  732, 734, 743, 754,
]

/** CTCSS formatted the way CHIRP writes it: one decimal place. */
export function formatCtcss(deciHz: number): string {
  return (deciHz / 10).toFixed(1)
}

export function parseCtcss(text: string): number {
  const n = Number(text.trim())
  if (!Number.isFinite(n)) throw new RangeError(`Cannot parse CTCSS tone: ${JSON.stringify(text)}`)
  return Math.round(n * 10)
}

/** DTCS formatted the way CHIRP writes it: zero-padded to three digits. */
export function formatDtcs(code: number): string {
  return String(code).padStart(3, '0')
}

export function toneEquals(a: ToneSpec | null, b: ToneSpec | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'ctcss' && b.kind === 'ctcss') return a.deciHz === b.deciHz
  if (a.kind === 'dtcs' && b.kind === 'dtcs') return a.code === b.code && a.polarity === b.polarity
  return false
}

export function tonePairEquals(a: TonePair, b: TonePair): boolean {
  return toneEquals(a.rx, b.rx) && toneEquals(a.tx, b.tx) && a.rxInverted === b.rxInverted
}

/** Nearest supported CTCSS tone, for clamping to a radio's list. */
export function nearestCtcss(deciHz: number, supported: readonly number[] = CTCSS_DECIHZ): number {
  let best = supported[0]!
  let bestDelta = Math.abs(best - deciHz)
  for (const t of supported) {
    const d = Math.abs(t - deciHz)
    if (d < bestDelta) {
      best = t
      bestDelta = d
    }
  }
  return best
}

export function describeTone(t: ToneSpec | null): string {
  if (t === null) return '—'
  return t.kind === 'ctcss' ? `${formatCtcss(t.deciHz)} Hz` : `D${formatDtcs(t.code)}${t.polarity}`
}
