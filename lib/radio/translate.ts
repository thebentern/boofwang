// SPDX-License-Identifier: GPL-3.0-or-later
import { plural } from '../text/plural.js'
import { txFrequency, type Channel, type TxSpec } from '../model/channel.js'
import { describeTone, nearestCtcss, type ToneSpec } from '../model/tones.js'
import { hz, mW, type Hz } from '../model/units.js'
import { clampPower, type BandLimit, type RadioSchema } from './schema.js'

/**
 * Move channels onto a radio that is not the one they came from.
 *
 * `Codeplug` is radio-agnostic, so the records themselves travel. What does not
 * travel is everything the target cannot represent, and the whole difficulty is
 * that most of those have a plausible-looking wrong answer. A DCS code the
 * target's table lacks can be approximated to a near neighbor, and the result
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
  | 'shift'
  | 'tx-inhibit'
  | 'name'
  | 'modulation'
  | 'bandwidth'
  | 'tone'
  | 'power'
  | 'step'

/** Every rule, in the order they run, so a caller can offer them all. */
export const ALL_CLAMP_RULES: readonly ClampRule[] = [
  'rx-band', 'tx-band', 'shift', 'tx-inhibit', 'name', 'modulation', 'bandwidth', 'tone', 'power', 'step',
]

/** What each rule is called where a person can see it. */
export const CLAMP_RULE_LABELS: Readonly<Record<ClampRule, string>> = {
  'rx-band': 'Receive frequency',
  'tx-band': 'Transmit frequency',
  shift: 'Shift',
  'tx-inhibit': 'Receive-only',
  name: 'Name',
  modulation: 'Mode',
  bandwidth: 'Bandwidth',
  tone: 'Tones',
  power: 'Power',
  step: 'Tuning step',
}

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

/**
 * The `extras.vendor` keys that only mean something on a digital channel.
 *
 * Transcribed from `decodeChannel` in `lib/radios/dm32uv/driver.ts`, which is
 * the only driver that writes any of them today. Kept here rather than imported
 * because `lib/radio/` must not depend on a particular radio - if a second DMR
 * driver appears with different names, this list grows rather than the
 * dependency.
 */
const DIGITAL_VENDOR_KEYS: ReadonlySet<string> = new Set([
  'colorCode',
  'timeSlot',
  'txContact',
  'radioIdIndex',
  'encryptionKeyId',
  'encryptEnabled',
])

const MHZ = (f: number) => `${(f / 1e6).toFixed(5)} MHz`
const bandFor = (bands: readonly BandLimit[], f: number) =>
  bands.find((b) => f >= b.loHz && f <= b.hiHz) ?? null
const nearest = (target: number, options: readonly number[]) =>
  options.reduce((best, o) => (Math.abs(o - target) < Math.abs(best - target) ? o : best), options[0]!)

/**
 * The widest shift a split may become, by receive frequency, or null where
 * nothing limits it.
 *
 * CHIRP's, from `_import_duplex` in `chirp/import_logic.py`: 15 MHz up to
 * 500 MHz and 50 MHz above it, to 3 GHz, lower bound exclusive and upper
 * inclusive, measured from the receive frequency. CHIRP calls anything wider
 * "abnormally large", and it is what separates a repeater pair from a
 * cross-band split - 2 m to 70 cm is 300 MHz - and nobody has watched the
 * UV-K5, the one radio here that stores only a shift, transmit one through it.
 */
function maxShiftHz(rxHz: number): number | null {
  if (rxHz > 0 && rxHz <= 500_000_000) return 15_000_000
  if (rxHz > 500_000_000 && rxHz <= 3_000_000_000) return 50_000_000
  return null
}

/**
 * Put one channel onto `target`, or refuse it.
 *
 * The order is the issue's and it is not arbitrary. Band checks come first
 * because a channel that cannot be received or transmitted is refused outright
 * and there is no point clamping its name. Transmit-inhibit follows, because it
 * can turn a band problem into a refusal. The shift sits between them: it can
 * leave a channel receive-only as well, so it has to run before the rule that
 * asks whether the radio can honor that, and after the band check, which may
 * have settled the matter already. Everything after that is cosmetic by
 * comparison and runs in the order a person would read it.
 */
