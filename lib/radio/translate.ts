// SPDX-License-Identifier: GPL-3.0-or-later
import { txFrequency, type Channel } from '../model/channel.js'
import { describeTone, nearestCtcss, type ToneSpec } from '../model/tones.js'
import { hz, mW, type Hz } from '../model/units.js'
import { clampPower, type BandLimit, type RadioSchema } from './schema.js'

/**
 * Move channels onto a radio that is not the one they came from.
 *
 * `Codeplug` is radio-agnostic, so the records themselves travel. What does not
 * travel is everything the target cannot represent, and the whole difficulty is
 * that most of those have a plausible-looking wrong answer. A DCS code the
 * target's table lacks can be approximated to a near neighbour, and the result
 * is a channel whose squelch never opens - worse than no tone at all, and
 * silent. So a tone that cannot be carried is dropped and said out loud, not
 * rounded.
 *
 * One rule refuses rather than adjusts. A receive-only channel arriving on a
 * radio with no way to enforce that would be programmed transmit-capable, and
 * that is the exact failure `txAllowed` exists to prevent: a weather or
 * public-safety frequency somebody can key up. There is no adjustment that
 * makes it safe, so the row does not go.
 *
 * Pure, and nothing here commits anything. It returns what it would do and why,
 * and the caller decides. That is also why this is shared machinery rather than
 * one screen's helper: CSV import and preset staging want the same pipeline,
 * and a second copy would drift the way the four validators did.
 */

/** The rules, in the order they run. Order matters: see `clampChannel`. */
export type ClampRule =
  | 'rx-band'
  | 'tx-band'
  | 'tx-inhibit'
  | 'name'
  | 'modulation'
  | 'bandwidth'
  | 'tone'
  | 'power'
  | 'step'

/** One field this pipeline would change, and why. */
export interface ClampChange {
  /** The slot the channel came from, so a row can be found again. */
  readonly index: number
  readonly rule: ClampRule
  readonly field: string
  readonly before: string
  readonly after: string
  readonly why: string
}

/** Why a channel cannot go onto this radio at all. */
export interface ClampRefusal {
  readonly index: number
  readonly rule: ClampRule
  readonly field: string
  readonly why: string
}

export interface ClampedChannel {
  /** Null when the channel was refused. */
  readonly channel: Channel | null
  readonly changes: readonly ClampChange[]
  readonly refusal: ClampRefusal | null
}

export interface TranslateResult {
  readonly rows: readonly ClampedChannel[]
  /** Everything that would change, flattened, for a Row / Field / Before → After table. */
  readonly changes: readonly ClampChange[]
  readonly refusals: readonly ClampRefusal[]
  /** Lists the source carried that the target has no concept of. */
  readonly dropped: readonly string[]
}

const MHZ = (f: number) => `${(f / 1e6).toFixed(5)} MHz`
const bandFor = (bands: readonly BandLimit[], f: number) =>
  bands.find((b) => f >= b.loHz && f <= b.hiHz) ?? null
const nearest = (target: number, options: readonly number[]) =>
  options.reduce((best, o) => (Math.abs(o - target) < Math.abs(best - target) ? o : best), options[0]!)

/**
 * Put one channel onto `target`, or refuse it.
 *
 * The order is the issue's and it is not arbitrary. Band checks come first
 * because a channel that cannot be received or transmitted is refused outright
 * and there is no point clamping its name. Transmit-inhibit follows, because it
 * can turn a band problem into a refusal. Everything after that is cosmetic by
 * comparison and runs in the order a person would read it.
 */
