// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Branded integer units.
 *
 * Mixing MHz floats with Hz integers is the defining bug class in this domain:
 * 146.52 is a frequency, 146520000 is a frequency, and 14652000 is a frequency
 * in the units one particular radio happens to store. Branding makes the
 * compiler object when they are confused, and every conversion goes through a
 * named function that says which direction it is going.
 */

declare const HzBrand: unique symbol
declare const MilliwattsBrand: unique symbol

export type Hz = number & { readonly [HzBrand]: true }
export type Milliwatts = number & { readonly [MilliwattsBrand]: true }

export const hz = (n: number): Hz => Math.round(n) as Hz
export const kHz = (n: number): Hz => Math.round(n * 1_000) as Hz
export const mHz = (n: number): Hz => Math.round(n * 1_000_000) as Hz

export const mW = (n: number): Milliwatts => Math.round(n) as Milliwatts
export const watts = (n: number): Milliwatts => Math.round(n * 1000) as Milliwatts

export const toMHz = (f: Hz): number => f / 1_000_000
export const toWatts = (p: Milliwatts): number => p / 1000

/**
 * Frequency as CHIRP writes it: MHz with exactly six decimals, e.g.
 * `146.010000`. Formatted by integer arithmetic rather than `toFixed`, so a
 * float rounding artefact can never appear in an exported file.
 */
export function formatFreq(f: Hz): string {
  const neg = f < 0
  const v = Math.abs(Math.round(f))
  const whole = Math.floor(v / 1_000_000)
  const frac = v % 1_000_000
  return `${neg ? '-' : ''}${whole}.${String(frac).padStart(6, '0')}`
}

/**
 * Parse a frequency the way CHIRP does: bare numbers are MHz, and an explicit
 * `MHz`/`kHz`/`Hz` suffix overrides that.
 */
export function parseFreq(text: string): Hz {
  const s = text.trim()
  if (s === '') return hz(0)
  const m = /^(-?[\d.]+)\s*(mhz|khz|hz)?$/i.exec(s)
  if (!m) throw new RangeError(`Cannot parse frequency: ${JSON.stringify(text)}`)
  const n = Number(m[1])
  if (!Number.isFinite(n)) throw new RangeError(`Cannot parse frequency: ${JSON.stringify(text)}`)
  switch (m[2]?.toLowerCase()) {
    case 'hz':
      return hz(n)
    case 'khz':
      return kHz(n)
    default:
      return mHz(n)
  }
}

/**
 * Power as CHIRP writes it: `50W` at or above 10 W, `1.5W` below.
 * Matches `AutoNamedPowerLevel.__str__` in chirp_common.py.
 */
export function formatPower(p: Milliwatts): string {
  const w = p / 1000
  return w >= 10 ? `${Math.round(w)}W` : `${w.toFixed(1)}W`
}

/** Parse CHIRP power strings: `50W`, `1.5w`, or a bare number meaning watts. */
export function parsePower(text: string): Milliwatts {
  const m = /^\s*([\d.]+)\s*w?\s*$/i.exec(text)
  if (!m) throw new RangeError(`Cannot parse power: ${JSON.stringify(text)}`)
  const n = Number(m[1])
  if (!Number.isFinite(n)) throw new RangeError(`Cannot parse power: ${JSON.stringify(text)}`)
  return watts(n)
}
