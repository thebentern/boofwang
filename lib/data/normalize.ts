// SPDX-License-Identifier: GPL-3.0-or-later
import type { Modulation, TxSpec } from '../model/channel.js'
import { CTCSS_DECIHZ, DTCS_CODES, ctcss, dtcs, nearestCtcss, type ToneSpec } from '../model/tones.js'
import { hz, type Hz } from '../model/units.js'

/**
 * Turning published repeater data into something a radio can hold.
 *
 * Every rule here exists because real data broke a simpler one. The fields
 * these directories publish are free text typed by thousands of people over
 * twenty years, and they are not a schema: a field called `encode` holds a
 * CTCSS tone in most records, a DMR colour code in five thousand of them, and
 * in a few dozen it holds `'$145'`, `'0000.'` or `'A'`.
 *
 * The governing rule is the one the CSV importer already follows: a value that
 * cannot be read becomes *no value*, never a plausible one, and the record says
 * so. A wrong tone keeps the squelch shut, which looks exactly like a broken
 * radio to the person holding it.
 */

/**
 * Whitespace as published.
 *
 * `\s` covers U+00A0, which matters: one record reads `1\u00a0750.0`, and a
 * reader that strips only ASCII space leaves a value no number pattern matches.
 */
const WS = /\s+/gu

const strip = (s: string): string => s.replace(WS, '')

/**
 * A CTCSS tone as these directories write it: two or three digits, optionally
 * one or two decimal places.
 *
 * Two places because roughly a hundred records write `103.50` where the rest
 * write `103.5`, and rejecting those threw away real tones.
 *
 * Deliberately stricter than `Number()`, which accepts every one of the
 * malformed values observed in live data - `'.0'` becomes 0, `'100.'` becomes
 * 100, `'0000.'` becomes 0. A zero-hertz tone is not a tone, and a channel
 * carrying one is a channel that will not open.
 */
const CTCSS_SHAPE = /^\d{2,3}(?:\.\d{1,2})?$/

/**
 * An explicit "no tone", as distinct from a field nobody filled in.
 *
 * 1,320 records write some spelling of zero. It means the repeater is open, and
 * reporting each one as unreadable buried the issues that mattered under noise.
 */
const EXPLICIT_NONE = /^0+\.?0*$/

/** The standard CTCSS band, in tenths of a hertz. Anything outside it is not a CTCSS tone. */
const CTCSS_MIN = CTCSS_DECIHZ[0]!
const CTCSS_MAX = CTCSS_DECIHZ[CTCSS_DECIHZ.length - 1]!

export interface ParsedAccess {
  readonly tone: ToneSpec | null
  /** Present when the field carried a `CCn` colour code instead of, or as well as, a tone. */
  readonly colorCode?: number
  /** Why something was dropped, if it was. Empty when the field was clean or blank. */
  readonly issues: readonly string[]
}

/**
 * Read one of the free-text access fields.
 *
 * Splits on `/`, because that is the separator these directories use when a
 * repeater needs more than one thing to open it, and then asks of each part
 * only whether it is unambiguously a CTCSS tone or unambiguously a colour code.
 * `NAC`, `RAN`, `CAN` and DCS parts are recognised well enough to be ignored
 * rather than misread as tones.
 *
 * A field carrying two CTCSS tones - `'88.5/71.9'` appears in live data - is
 * dropped rather than resolved. The two are conventionally the two directions,
 * but the convention is not stated anywhere and the directories do not agree on
 * the order. Guessing gets it right half the time and produces a radio that
 * cannot open the repeater the other half.
 */