export function clampChannel(ch: Channel, target: RadioSchema, rfOverride?: RadioSchema['rf']): ClampedChannel {
  const changes: ClampChange[] = []
  const at = (rule: ClampRule, field: string, before: string, after: string, why: string) =>
    changes.push({ index: ch.index, rule, field, before, after, why })
  const refuse = (rule: ClampRule, field: string, why: string): ClampedChannel => ({
    channel: null,
    changes,
    refusal: { index: ch.index, rule, field, why },
  })

  /*
   * What the radio can do right now, which is not always what its schema says.
   *
   * The UV-K5 is the reason: an egzumer build compiled with wide receive
   * legitimately reaches frequencies the stock table does not list, and the
   * driver reports that through `rfFor(doc)`. The channel editor and the
   * validator both already ask that question; the clamp pipeline did not, so it
   * refused channels the editor would happily save on the very same radio.
   */
  const rf = rfOverride ?? target.rf
  const bands = rf.bands
  let next: Channel = { ...ch, extras: { ...ch.extras } }

  // 1. Receive band. Nothing to clamp to: a 220 MHz channel means nothing on a
  //    radio that stops at 174, and moving it somewhere else would invent a
  //    channel the user never asked for.
  if (!bandFor(bands, next.rxFreq)) {
    return refuse('rx-band', 'rxFreq', `${MHZ(next.rxFreq)} is outside every band this radio covers.`)
  }

  // 2. Transmit band. This one has a safe adjustment - stop transmitting - so
  //    it is taken, and rule 4 decides whether the radio can honor it.
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

  // 3. A split, onto a radio that stores only a shift.
  //
  //    The UV-K5 is that radio, and its encoder refuses a split outright, so a
  //    CSV row with `Duplex=split` staged onto it used to arrive as a channel
  //    nothing could write. CHIRP's import has the answer, in `_import_duplex`:
  //    a split becomes the shift that reaches the same transmit frequency, and
  //    one wider than `maxShiftHz` does not become a shift at all. CHIRP
  //    refuses that one. This takes rule 2's adjustment instead - stop
  //    transmitting - and leaves rule 4 to decide whether the radio can.
  //
  //    Only a channel that may transmit. A receive-only channel's transmit
  //    side is never what the UV-K5 is told, so its split is left for the
  //    editor to show if transmit is ever turned back on.
  if (next.txAllowed && next.tx.kind === 'split' && !rf.duplexes.includes('split')) {
    const txHz = next.tx.txFreq
    const delta = txHz - next.rxFreq
    const limit = maxShiftHz(next.rxFreq)
    if (limit !== null && Math.abs(delta) > limit) {
      at('shift', 'txAllowed', 'transmits', 'receive-only',
        `This radio stores a shift, not a separate transmit frequency, and ${MHZ(txHz)} is ` +
        `${MHZ(Math.abs(delta))} from the receive frequency, more than the ${limit / 1e6} MHz a shift ` +
        'is held to here, so the channel arrives receive-only.')
      next = { ...next, txAllowed: false, txInhibitReason: `Split to ${MHZ(txHz)} is wider than a shift` }
    } else {
      const tx: TxSpec =
        delta === 0
          ? { kind: 'simplex' }
          : { kind: 'offset', direction: delta > 0 ? 'plus' : 'minus', offset: hz(Math.abs(delta)) }
      at('shift', 'tx', `split to ${MHZ(txHz)}`, tx.kind === 'offset' ? `${tx.direction} ${MHZ(tx.offset)}` : 'simplex',
        'This radio stores a shift, not a separate transmit frequency. This shift transmits on the same one.')
      next = { ...next, tx }
    }
  }

  // 4. Can this radio actually be told not to transmit?
  //
  //    The one rule that refuses rather than adjusts. A receive-only channel on
  //    a radio with no mechanism would be programmed transmit-capable, which is
  //    precisely the failure the flag exists to prevent and is invisible until
  //    somebody keys up on a frequency they should not.
  if (!next.txAllowed && rf.txInhibit === false) {
    return refuse('tx-inhibit', 'txAllowed',
      'This channel must not transmit, and this radio has no way to enforce that, so it would arrive ' +
      'transmit-capable.')
  }

  // 5. Name: the target's length and charset.
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

  // 6. Modulation. A DMR channel onto an analog radio keeps its frequency and
  //    loses the digital part, which the caller is told about rather than left
  //    to notice. Its talk group, contact and radio ID have no analogue and go
  //    with it - see `dropped` on the result.
  if (rf.modulations.length > 0 && !rf.modulations.includes(next.modulation)) {
    const fallback = rf.modulations.includes('FM') ? 'FM' : rf.modulations[0]!
    at('modulation', 'modulation', next.modulation, fallback,
      `This radio has no ${next.modulation}. The frequency carries over; everything ${next.modulation} ` +
      'specific about the channel does not.')
    next = { ...next, modulation: fallback }

    // "Everything specific about the channel does not" has to be true of the
    // bytes as well as of the sentence. `extras` travels untouched everywhere
    // else in this file, which is right when a channel is copied between slots
    // on one radio - but a DMR repeater staged onto an analogue radio would
    // otherwise become an FM channel still carrying a color code and a
    // timeslot. Inert on the radio that cannot read them, and read back as real
    // the moment that codeplug is transplanted to one that can.
    //
    // This only fires when the target lacks the modulation, so a same-radio
    // copy never reaches it and the promise made at the foot of this file still
    // holds.
    const vendor = next.extras.vendor
    const dropped = vendor === undefined ? [] : Object.keys(vendor).filter((k) => DIGITAL_VENDOR_KEYS.has(k))
    if (vendor !== undefined && dropped.length > 0) {
      at('modulation', 'extras', dropped.join(', '), 'not carried',
        'These settings only mean something on a digital channel, so they are not carried over.')
      const kept = Object.fromEntries(Object.entries(vendor).filter(([k]) => !DIGITAL_VENDOR_KEYS.has(k)))
      const { vendor: _gone, ...otherExtras } = next.extras
      next = {
        ...next,
        extras: { ...otherExtras, ...(Object.keys(kept).length === 0 ? {} : { vendor: kept }) },
      }
    }
  }

  // 7. Bandwidth, downwards only. Widening can put a channel outside a
  //    narrowband rule that applies where its owner is, which is not a
  //    conversion decision to make on somebody's behalf.
  const widths = rf.bandwidths
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

  // 8. Tones. CTCSS moves to the nearest the radio has, because being a tenth
  //    of a hertz out still opens the squelch. DTCS does not: the codes are
  //    identifiers, not measurements, and the nearest one is simply a different
  //    code. A wrong DCS code keeps the squelch shut, so it is dropped.
  const clampTone = (t: ToneSpec | null, side: 'rx' | 'tx'): ToneSpec | null => {
    if (t === null) return null
    if (t.kind === 'ctcss') {
      const list = rf.ctcssDeciHz
      if (list.length === 0 || list.includes(t.deciHz)) return t
      const to = nearestCtcss(t.deciHz, list)
      at('tone', side === 'rx' ? 'tone.rx' : 'tone.tx', describeTone(t), describeTone({ kind: 'ctcss', deciHz: to }),
        'The nearest tone this radio has.')
      return { kind: 'ctcss', deciHz: to }
    }
    if (rf.dtcsCodes.length === 0 || rf.dtcsCodes.includes(t.code)) return t
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

  // 9. Power: the highest level at or below what was asked for. Never above.
  const levels = rf.powerLevels
  if (levels.length > 0 && !levels.some((l) => l.mW === next.power.mW)) {
    const chosen = clampPower(target, next.power.mW)
    at('power', 'power', `${(next.power.mW / 1000).toFixed(1)} W`, `${(chosen.mW / 1000).toFixed(1)} W`,
      'The closest level this radio has without going over.')
    next = { ...next, power: { mW: mW(chosen.mW), ...(chosen.label === undefined ? {} : { label: chosen.label }) } }
  }

  // 10. Tuning step, nearest. It affects manual tuning from this channel
  //     rather than the channel itself, so nearest is fine here where it is
  //     not for a DCS code.
  const steps = rf.tuningSteps
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
   * The target's live RF capability, when it differs from its schema.
   *
   * Pass `driver.rfFor(doc)` - the codeplug store exposes it as `codeplug.rf`.
   * Omitting it falls back to `target.rf`, which is right for a radio whose
   * capability does not depend on its firmware.
   */
  readonly rf?: RadioSchema['rf']
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
  const rows = input.channels.map((ch) => clampChannel(ch, input.target, input.rf))
  const dropped: string[] = []

  const talkGroups = input.carries?.talkGroups ?? 0
  const contacts = input.carries?.contacts ?? 0
  const radioIds = input.carries?.radioIds ?? 0
  if (input.target.features.talkGroups === false && talkGroups > 0) {
    dropped.push(`${talkGroups} talk ${plural(talkGroups, 'group')}, which this radio has no concept of`)
  }
  if (input.target.features.contacts === false && contacts > 0) {
    dropped.push(`${contacts} DMR ${plural(contacts, 'contact')}, which this radio has no concept of`)
  }
  if (input.target.features.radioIds === false && radioIds > 0) {
    dropped.push(`${radioIds} DMR radio ${plural(radioIds, 'ID')}, which this radio has no concept of`)
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

/** One adjustment or refusal said once, with every slot it applies to. */
export interface ClampGroup<T> {
  readonly rule: ClampRule
  readonly label: string
  readonly field: string
  /** Ascending. */
  readonly slots: readonly number[]
  /** The first one met, for its before, after and why. */
  readonly sample: T
}

/**
 * Changes or refusals gathered by rule and field, in the order the rules run.
 *
 * By field as well as rule, because one rule can do two different things: the
 * shift rule rewrites a split as a shift on one channel and makes another
 * receive-only, and a summary by rule alone showed whichever came first and
 * hid the other. Fourteen names cut to the same length are still one line.
 *
 * Only the sample's `why` is shown with a group, and it is about the sample:
 * two channels made receive-only for different frequencies share a group and a
 * field, not a sentence.
 */
export function groupClamps<T extends { readonly index: number; readonly rule: ClampRule; readonly field: string }>(
  items: readonly T[],
): ClampGroup<T>[] {
  const groups = new Map<string, { rule: ClampRule; field: string; slots: number[]; sample: T }>()
  for (const item of items) {
    const key = `${item.rule}\u0000${item.field}`
    const group = groups.get(key)
    if (group) group.slots.push(item.index)
    else groups.set(key, { rule: item.rule, field: item.field, slots: [item.index], sample: item })
  }
  // A stable sort, so fields keep the order they were first met in within a rule.
  return [...groups.values()]
    .sort((a, b) => ALL_CLAMP_RULES.indexOf(a.rule) - ALL_CLAMP_RULES.indexOf(b.rule))
    .map((g) => ({
      rule: g.rule,
      label: CLAMP_RULE_LABELS[g.rule],
      field: g.field,
      slots: [...new Set(g.slots)].sort((x, y) => x - y),
      sample: g.sample,
    }))
}
