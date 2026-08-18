// SPDX-License-Identifier: GPL-3.0-or-later
import type { Hz, Milliwatts } from './units.js'
import type { TonePair } from './tones.js'

export type Modulation = 'FM' | 'AM' | 'USB' | 'LSB' | 'CW' | 'DMR' | 'DSTAR' | 'P25' | 'AUTO'

/** CHIRP's `Skip` column: '', 'S', 'P'. */
export type SkipMode = 'none' | 'skip' | 'pskip'

/**
 * Where the radio would transmit. Deliberately orthogonal to *whether* it may.
 *
 * CHIRP's `Duplex` column folds "off" in with "+"/"-"/"split", which admits
 * states that make no sense (an offset that means nothing) and, worse, lets an
 * exporter pattern-match three cases and forget the fourth. `txAllowed` on the
 * Channel is a separate boolean for exactly that reason - see the note there.
 */
export type TxSpec =
  | { readonly kind: 'simplex' }
  | { readonly kind: 'offset'; readonly direction: 'plus' | 'minus'; readonly offset: Hz }
  | { readonly kind: 'split'; readonly txFreq: Hz }

export interface PowerSpec {
  readonly mW: Milliwatts
  /** The radio's own name for this level ('High', 'Med', 'L1'), kept for display and round-trip. */
  readonly label?: string
}

/** Where a channel came from, so imported data can be traced and credited. */
export interface Provenance {
  readonly sourceId?: string
  readonly sourceLine?: number
  readonly attribution?: string
  readonly importedAt?: string
}

/** Radio-specific fields that have no cross-radio meaning. */
export interface UvK5Extras {
  scanList1: boolean
  scanList2: boolean
  compander: number
  scrambler: number
  busyChannelLockout: boolean
  freqReverse: boolean
  dtmfDecode: boolean
  dtmfPttId: number
  /** Which of the radio's seven sub-bands the attribute byte records. */
  band: number
  /** Raw step index, so an index this build does not recognise still round-trips. */
  stepIndex: number
}

export interface ChannelExtras {
  uvk5?: UvK5Extras
  /** Unknown columns from foreign sources. Preserved verbatim, never interpreted. */
  vendor?: Record<string, string>
}

export interface Channel {
  /** 1-based memory slot. */
  readonly index: number
  /** Radios with no name storage for a slot (the UV-K5's VFO pseudo-channels) leave this empty. */
  name: string
  rxFreq: Hz
  tx: TxSpec
  /**
   * The authoritative transmit gate.
   *
   * Kept separate from `TxSpec` so that no exporter can handle "where do I
   * transmit" while forgetting "may I transmit at all". A receive-only channel
   * that quietly becomes transmit-capable is the failure mode that puts a
   * public-safety or weather frequency into a radio someone can key up.
   */
  txAllowed: boolean
  /** Why transmit is disabled, for the UI to explain rather than just grey out. */
  txInhibitReason?: string
  tone: TonePair
  modulation: Modulation
  /**
   * Occupied bandwidth in hertz.
   *
   * Split out from modulation (CHIRP conflates them as FM/NFM, AM/NAM) because
   * the regulations are written as numbers: 47 CFR 95.2763 says "11.25 kHz",
   * not "narrow". Recomposing a CHIRP mode string is a pure function.
   */
  bandwidthHz: number
  power: PowerSpec
  tuningStep: Hz
  skip: SkipMode
  comment: string
  extras: ChannelExtras
  provenance?: Provenance
}

/** True when this slot holds no channel. */
export function isEmptyChannel(c: Channel | null | undefined): c is null | undefined {
  return c === null || c === undefined
}

/** The frequency this channel would actually transmit on. */
export function txFrequency(c: Channel): Hz | null {
  if (!c.txAllowed) return null
  switch (c.tx.kind) {
    case 'simplex':
      return c.rxFreq
    case 'split':
      return c.tx.txFreq
    case 'offset':
      return ((c.tx.direction === 'plus' ? c.rxFreq + c.tx.offset : c.rxFreq - c.tx.offset) as Hz)
  }
}

/** CHIRP's `Mode` string for this channel: FM/NFM, AM/NAM. */
export function chirpMode(c: Channel): string {
  const narrow = c.bandwidthHz > 0 && c.bandwidthHz <= 12_500
  switch (c.modulation) {
    case 'FM':
      return narrow ? 'NFM' : 'FM'
    case 'AM':
      return narrow ? 'NAM' : 'AM'
    default:
      return c.modulation
  }
}
