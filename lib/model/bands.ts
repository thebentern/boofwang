// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Which US radio service a receive frequency falls in.
 *
 * Extracted from `encryptionLegality`, which owned these ranges alone and is
 * now a caller. Nothing here is a new band plan: the allocations are the ones
 * that function already asked about, in the order it asked them, plus the air
 * band that the UV-K5 and UV-5R Mini schemas mark receive-only AM in their
 * comments.
 *
 * The reason it moved is that a second reader appeared. The channel list draws
 * a service-colored edge on every row, and two copies of "is this GMRS" would
 * drift - one of them silently, because a row edge being the wrong hue looks
 * like a design choice while the legality notice being wrong is a license
 * problem. One table, two readers.
 *
 * Order matters and is load-bearing. The ranges are not disjoint in practice -
 * a GMRS channel sits inside the 450-470 land-mobile block - so the first
 * match wins, and the specific services are asked about before the catch-all.
 */

/** The services a frequency can be attributed to, most specific first. */
export type BandService = 'amateur' | 'GMRS/FRS' | 'MURS' | 'NOAA weather' | 'air' | 'land mobile'

export interface BandInfo {
  readonly service: BandService
  /** Human range, for a legend. Not parsed. */
  readonly range: string
  /** The CSS custom property carrying this service's edge color. */
  readonly token: string
  /**
   * True where the service itself is receive-only, regardless of what the
   * radio's own band table permits. Weather and the air band are not
   * transmitting services for anyone reading this.
   */
  readonly receiveOnly: boolean
}

const MURS_CENTERS = [151.82, 151.88, 151.94, 154.57, 154.6] as const

/** Within a kilohertz. MURS is five discrete channels, not a range. */
const MURS_TOLERANCE_MHZ = 0.001

/**
 * The table, in match order.
 *
 * `land mobile` is last and matches everything, so `bandFor` never returns
 * null and no caller needs a fallback branch.
 */
export const BANDS: readonly (BandInfo & { readonly holds: (mhz: number) => boolean })[] = [
  {
    service: 'amateur',
    range: '50-54 · 144-148 · 219-225 · 420-450 · 902-928 MHz',
    token: '--band-amateur',
    receiveOnly: false,
    holds: (mhz) =>
      (mhz >= 50 && mhz <= 54) ||
      (mhz >= 144 && mhz <= 148) ||
      (mhz >= 219 && mhz <= 225) ||
      (mhz >= 420 && mhz <= 450) ||
      (mhz >= 902 && mhz <= 928),
  },
  {
    service: 'GMRS/FRS',
    range: '462.5-462.75 · 467.5-467.75 MHz',
    token: '--band-gmrs',
    receiveOnly: false,
    holds: (mhz) => (mhz >= 462.5 && mhz <= 462.75) || (mhz >= 467.5 && mhz <= 467.75),
  },
  {
    service: 'MURS',
    range: '151.82 · 151.88 · 151.94 · 154.57 · 154.60 MHz',
    token: '--band-murs',
    receiveOnly: false,
    holds: (mhz) => MURS_CENTERS.some((f) => Math.abs(mhz - f) < MURS_TOLERANCE_MHZ),
  },
  {
    service: 'NOAA weather',
    range: '162.40-162.55 MHz, receive only',
    token: '--band-noaa',
    receiveOnly: true,
    holds: (mhz) => mhz >= 162.4 && mhz <= 162.55,
  },
  {
    /*
     * The air band, which `encryptionLegality` never asked about because a
     * frequency there was already answered by the land-mobile catch-all and
     * the answer happened to be harmless. It is called out now because the row
     * edge has to name a service, and "land mobile" for 121.5 MHz would be
     * wrong on screen in a way it never was in a legality sentence.
     */
    service: 'air',
    range: '108-137 MHz, AM, receive only',
    token: '--band-air',
    receiveOnly: true,
    holds: (mhz) => mhz >= 108 && mhz <= 137,
  },
  {
    service: 'land mobile',
    range: 'Everything else, Part 90',
    token: '--band-landmobile',
    receiveOnly: false,
    holds: () => true,
  },
]

/**
 * The service `hz` falls in. Never null: the last entry matches everything.
 *
 * Takes hertz rather than megahertz because that is what the rest of the model
 * carries, and converts once here so no caller has to remember which unit this
 * table is written in.
 */
export function serviceFor(hz: number): BandInfo {
  const mhz = hz / 1e6
  for (const b of BANDS) if (b.holds(mhz)) return b
  // Unreachable: `land mobile` holds everything. Kept so the return type needs
  // no assertion and a table edited into a state with no catch-all fails loudly
  // here rather than returning undefined into a color lookup.
  throw new Error(`no band matched ${hz} Hz, which means the band table lost its catch-all`)
}

/** Every service, for a legend. Match order, which is also specific-to-general. */
export function bandLegend(): readonly BandInfo[] {
  return BANDS.map(({ service, range, token, receiveOnly }) => ({ service, range, token, receiveOnly }))
}
