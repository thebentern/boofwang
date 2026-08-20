// SPDX-License-Identifier: GPL-3.0-or-later
import type { Channel, TxSpec } from '../model/channel.js'
import type { TonePair } from '../model/tones.js'
import { NO_TONE, ctcss } from '../model/tones.js'
import { kHz, mHz, mW, watts, type Hz, type Milliwatts } from '../model/units.js'
import { clampPower, type RadioSchema } from '../radio/schema.js'

/**
 * The bundled channel sets.
 *
 * Deliberately data rather than a generator: a band plan is a legal document
 * transcribed by hand, and a loop that emits `446.00625 + n * 12500` hides a
 * transcription error behind arithmetic that looks correct. Every frequency
 * here can be read off against the rule it came from, which is the only way
 * anyone can check it.
 *
 * Bandwidth and power are the numbers the *rules* set, not the numbers any
 * particular radio can produce. 47 CFR 95.1771 says 0.5 W on GMRS channels
 * 8-14; whether the radio on the cable can do 0.5 W is the driver's problem,
 * and `presetToChannel` clamps downwards so a preset can never ask a radio for
 * more power than the rule allows.
 */

export type PresetGroupId = 'us' | 'other' | 'saved'
export type PresetSource = 'Bundled' | 'Non-US' | 'Saved here'

export interface PresetChannel {
  readonly name: string
  readonly rxFreq: Hz
  readonly tx: TxSpec
  /**
   * Whether the rule permits transmitting at all.
   *
   * Held per channel rather than per set so a mixed set stays expressible, and
   * kept out of the UI's reach on purpose: nothing in the preset screen offers
   * to flip it. A NOAA channel that quietly became transmit-capable is the
   * failure this whole flag exists to prevent.
   */
  readonly txAllowed: boolean
  readonly tone: TonePair
  /** Authorised bandwidth in hertz, as the rules write it rather than as "wide"/"narrow". */
  readonly bandwidthHz: number
  /** The transmit limit the rule sets, before any radio is involved. */
  readonly powerMW: Milliwatts
}

export interface PresetSet {
  readonly id: string
  readonly group: PresetGroupId
  /** Full title, shown above the contents table. */
  readonly name: string
  /** What the library list calls it, where 214px is all the room there is. */
  readonly shortName: string
  readonly icon: string
  readonly source: PresetSource
  readonly description: string
  /** The document the frequencies were transcribed from, recorded on every staged channel. */
  readonly attribution: string
  /** Channel spacing the plan uses; the driver picks the nearest step it actually has. */
  readonly stepHz: Hz
  /** Why transmit is off, when it is. Shown by the channel editor instead of a bare grey field. */
  readonly receiveOnlyReason?: string
  readonly channels: readonly PresetChannel[]
}

// Authorised bandwidths, in hertz. Named because 11_250 and 12_500 are one
// digit apart and mean different rules.
const BW_25K = 25_000
const BW_20K = 20_000
const BW_16K = 16_000
const BW_12K5 = 12_500
const BW_11K25 = 11_250

/** A channel the rule lets you transmit on, receive and transmit on one frequency. */
function simplex(name: string, mhz: number, w: number, bandwidthHz: number, toneDeciHz?: number): PresetChannel {
  return {
    name,
    rxFreq: mHz(mhz),
    tx: { kind: 'simplex' },
    txAllowed: true,
    tone: toneDeciHz === undefined ? NO_TONE : { rx: null, tx: ctcss(toneDeciHz), rxInverted: false },
    bandwidthHz,
    powerMW: watts(w),
  }
}

/** Receive on `mhz`, transmit `offsetMHz` above it. */
function repeater(
  name: string,
  mhz: number,
  offsetMHz: number,
  w: number,
  bandwidthHz: number,
  toneDeciHz: number,
): PresetChannel {
  return {
    name,
    rxFreq: mHz(mhz),
    tx: { kind: 'offset', direction: 'plus', offset: mHz(offsetMHz) },
    txAllowed: true,
    tone: { rx: null, tx: ctcss(toneDeciHz), rxInverted: false },
    bandwidthHz,
    powerMW: watts(w),
  }
}