export function parseAccess(raw: unknown): ParsedAccess {
  if (typeof raw !== 'string') return { tone: null, issues: [] }
  const text = strip(raw)
  if (text === '') return { tone: null, issues: [] }

  const issues: string[] = []
  const tones: ToneSpec[] = []
  let colorCode: number | undefined

  for (const part of text.split('/')) {
    if (part === '' || EXPLICIT_NONE.test(part)) continue

    const cc = /^CC(\d{1,2})$/i.exec(part)
    if (cc) {
      colorCode = Number(cc[1])
      continue
    }

    // DCS, written either way round: `D023` and `DCS023` both appear. Read
    // rather than skipped, because a repeater whose access is a DCS code is no
    // less usable than one whose access is a tone - and `clampChannel` already
    // knows to drop a code a given radio does not have.
    const dcsMatch = /^D(?:CS)?(\d{2,3})([NRI])?$/i.exec(part)
    if (dcsMatch) {
      const code = Number(dcsMatch[1])
      if (DTCS_CODES.includes(code)) {
        tones.push(dtcs(code, dcsMatch[2]?.toUpperCase() === 'R' ? 'R' : 'N'))
      } else {
        issues.push(`DCS code ${dcsMatch[1]} is not a standard code, so the tone was dropped.`)
      }
      continue
    }

    // Network access codes, which belong to modes boofwang does not set. Named
    // so they are skipped knowingly rather than falling through to the tone
    // branch and failing its shape test by luck.
    if (/^(?:NAC|RAN|CAN)\d+$/i.test(part)) continue

    if (CTCSS_SHAPE.test(part)) {
      const deciHz = Math.round(Number(part) * 10)
      if (deciHz >= CTCSS_MIN && deciHz <= CTCSS_MAX) {
        tones.push(ctcss(deciHz))
        continue
      }
    }

    // Single letters and stray punctuation are common enough that reporting
    // each one would drown the useful issues. Only report something that looked
    // like it was trying to be a number.
    if (/\d/.test(part)) issues.push(`Access value ${JSON.stringify(part)} is not a tone boofwang can read.`)
  }

  if (tones.length > 1) {
    issues.push(
      `Access field ${JSON.stringify(raw)} names more than one tone and does not say which is which, `
      + 'so no tone was set.',
    )
    return { tone: null, ...(colorCode === undefined ? {} : { colorCode }), issues }
  }

  if (tones.length === 0) {
    return { tone: null, ...(colorCode === undefined ? {} : { colorCode }), issues }
  }

  const only = tones[0]!
  const cc = colorCode === undefined ? {} : { colorCode }

  // DCS codes are identifiers, not measurements, so there is no nearest one to
  // move to - the same reasoning `clampChannel` applies when it drops a code
  // rather than snapping it. Non-standard codes were already rejected above.
  if (only.kind === 'dtcs') return { tone: only, ...cc, issues }

  // CTCSS is a measurement, and a tenth of a hertz out still opens the squelch,
  // so a near miss moves to the nearest standard tone and says it did.
  const nearest = nearestCtcss(only.deciHz)
  if (nearest !== only.deciHz) {
    issues.push(
      `${(only.deciHz / 10).toFixed(1)} Hz is not a standard CTCSS tone; `
      + `${(nearest / 10).toFixed(1)} Hz was used instead.`,
    )
  }
  return { tone: ctcss(nearest), ...cc, issues }
}

/**
 * The mode tokens these directories use, longest first.
 *
 * Order matters twice over. Longest-first stops `FM` matching inside `NFM`,
 * and stops `DMR` matching inside nothing at all while `D-STAR` would otherwise
 * be found as `D` plus rubbish. And several records concatenate modes with no
 * separator - `'D-STARDMR'`, `'P25YSFD-STARNXDNDMR/FM'` - so this has to scan
 * for tokens by position rather than split on anything.
 */
const MODE_TOKENS: readonly (readonly [string, Modulation | null, number | null])[] = [
  ['D-STAR', 'DSTAR', null],
  ['DSTAR', 'DSTAR', null],
  ['NXDN', null, null],
  ['AX25', null, null],
  ['M17', null, null],
  ['DMR', 'DMR', null],
  ['YSF', null, null],
  ['P25', 'P25', null],
  ['ATV', null, null],
  ['NFM', 'FM', 12_500],
  ['FM', 'FM', 25_000],
  ['AM', 'AM', 25_000],
  ['TV', null, null],
]

export interface ParsedMode {
  readonly modulation: Modulation | null
  /** Only set when the mode string implied it, as `NFM` does. */
  readonly bandwidthHz?: number
  readonly issue?: string
}

/**
 * Read a published mode string.
 *
 * Takes the *first* mode named, and deliberately does not prefer the one the
 * target radio happens to support. A mixed-mode repeater published as `DMR/FM`
 * is recorded as DMR, and `clampChannel` is what degrades it to FM on an
 * analogue radio - reporting the downgrade as it goes. Resolving it here would
 * make the same decision silently, and would make it once for every radio
 * rather than once per radio.
 *
 * A mode boofwang has no `Modulation` for - NXDN, YSF, M17, AX.25, ATV - yields
 * null. The caller drops the record: staging a channel whose mode is a guess is
 * how someone ends up transmitting the wrong thing on a repeater's input.
 */