export function clampChannel(ch: Channel, target: RadioSchema): ClampedChannel {
  const changes: ClampChange[] = []
  const at = (rule: ClampRule, field: string, before: string, after: string, why: string) =>
    changes.push({ index: ch.index, rule, field, before, after, why })
  const refuse = (rule: ClampRule, field: string, why: string): ClampedChannel => ({
    channel: null,
    changes,
    refusal: { index: ch.index, rule, field, why },
  })

  const bands = target.rf.bands
  let next: Channel = { ...ch, extras: { ...ch.extras } }

  // 1. Receive band. Nothing to clamp to: a 220 MHz channel means nothing on a
  //    radio that stops at 174, and moving it somewhere else would invent a
  //    channel the user never asked for.
  if (!bandFor(bands, next.rxFreq)) {
    return refuse('rx-band', 'rxFreq', `${MHZ(next.rxFreq)} is outside every band this radio covers.`)
  }

  // 2. Transmit band. This one has a safe adjustment - stop transmitting - so
  //    it is taken, and rule 3 decides whether the radio can honour it.
  const txHz = txFrequency(next)
  if (txHz !== null) {
    const txBand = bandFor(bands, txHz)
    if (!txBand) {
      at('tx-band', 'txAllowed', 'transmits', 'receive-only',
        `${MHZ(txHz)} is outside every band this radio covers, so the channel arrives receive-only.`)
      next = { ...next, txAllowed: false, txInhibitReason: `Transmit on ${MHZ(txHz)} is outside this radio's bands` }
    } else if (!txBand.txAllowed) {
      at('tx-band', 'txAllowed', 'transmits', 'receive-only',
        `${MHZ(txHz)} is in the ${txBand.label} band, which is receive-only on this radio.`)
      next = { ...next, txAllowed: false, txInhibitReason: `${txBand.label} is receive-only` }
    }
  }

  // 3. Can this radio actually be told not to transmit?
  //
  //    The one rule that refuses rather than adjusts. A receive-only channel on
  //    a radio with no mechanism would be programmed transmit-capable, which is
  //    precisely the failure the flag exists to prevent and is invisible until
  //    somebody keys up on a frequency they should not.
  if (!next.txAllowed && target.rf.txInhibit === false) {
    return refuse('tx-inhibit', 'txAllowed',
      'This channel must not transmit, and this radio has no way to enforce that, so it would arrive ' +
      'transmit-capable.')
  }

  // 4. Name: the target's length and charset.
  const charset = target.memory.nameCharset
  let name = next.name
  if (charset.length > 0) {
    const cleaned = [...name].filter((c) => charset.includes(c)).join('')
    if (cleaned !== name) {
      at('name', 'name', JSON.stringify(name), JSON.stringify(cleaned),
        `This radio cannot show ${[...new Set([...name].filter((c) => !charset.includes(c)))]
          .map((c) => JSON.stringify(c)).join(', ')} in a name.`)
      name = cleaned
    }
  }
  if (name.length > target.memory.nameLength) {
    const cut = name.slice(0, target.memory.nameLength)
    at('name', 'name', JSON.stringify(name), JSON.stringify(cut),
      `This radio shows ${target.memory.nameLength} characters.`)
    name = cut
  }
  if (name !== next.name) next = { ...next, name }

  // 5. Modulation. A DMR channel onto an analog radio keeps its frequency and
  //    loses the digital part, which the caller is told about rather than left
  //    to notice. Its talk group, contact and radio ID have no analogue and go
  //    with it - see `dropped` on the result.
  if (target.rf.modulations.length > 0 && !target.rf.modulations.includes(next.modulation)) {
    const fallback = target.rf.modulations.includes('FM') ? 'FM' : target.rf.modulations[0]!
    at('modulation', 'modulation', next.modulation, fallback,
      `This radio has no ${next.modulation}. The frequency carries over; everything ${next.modulation} ` +
      'specific about the channel does not.')
    next = { ...next, modulation: fallback }
  }

  // 6. Bandwidth, downwards only. Widening can put a channel outside a
  //    narrowband rule that applies where its owner is, which is not a
  //    conversion decision to make on somebody's behalf.
  const widths = target.rf.bandwidths
  if (widths.length > 0 && !widths.includes(next.bandwidthHz)) {
    const narrower = widths.filter((w) => w <= next.bandwidthHz)
    const chosen = narrower.length > 0 ? Math.max(...narrower) : Math.min(...widths)
    at('bandwidth', 'bandwidthHz', `${(next.bandwidthHz / 1000).toFixed(2)} kHz`,
      `${(chosen / 1000).toFixed(2)} kHz`,
      narrower.length > 0
        ? 'This radio does not have that bandwidth, so the next one down is used. Never up: widening can ' +
          'break a narrowband rule.'
        : 'This radio has nothing that narrow, so its narrowest is used.')
    next = { ...next, bandwidthHz: chosen }
  }

  // 7. Tones. CTCSS moves to the nearest the radio has, because being a tenth
  //    of a hertz out still opens the squelch. DTCS does not: the codes are
  //    identifiers, not measurements, and the nearest one is simply a different
  //    code. A wrong DCS code keeps the squelch shut, so it is dropped.
  const clampTone = (t: ToneSpec | null, side: 'rx' | 'tx'): ToneSpec | null => {
    if (t === null) return null
    if (t.kind === 'ctcss') {
      const list = target.rf.ctcssDeciHz
      if (list.length === 0 || list.includes(t.deciHz)) return t
      const to = nearestCtcss(t.deciHz, list)
      at('tone', side === 'rx' ? 'tone.rx' : 'tone.tx', describeTone(t), describeTone({ kind: 'ctcss', deciHz: to }),
        'The nearest tone this radio has.')
      return { kind: 'ctcss', deciHz: to }
    }
    if (target.rf.dtcsCodes.length === 0 || target.rf.dtcsCodes.includes(t.code)) return t
    at('tone', side === 'rx' ? 'tone.rx' : 'tone.tx', describeTone(t), 'none',
      `This radio's DCS table has no ${t.code}. A near code is a different code and would hold the ` +
      'squelch shut, so the tone is dropped instead.')
    return null
  }
  const rx = clampTone(next.tone.rx, 'rx')
  const tx = clampTone(next.tone.tx, 'tx')
  if (rx !== next.tone.rx || tx !== next.tone.tx) {
    next = { ...next, tone: { ...next.tone, rx, tx } }
  }

  // 8. Power: the highest level at or below what was asked for. Never above.
  const levels = target.rf.powerLevels
  if (levels.length > 0 && !levels.some((l) => l.mW === next.power.mW)) {
    const chosen = clampPower(target, next.power.mW)
    at('power', 'power', `${(next.power.mW / 1000).toFixed(1)} W`, `${(chosen.mW / 1000).toFixed(1)} W`,
      'The closest level this radio has without going over.')
    next = { ...next, power: { mW: mW(chosen.mW), ...(chosen.label === undefined ? {} : { label: chosen.label }) } }
  }

  // 9. Tuning step, nearest. It affects manual tuning from this channel rather
  //    than the channel itself, so nearest is fine here where it is not for a
  //    DCS code.
  const steps = target.rf.tuningSteps
  if (steps.length > 0 && !steps.includes(next.tuningStep)) {
    const chosen = nearest(next.tuningStep, steps as readonly number[])
    at('step', 'tuningStep', `${(next.tuningStep / 1000).toFixed(2)} kHz`, `${(chosen / 1000).toFixed(2)} kHz`,
      'The nearest step this radio has.')
    next = { ...next, tuningStep: hz(chosen) as Hz }
  }

  return { channel: next, changes, refusal: null }
}

