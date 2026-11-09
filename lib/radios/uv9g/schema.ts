// SPDX-License-Identifier: GPL-3.0-or-later
import { hz, mW } from '../../model/units.js'
import type { RadioSchema } from '../../radio/schema.js'
import { POWER_RAW, VALID_BANDS } from '../uv9r/layout.js'
import { wp970iSchema } from '../uv9r/schema.js'

export const UV9G_SCHEMA: RadioSchema = wp970iSchema({
  id: 'uv9g',
  vendor: 'Baofeng',
  model: 'UV-9G',
  aliases: [],
  /*
   * A GMRS band plan, in the order `bandFor` searches: the two transmit
   * windows first, the receive spans after, because every consumer takes the
   * first band that contains a frequency. The UV-5G's plan, for the same
   * reason.
   *
   * This is the license's rule, and the schema does not claim it is the
   * radio's. CHIRP's `UV9G` sets `_gmrs = False` with the comment "sold as
   * GMRS radio but supports full band TX/RX", and CHIRP's own test image of
   * one holds band limits of 136-174 and 400-520 MHz, both enabled. So unlike
   * the UV-5G, nothing here rests on a firmware that refuses to transmit
   * outside GMRS. Transmitting outside the windows draws the regulatory
   * warning and nothing more: the license is the operator's.
   *
   * The receive spans are CHIRP's `VALID_BANDS`, which `UV9G` inherits.
   */
  bands: [
    { loHz: hz(462_550_000), hiHz: hz(462_725_000), label: 'GMRS 462 MHz', txAllowed: true },
    { loHz: hz(467_550_000), hiHz: hz(467_725_000), label: 'GMRS 467 MHz', txAllowed: true },
    ...VALID_BANDS.map(([lo, hi]) => ({
      loHz: hz(lo),
      hiHz: hz(hi),
      label: `${lo / 1e6}-${hi / 1e6} MHz`,
      txAllowed: false,
    })),
  ],
  powerLevels: [
    // `POWER_LEVELS` on `UV9G`: 5 W, 1 W and 0.5 W. The labels are CHIRP's;
    // only the two-bit selector is stored. The factory programs the 467 MHz
    // interstitials with selector 1, which CHIRP calls 1 W - twice what Part
    // 95 allows on those channels - and nothing here can measure which is
    // wrong. See docs/protocols/uv9g.md.
    { id: 'high', label: 'High', mW: mW(5000), raw: POWER_RAW.high },
    { id: 'med', label: 'Med', mW: mW(1000), raw: POWER_RAW.med },
    { id: 'low', label: 'Low', mW: mW(500), raw: POWER_RAW.low },
  ],
})