export function parseMode(raw: unknown): ParsedMode {
  if (typeof raw !== 'string') return { modulation: null, issue: 'No mode.' }
  const text = strip(raw).toUpperCase()
  if (text === '') return { modulation: null, issue: 'No mode.' }

  const found = MODE_TOKENS
    .map((token) => [text.indexOf(token[0]), token] as const)
    .filter(([at]) => at >= 0)
    .sort((a, b) => a[0] - b[0])

  if (found.length === 0) {
    return { modulation: null, issue: `Mode ${JSON.stringify(raw)} is not one boofwang knows.` }
  }

  // The first mode boofwang can *represent*, not simply the first mode named.
  // `YSF/FM` is a repeater that does both, and the FM half is real - stopping at
  // the YSF would throw away a channel that works. Modes that no supported radio
  // can use are stepped over, but they never promote a later mode ahead of an
  // earlier one that is representable: `DMR/FM` is still DMR, and it is
  // `clampChannel` that decides what an analogue radio does about that.
  const usable = found.find(([, token]) => token[1] !== null)
  if (usable === undefined) {
    const names = found.map(([, token]) => token[0]).join(', ')
    return { modulation: null, issue: `${names} is not a mode any radio boofwang supports can use.` }
  }

  const [, token] = usable
  return {
    modulation: token[1]!,
    ...(token[2] === null ? {} : { bandwidthHz: token[2] }),
  }
}

/**
 * Read a frequency published as a decimal string of megahertz.
 *
 * Rejects rather than rounds. `parseFreq` in `lib/model/units.ts` is the lenient
 * reader for text a person typed; this one reads a machine field, where a value
 * that does not look like a frequency means the record is broken rather than
 * that someone was casual.
 */
export function parseMHzField(raw: unknown): Hz | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? hz(raw * 1e6) : null
  if (typeof raw !== 'string') return null
  const text = strip(raw)
  if (!/^\d{1,4}(?:\.\d{1,6})?$/.test(text)) return null
  const n = Number(text)
  return n > 0 ? hz(n * 1e6) : null
}

/**
 * A repeater shift published as a signed decimal of megahertz.
 *
 * The sign is the whole point and it is not always there. RadioID publishes
 * `+5.000` and `-0.600` for the great majority of records, and a handful of
 * bare `5.000` - which could be either direction. A 70 cm repeater in the
 * United States conventionally shifts up, so guessing `+` would be right most
 * of the time; being wrong the rest of the time means transmitting 5 MHz from
 * where anyone is listening, on a frequency belonging to somebody else.
 *
 * So an unsigned value is `ambiguous`, and the caller drops the record and says
 * why. That is a handful of repeaters out of hundreds, and the alternative is a
 * channel that looks correct and transmits in the wrong place.
 */
export type OffsetRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'offset'; readonly deltaHz: number }
  | { readonly kind: 'ambiguous'; readonly raw: string }

export function parseSignedMHzOffset(raw: unknown): OffsetRead {
  if (typeof raw === 'number') {
    return raw === 0 ? { kind: 'none' } : { kind: 'offset', deltaHz: Math.round(raw * 1e6) }
  }
  if (typeof raw !== 'string') return { kind: 'none' }
  const text = strip(raw)
  if (text === '' || EXPLICIT_NONE.test(text)) return { kind: 'none' }
  if (!/^[+-]?\d{1,3}(?:\.\d{1,6})?$/.test(text)) return { kind: 'ambiguous', raw }
  if (!/^[+-]/.test(text)) return { kind: 'ambiguous', raw }
  return { kind: 'offset', deltaHz: Math.round(Number(text) * 1e6) }
}

/**
 * Where this radio transmits, given what the repeater receives.
 *
 * Both frequencies are from the repeater's point of view on the way in and this
 * radio's on the way out, which is the inversion that makes a channel hear
 * nothing when it is got wrong. `rxFreq` is what we receive - the repeater's
 * output. `repeaterInput` is what it listens to, which is where we transmit.
 *
 * An offset is preferred over a split because that is how every radio here
 * stores an ordinary repeater pair, and because a split survives a frequency
 * edit badly. Anything that is not a clean offset stays a split rather than
 * being rounded into one.
 */
export function txSpecFor(rxFreq: Hz, repeaterInput: Hz | null): TxSpec {
  if (repeaterInput === null || repeaterInput === rxFreq) return { kind: 'simplex' }
  const delta = repeaterInput - rxFreq
  return delta > 0
    ? { kind: 'offset', direction: 'plus', offset: hz(delta) }
    : { kind: 'offset', direction: 'minus', offset: hz(-delta) }
}

/**
 * Whether a published colour code can be stored at all.
 *
 * Live BrandMeister data carries colour codes from 0 to 17. DMR defines 0 to
 * 15, and the DM-32UV stores it in four bits - so 17 does not fail, it becomes
 * 1. The channel then looks correct everywhere it is displayed and cannot key
 * the repeater it names. Range-check before the value is anywhere near a
 * struct.
 */
export function isStorableColorCode(cc: unknown, max = 15): cc is number {
  return typeof cc === 'number' && Number.isInteger(cc) && cc >= 0 && cc <= max
}