/** A channel that must never key up. Power is meaningless here and is stored as zero. */
function listenOnly(name: string, mhz: number, bandwidthHz: number): PresetChannel {
  return {
    name,
    rxFreq: mHz(mhz),
    tx: { kind: 'simplex' },
    txAllowed: false,
    tone: NO_TONE,
    bandwidthHz,
    powerMW: mW(0),
  }
}

const GMRS: PresetSet = {
  id: 'gmrs',
  group: 'us',
  name: 'GMRS — 15 channels + 8 repeater pairs',
  shortName: 'GMRS',
  icon: 'i-lucide-users',
  source: 'Bundled',
  description:
    'The Part 95E channels a GMRS licence covers: 1-7 and 15-22, which are shared with FRS and interoperate '
    + 'directly, plus the eight 462/467 MHz repeater pairs, which carry a 141.3 Hz tone by convention. '
    + 'Channels 8-14 are FRS-only and are not included.',
  attribution: '47 CFR 95 Subpart E',
  stepHz: kHz(12.5),
  channels: [
    // 1-7: the 462 MHz interstitials, shared with FRS, 5 W.
    simplex('GMRS 1', 462.5625, 5, BW_20K),
    simplex('GMRS 2', 462.5875, 5, BW_20K),
    simplex('GMRS 3', 462.6125, 5, BW_20K),
    simplex('GMRS 4', 462.6375, 5, BW_20K),
    simplex('GMRS 5', 462.6625, 5, BW_20K),
    simplex('GMRS 6', 462.6875, 5, BW_20K),
    simplex('GMRS 7', 462.7125, 5, BW_20K),
    // Channels 8-14 are deliberately absent. The 467 MHz interstitials are
    // FRS-only: a GMRS licensee may not transmit there at all, so a GMRS set
    // that carried them would be offering channels the licence does not cover.
    // Channels 1-7 and 15-22 are shared with FRS and interoperate directly.
    // 15-22: the main GMRS channels, 50 W.
    simplex('GMRS 15', 462.55, 50, BW_20K),
    simplex('GMRS 16', 462.575, 50, BW_20K),
    simplex('GMRS 17', 462.6, 50, BW_20K),
    simplex('GMRS 18', 462.625, 50, BW_20K),
    simplex('GMRS 19', 462.65, 50, BW_20K),
    simplex('GMRS 20', 462.675, 50, BW_20K),
    simplex('GMRS 21', 462.7, 50, BW_20K),
    simplex('GMRS 22', 462.725, 50, BW_20K),
    // The same eight channels through a repeater: +5 MHz input, travel tone.
    repeater('RPT 15', 462.55, 5, 50, BW_20K, 1413),
    repeater('RPT 16', 462.575, 5, 50, BW_20K, 1413),
    repeater('RPT 17', 462.6, 5, 50, BW_20K, 1413),
    repeater('RPT 18', 462.625, 5, 50, BW_20K, 1413),
    repeater('RPT 19', 462.65, 5, 50, BW_20K, 1413),
    repeater('RPT 20', 462.675, 5, 50, BW_20K, 1413),
    repeater('RPT 21', 462.7, 5, 50, BW_20K, 1413),
    repeater('RPT 22', 462.725, 5, 50, BW_20K, 1413),
  ],
}

