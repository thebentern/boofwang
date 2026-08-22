// SPDX-License-Identifier: GPL-3.0-or-later
import { txFrequency, type Channel } from '../model/channel.js'
import type { Codeplug } from '../model/codeplug.js'
import type { Diagnostic } from '../radio/driver.js'
import type { BandLimit, RadioSchema } from '../radio/schema.js'

/**
 * The channel rules every radio runs, derived from `RadioSchema` alone.
 *
 * These lived in the drivers, one copy each, and the copies drifted: the same
 * channel transmitting outside every band the radio covers was a blocking error
 * on a UV-K5 and silent on a UV-82 or a DM-32UV. Nobody decided that. It is
 * what four hand-written validators come to, and the write gate's
 * `validation-errors` blocker is only ever as good as the rules behind it.
 *
 * Two of these rules are errors and block a write, and they are the two that
 * describe the *hardware*: a frequency outside every band the radio covers is
 * one it cannot tune or key, so programming it produces a channel that does not
 * work. That is a fact about the equipment, and no amount of wanting changes it.
 *
 * Everything else, `regulatory.band.tx-not-permitted` included, is a warning
 * that states the rule and gets out of the way. Transmitting into a
 * receive-only allocation is a serious thing to do and the warning says so in
 * as many words - but it is a licensing question, not a hardware one, and this
 * tool is not the licensing authority. Operators hold the licence, the site
 * carries the disclaimer, and there are legitimate reasons to program a
 * frequency this table calls receive-only: a different country's allocation, a
 * commercial licence, MARS/CAP, or a receiver that simply never transmits.
 * Blocking the write did not prevent any of that. It only meant the remedy on
 * offer was to discard the intent - `runFix` in the channel table marks every
 * affected slot receive-only - or to give up on the tool.
 *
 * A driver keeps its genuinely local rules. `dmr.encryption.key-missing` means
 * nothing on an analog radio and stays with the DM-32UV.
 */

export interface ValidateContext {
  /**
   * The bands to check against, when they are not simply the schema's.
   *
   * The UV-K5 is the reason: its coverage depends on the firmware, and an
   * egzumer build compiled with wide receive legitimately reaches frequencies
   * the stock schema does not list. Checking those against the stock table
   * would report errors on channels that are fine.
   */
  readonly bands?: readonly BandLimit[] | undefined
}

const mhz = (hz: number) => `${(hz / 1e6).toFixed(5)} MHz`

/** Slots the radio owns rather than the user. */
function isSpecial(schema: RadioSchema, ch: Channel): boolean {
  return schema.memory.specialChannels.some((s) => s.index === ch.index)
}

/**
 * Check one channel.
 *
 * Exported so a caller can check a single row - the channel editor and the
 * clamp pipeline both want that - without walking a whole codeplug.
 */
