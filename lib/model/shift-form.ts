// SPDX-License-Identifier: GPL-3.0-or-later
import type { TxSpec } from './channel.js'
import { formatFreq, hz, parseFreq, type Hz } from './units.js'

/**
 * The channel editor's Shift control: a `TxSpec` out to text, and back.
 *
 * Here rather than in the component because the component lost one. It knew
 * simplex, plus and minus, and opened a split channel - which a CHIRP CSV
 * brings in, and five of the six radios store - as simplex, so Apply, even for
 * a rename, threw the transmit frequency away and left the channel keying up
 * on its receive frequency. Nothing said so: the channel looked edited, not
 * changed. Both functions switch over every kind with no default, so a fourth
 * kind of `TxSpec` is a type error here instead of the same defect again, and
 * `shift-form.spec.ts` round-trips the ones there are.
 */

export type ShiftChoice = 'simplex' | 'plus' | 'minus' | 'split'

export interface ShiftForm {
  readonly shift: ShiftChoice
  /** The offset field, read for plus and minus. */
  readonly offset: string
  /** The transmit field, read for split. */
  readonly txFreq: string
}

/**
 * A transmit side as the editor's fields show it.
 *
 * Both fields are filled whatever the shift, from where the channel transmits
 * now, so switching to split starts at the current transmit frequency rather
 * than at zero - `parseFreq` reads an empty field as 0 Hz, and a split offered
 * that is one Apply away from transmitting on nothing.
 */
export function shiftFormOf(tx: TxSpec, rxFreq: Hz): ShiftForm {
  switch (tx.kind) {
    case 'simplex':
      return { shift: 'simplex', offset: formatFreq(hz(0)), txFreq: formatFreq(rxFreq) }
    case 'offset':
      return {
        shift: tx.direction,
        offset: formatFreq(tx.offset),
        txFreq: formatFreq(hz(tx.direction === 'plus' ? rxFreq + tx.offset : rxFreq - tx.offset)),
      }
    case 'split':
      return { shift: 'split', offset: formatFreq(hz(Math.abs(tx.txFreq - rxFreq))), txFreq: formatFreq(tx.txFreq) }
  }
}

/**
 * The fields back into a transmit side.
 *
 * Throws, as `parseFreq` does, when the field the shift reads does not parse.
 * The other field is never read, so a stale offset under a split cannot stop
 * a save, and cannot leak into one.
 */
export function txSpecOf(form: ShiftForm): TxSpec {
  switch (form.shift) {
    case 'simplex':
      return { kind: 'simplex' }
    case 'plus':
    case 'minus':
      return { kind: 'offset', direction: form.shift, offset: parseFreq(form.offset) }
    case 'split':
      return { kind: 'split', txFreq: parseFreq(form.txFreq) }
  }
}