const NOAA: PresetSet = {
  id: 'noaa',
  group: 'us',
  name: 'NOAA weather — 7 channels',
  shortName: 'NOAA weather',
  icon: 'i-lucide-triangle-alert',
  source: 'Bundled',
  description:
    'The seven NOAA Weather Radio frequencies. Every one is receive-only and is programmed with transmit '
    + 'disabled; transmitting on them is unlawful and the set cannot be imported any other way.',
  attribution: 'NOAA Weather Radio All Hazards',
  stepHz: kHz(25),
  receiveOnlyReason: 'NOAA Weather Radio is a receive-only service; transmitting on 162 MHz is unlawful.',
  channels: [
    listenOnly('NOAA 1', 162.4, BW_25K),
    listenOnly('NOAA 2', 162.425, BW_25K),
    listenOnly('NOAA 3', 162.45, BW_25K),
    listenOnly('NOAA 4', 162.475, BW_25K),
    listenOnly('NOAA 5', 162.5, BW_25K),
    listenOnly('NOAA 6', 162.525, BW_25K),
    listenOnly('NOAA 7', 162.55, BW_25K),
  ],
}

const MURS: PresetSet = {
  id: 'murs',
  group: 'us',
  name: 'MURS — 5 channels',
  shortName: 'MURS',
  icon: 'i-lucide-radio',
  source: 'Bundled',
  description:
    'The five MURS frequencies at 2 W. Channels 4 and 5 permit 20 kHz bandwidth; 1 through 3 are narrow by rule.',
  attribution: '47 CFR 95 Subpart J',
  stepHz: kHz(5),
  channels: [
    simplex('MURS 1', 151.82, 2, BW_11K25),
    simplex('MURS 2', 151.88, 2, BW_11K25),
    simplex('MURS 3', 151.94, 2, BW_11K25),
    simplex('MURS 4', 154.57, 2, BW_20K),
    simplex('MURS 5', 154.6, 2, BW_20K),
  ],
}

const BAND_2M: PresetSet = {
  id: 'band2m',
  group: 'us',
  name: '2 m band plan — ARRL',
  shortName: '2 m band plan',
  icon: 'i-lucide-antenna',
  source: 'Bundled',
  description:
    'Calling and simplex frequencies from the ARRL band plan. Repeater pairs are not included: those are local, '
    + 'and RepeaterBook import is the honest way to get them.',
  attribution: 'ARRL 2 m band plan',
  stepHz: kHz(5),
  channels: [
    simplex('CALL 2M', 146.52, 5, BW_16K),
    simplex('SIMPLEX 1', 146.55, 5, BW_16K),
    simplex('SIMPLEX 2', 146.58, 5, BW_16K),
    simplex('APRS', 144.39, 5, BW_16K),
  ],
}


const BAND_70CM: PresetSet = {
  id: 'band70cm',
  group: 'us',
  name: '70 cm band plan — ARRL',
  shortName: '70 cm band plan',
  icon: 'i-lucide-antenna',
  source: 'Bundled',
  description:
    'The national simplex frequency and the simplex channels above it. The ARRL plan calls 446.000 the '
    + 'national simplex frequency and shares 445-447 MHz between auxiliary links, repeaters and simplex by '
    + 'local option; the 25 kHz channels above 446.000 are convention rather than rule. Repeater pairs are '
    + 'local and belong in a CHIRP CSV import.',
  attribution: 'ARRL 70 cm band plan',
  stepHz: kHz(25),
  channels: [
    simplex('CALL 70CM', 446.0, 5, BW_16K),
    simplex('SIMPLEX 1', 446.025, 5, BW_16K),
    simplex('SIMPLEX 2', 446.05, 5, BW_16K),
    simplex('SIMPLEX 3', 446.075, 5, BW_16K),
    simplex('SIMPLEX 4', 446.1, 5, BW_16K),
    simplex('SIMPLEX 5', 446.125, 5, BW_16K),
    simplex('SIMPLEX 6', 446.15, 5, BW_16K),
    simplex('SIMPLEX 7', 446.175, 5, BW_16K),
  ],
}