export function validateChannel(
  ch: Channel,
  schema: RadioSchema,
  ctx: ValidateContext = {},
): Diagnostic[] {
  const out: Diagnostic[] = []
  const bands = ctx.bands ?? schema.rf.bands
  const bandFor = (hz: number) => bands.find((b) => hz >= b.loHz && hz <= b.hiHz) ?? null

  if (!bandFor(ch.rxFreq)) {
    out.push({
      severity: 'error',
      ruleId: 'radio.band.rx-out-of-range',
      channel: ch.index,
      field: 'rxFreq',
      message: `${mhz(ch.rxFreq)} is outside every band this radio covers.`,
    })
  }

  /*
   * The transmit rules skip the radio's own pseudo-channels.
   *
   * A stock UV-K5 ships with its F2 band preset parked on 108.250 MHz in the
   * air band, so applying these there gives every single radio two permanent
   * errors about data its owner did not create. Worse, the remedy the message
   * offers - mark the channel receive-only - has no meaning for a VFO preset,
   * and acting on it would stamp a minus shift and an offset into it. CHIRP has
   * no equivalent rule at all.
   *
   * `specialChannels` is the schema's own list of those slots, so a radio that
   * has none is unaffected and nothing here needs to know about the UV-K5.
   */
  const special = isSpecial(schema, ch)

  // The transmit frequency, not the receive one. A repeater shift can move
  // transmit into a band where transmitting is not allowed even though the
  // channel is perfectly legal to listen on, and reading `rxFreq` alone cannot
  // see it. `txFrequency` returns null for a receive-only channel, which
  // transmits nowhere and so has nothing to check.
  const txHz = special ? null : txFrequency(ch)
  if (txHz !== null) {
    const txBand = bandFor(txHz)
    if (!txBand) {
      out.push({
        severity: 'error',
        ruleId: 'radio.band.tx-out-of-range',
        channel: ch.index,
        field: 'tx',
        message: `This channel transmits on ${mhz(txHz)}, which is outside every band this radio covers.`,
      })
    } else if (!txBand.txAllowed) {
      // The air band is the case that matters: AM aviation spectrum, which no
      // amateur licence authorises transmitting on. Said plainly, and left to
      // the operator - see the note at the top of this file for why this warns
      // rather than blocks.
      out.push({
        severity: 'warning',
        ruleId: 'regulatory.band.tx-not-permitted',
        channel: ch.index,
        field: 'tx',
        message:
          `This channel can transmit on ${mhz(txHz)}, in the ${txBand.label} band, which this radio's ` +
          'band plan marks receive-only. Check your licence before transmitting here; ' +
          'marking the channel receive-only will silence this.',
      })
    }
  }

  if (!special) {
    // The VFO pseudo-channels have no name storage; their names are the radio's
    // own fixed labels ("F3(136M-174M)B"), longer than the user-name limit by
    // design. Complaining about those would be complaining about the radio.
    if (ch.name.length > schema.memory.nameLength) {
      out.push({
        severity: 'warning',
        ruleId: 'radio.name.too-long',
        channel: ch.index,
        field: 'name',
        message: `Name is ${ch.name.length} characters; the radio shows ${schema.memory.nameLength}.`,
      })
    }

    const stray = [...ch.name].filter((c) => !schema.memory.nameCharset.includes(c))
    if (stray.length > 0) {
      out.push({
        severity: 'warning',
        ruleId: 'radio.name.charset',
        channel: ch.index,
        field: 'name',
        message:
          `The radio cannot show ${[...new Set(stray)].map((c) => JSON.stringify(c)).join(', ')} ` +
          'in a channel name.',
      })
    }
  }

  /*
   * Bandwidth and power are checked against what the radio offers, not against
   * a per-band limit.
   *
   * The issue asked for "wider than the band permits" and "above the band's
   * limit", and `BandLimit` carries neither - it is a frequency range, a label
   * and a transmit flag. Inventing the numbers here would be worse than not
   * checking: a regulatory limit that is wrong is a rule people learn to
   * ignore. What the schema can answer today is whether the radio has the
   * setting at all, so that is what is asked. Per-band limits want fields on
   * `BandLimit` and the regulatory tables to fill them from.
   */
  if (schema.rf.bandwidths.length > 0 && !schema.rf.bandwidths.includes(ch.bandwidthHz)) {
    out.push({
      severity: 'warning',
      ruleId: 'radio.bandwidth.unsupported',
      channel: ch.index,
      field: 'bandwidthHz',
      message:
        `${(ch.bandwidthHz / 1000).toFixed(2)} kHz is not one of this radio's bandwidths ` +
        `(${schema.rf.bandwidths.map((b) => `${(b / 1000).toFixed(2)} kHz`).join(', ')}).`,
    })
  }

  const highest = schema.rf.powerLevels.reduce((m, p) => (p.mW > m ? p.mW : m), 0)
  if (highest > 0 && ch.power.mW > highest) {
    out.push({
      severity: 'warning',
      ruleId: 'radio.power.too-high',
      channel: ch.index,
      field: 'power',
      message:
        `${(ch.power.mW / 1000).toFixed(1)} W is above this radio's highest level ` +
        `(${(highest / 1000).toFixed(1)} W); it will transmit at that instead.`,
    })
  }

  return out
}

/** Every channel in a codeplug, in slot order. */
export function validateChannels(
  doc: Codeplug,
  schema: RadioSchema,
  ctx: ValidateContext = {},
): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const ch of [...doc.channels.values()].sort((a, b) => a.index - b.index)) {
    out.push(...validateChannel(ch, schema, ctx))
  }
  return out
}
