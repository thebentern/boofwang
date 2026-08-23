// SPDX-License-Identifier: GPL-3.0-or-later
import type { Channel, Modulation, SkipMode } from '../model/channel.js'
import type { ToneSpec } from '../model/tones.js'
import type { Hz, Milliwatts } from '../model/units.js'
import type { BandLimit } from './schema.js'

/**
 * One instruction, turned into a patch for each channel it lands on.
 *
 * Lives here rather than inside the form for the reason `place.ts` records: the
 * last piece of channel arithmetic written inside a Vue component was wrong in
 * a way nothing could see, because nothing could reach it without mounting the
 * component. This is the same shape of arithmetic, and it is applied to every
 * ticked row at once - so a mistake in it is a mistake made forty times before
 * anybody looks.
 *
 * The whole design rests on one distinction, and it is the reason this is an
 * object of optional keys rather than a `Channel` with holes in it:
 *
 * - **absent** means leave the channel's own value alone
 * - **present** means write this, including `null` where null is a value
 *
 * `rxTone: undefined` keeps whatever tone the channel has. `rxTone: null`
 * clears it. Collapsing those two into one would make "no tone" unreachable, or
 * make every apply flatten the tone of every channel the user never mentioned -
 * which across a mixed selection is silent data loss.
 */
export interface BulkChange {
  readonly power?: { readonly mW: Milliwatts; readonly label: string }
  readonly bandwidthHz?: number
  readonly modulation?: Modulation
  readonly tuningStep?: Hz
  readonly skip?: SkipMode
  /**
   * The transmit gate, which is the field this whole module is careful about.
   *
   * Spelled as an instruction rather than a boolean so that "leave alone" is
   * the absence of one. A `txAllowed?: boolean` would make `false` and
   * "unspecified" look alike at a glance in every caller, and the failure that
   * costs is a receive-only channel quietly becoming transmit-capable.
   */
  readonly transmit?: 'rx-only' | 'allow'
  readonly rxTone?: ToneSpec | null
  readonly txTone?: ToneSpec | null
}

/** True when the change says nothing, so there is nothing to apply. */
export function isEmptyChange(change: BulkChange): boolean {
  return Object.values(change).every((v) => v === undefined)
}

/**
 * The patch this change makes to one channel.
 *
 * Pure. Nothing here commits anything, and the caller decides - the same
 * arrangement `translate.ts` uses, and for the same reason: the form wants to
 * describe what would happen before it happens.
 */
export function bulkPatch(ch: Channel, change: BulkChange): Partial<Channel> {
  const patch: Partial<Channel> = {}

  if (change.power !== undefined) patch.power = { mW: change.power.mW, label: change.power.label }
  if (change.bandwidthHz !== undefined) patch.bandwidthHz = change.bandwidthHz
  if (change.modulation !== undefined) patch.modulation = change.modulation
  if (change.tuningStep !== undefined) patch.tuningStep = change.tuningStep
  if (change.skip !== undefined) patch.skip = change.skip

  if (change.transmit === 'rx-only') {
    patch.txAllowed = false
    patch.txInhibitReason = 'Marked receive-only'
  } else if (change.transmit === 'allow') {
    patch.txAllowed = true
  }

  /*
   * The pair is rebuilt whole, because a `TonePair` is one value.
   *
   * `rxInverted` goes back to false with any new receive tone. It is CHIRP's
   * TSQL-R - squelch opens when the tone is *absent* - and carrying it onto a
   * tone somebody has just chosen produces a channel that stays silent exactly
   * when the repeater is talking, from a control that said nothing about
   * inversion. Leaving the receive tone alone leaves the inversion alone too.
   */
  if (change.rxTone !== undefined || change.txTone !== undefined) {
    patch.tone = {
      rx: change.rxTone === undefined ? ch.tone.rx : change.rxTone,
      tx: change.txTone === undefined ? ch.tone.tx : change.txTone,
      rxInverted: change.rxTone === undefined ? ch.tone.rxInverted : false,
    }
  }

  return patch
}

/** What allowing transmit across a selection would actually unlock. */
export interface TransmitExposure {
  /** Channels that cannot transmit today and would be able to after this change. */
  readonly unlocked: readonly Channel[]
  /** Of those, the ones receiving in a band the radio's plan marks receive-only. */
  readonly inReceiveOnlyBand: readonly Channel[]
}

/**
 * Count what a change would open up, before it is applied.
 *
 * The single-channel editor has one switch and one channel, so the person
 * flipping it is looking at the frequency while they do it. A bulk edit has
 * neither: the selection survives the filter and the search box, so the rows it
 * covers need not be on screen at all. Nothing else in the app can answer "how
 * many of these are receive-only right now", and the diff before a write is too
 * late to ask - by then the selection is gone and forty rows moved together.
 *
 * Judged on the receive frequency. A receive-only channel has no transmit
 * frequency to ask about - `txFrequency` returns null for one, which is the
 * point of the flag - and whatever offset it carries becomes live the moment
 * transmit is allowed.
 */
export function transmitExposure(
  channels: readonly Channel[],
  change: BulkChange,
  bands: readonly BandLimit[],
): TransmitExposure {
  if (change.transmit !== 'allow') return { unlocked: [], inReceiveOnlyBand: [] }

  const unlocked = channels.filter((c) => !c.txAllowed)
  const inReceiveOnlyBand = unlocked.filter((c) => {
    const band = bands.find((b) => c.rxFreq >= b.loHz && c.rxFreq <= b.hiHz)
    // A frequency outside every band the radio covers is not counted here. It
    // is already a blocking `radio.band.rx-out-of-range` error, and repeating
    // it in a second voice would bury the one this panel is for.
    return band !== undefined && !band.txAllowed
  })

  return { unlocked, inReceiveOnlyBand }
}