const UK_PMR446: PresetSet = {
  id: 'ukpmr',
  group: 'other',
  name: 'UK PMR446 — 16 channels',
  shortName: 'UK PMR446',
  icon: 'i-lucide-globe',
  source: 'Non-US',
  description:
    'The sixteen analogue PMR446 channels used in the UK and EU, at the 0.5 W ERP limit. Offered alongside the '
    + 'US sets rather than chosen for you: nothing here reads your locale yet.',
  attribution: 'ECC Decision (15)05 / UK Interface Requirement 2030',
  stepHz: kHz(12.5),
  channels: [
    simplex('PMR 1', 446.00625, 0.5, BW_12K5),
    simplex('PMR 2', 446.01875, 0.5, BW_12K5),
    simplex('PMR 3', 446.03125, 0.5, BW_12K5),
    simplex('PMR 4', 446.04375, 0.5, BW_12K5),
    simplex('PMR 5', 446.05625, 0.5, BW_12K5),
    simplex('PMR 6', 446.06875, 0.5, BW_12K5),
    simplex('PMR 7', 446.08125, 0.5, BW_12K5),
    simplex('PMR 8', 446.09375, 0.5, BW_12K5),
    simplex('PMR 9', 446.10625, 0.5, BW_12K5),
    simplex('PMR 10', 446.11875, 0.5, BW_12K5),
    simplex('PMR 11', 446.13125, 0.5, BW_12K5),
    simplex('PMR 12', 446.14375, 0.5, BW_12K5),
    simplex('PMR 13', 446.15625, 0.5, BW_12K5),
    simplex('PMR 14', 446.16875, 0.5, BW_12K5),
    simplex('PMR 15', 446.18125, 0.5, BW_12K5),
    simplex('PMR 16', 446.19375, 0.5, BW_12K5),
  ],
}

export const PRESET_SETS: readonly PresetSet[] = [GMRS, NOAA, MURS, BAND_2M, BAND_70CM, UK_PMR446]

/**
 * The library's headings, in order.
 *
 * `saved` is listed even though nothing fills it yet: the group is where a
 * saved set will appear, and an empty heading that says so is more useful than
 * a heading that materialises the first time something is saved.
 */
export const PRESET_GROUPS: readonly { readonly id: PresetGroupId; readonly label: string }[] = [
  { id: 'us', label: 'United States' },
  { id: 'other', label: 'Other regions' },
  { id: 'saved', label: 'Saved in this browser' },
]

/** How a preset channel reads in one line: `GMRS 16 · 462.57500 · 141.3`. */
export function presetLine(p: PresetChannel): string {
  const parts = [p.name, (p.rxFreq / 1e6).toFixed(5)]
  if (p.tone.tx?.kind === 'ctcss') parts.push((p.tone.tx.deciHz / 10).toFixed(1))
  if (!p.txAllowed) parts.push('RX only')
  return parts.join(' · ')
}

/**
 * A preset channel as an editable channel in a particular slot.
 *
 * Power is clamped to a level the radio actually has, downwards: a 50 W GMRS
 * channel staged onto a 5 W handheld must become 5 W, never stay a promise the
 * radio cannot keep and never round up. The name is cut to the radio's field
 * length here rather than at write time, so what the table shows is what the
 * radio will hold.
 */
export function presetToChannel(
  source: PresetChannel,
  set: PresetSet,
  index: number,
  schema: RadioSchema | null,
  importedAt: string,
): Channel {
  const level = schema ? clampPower(schema, source.powerMW) : null
  return {
    index,
    name: schema ? source.name.slice(0, schema.memory.nameLength) : source.name,
    rxFreq: source.rxFreq,
    tx: source.tx,
    txAllowed: source.txAllowed,
    ...(source.txAllowed
      ? {}
      : { txInhibitReason: set.receiveOnlyReason ?? 'This channel is receive-only in the set it came from.' }),
    tone: source.tone,
    modulation: 'FM',
    bandwidthHz: source.bandwidthHz,
    power: level === null ? { mW: source.powerMW } : { mW: level.mW, label: level.label },
    tuningStep: set.stepHz,
    skip: 'none',
    comment: '',
    extras: {},
    provenance: { sourceId: set.id, attribution: set.attribution, importedAt },
  }
}