export interface TranslateInput {
  readonly channels: readonly Channel[]
  readonly target: RadioSchema
  /**
   * What the source carried besides channels, so the result can say what is
   * being left behind. Talk groups and contacts have no analogue on an analog
   * radio and are simply lost.
   */
  readonly carries?: { readonly talkGroups?: number; readonly contacts?: number; readonly radioIds?: number }
}

/**
 * Run the pipeline over a bank of channels.
 *
 * `extras` travels untouched, per-radio blocks included. A channel copied
 * UV-K5 to DM-32UV keeps its `uvk5` block, so copying it back is lossless -
 * which is the difference between moving a channel and rebuilding one.
 */
export function translateChannels(input: TranslateInput): TranslateResult {
  const rows = input.channels.map((ch) => clampChannel(ch, input.target))
  const dropped: string[] = []

  if (input.target.features.talkGroups === false && (input.carries?.talkGroups ?? 0) > 0) {
    dropped.push(`${input.carries!.talkGroups} talk group(s), which this radio has no concept of`)
  }
  if (input.target.features.contacts === false && (input.carries?.contacts ?? 0) > 0) {
    dropped.push(`${input.carries!.contacts} DMR contact(s), which this radio has no concept of`)
  }
  if (input.target.features.radioIds === false && (input.carries?.radioIds ?? 0) > 0) {
    dropped.push(`${input.carries!.radioIds} DMR radio ID(s), which this radio has no concept of`)
  }

  return {
    rows,
    changes: rows.flatMap((r) => r.changes),
    refusals: rows.map((r) => r.refusal).filter((r): r is ClampRefusal => r !== null),
    dropped,
  }
}

/**
 * The channels a caller accepted, in slot order.
 *
 * Acceptance is per row and per rule: a person can take the name truncation and
 * refuse the tone drop, and refusing any rule a row depended on drops the row.
 * Nothing here writes anything - the caller places the result.
 */
export function acceptTranslation(
  result: TranslateResult,
  accepted: { readonly rows?: ReadonlySet<number>; readonly rules?: ReadonlySet<ClampRule> },
): Channel[] {
  const out: Channel[] = []
  for (const row of result.rows) {
    if (row.channel === null) continue
    const index = row.channel.index
    if (accepted.rows && !accepted.rows.has(index)) continue
    if (accepted.rules && row.changes.some((c) => !accepted.rules!.has(c.rule))) continue
    out.push(row.channel)
  }
  return out.sort((a, b) => a.index - b.index)
}
