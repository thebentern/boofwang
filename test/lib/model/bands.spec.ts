// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BANDS, bandLegend, serviceFor } from '#core/model/bands.js'
import { encryptionLegality } from '#core/model/encryption.js'

/**
 * The band table, and the thing it exists to prevent.
 *
 * These ranges lived inside `encryptionLegality` until the channel list needed
 * them to colour a row edge. The whole point of moving them is that one table
 * cannot drift from itself, so the assertions that matter here are the ones
 * tying the two readers together rather than the ones restating the numbers.
 */

const mhz = (n: number) => n * 1e6

describe('serviceFor', () => {
  it('answers every service at a frequency inside it', () => {
    expect(serviceFor(mhz(146.52)).service).toBe('amateur')
    expect(serviceFor(mhz(446)).service).toBe('amateur')
    expect(serviceFor(mhz(462.5625)).service).toBe('GMRS/FRS')
    expect(serviceFor(mhz(467.6125)).service).toBe('GMRS/FRS')
    expect(serviceFor(mhz(151.82)).service).toBe('MURS')
    expect(serviceFor(mhz(162.55)).service).toBe('NOAA weather')
    expect(serviceFor(mhz(121.5)).service).toBe('air')
    expect(serviceFor(mhz(453.125)).service).toBe('land mobile')
  })

  it('puts GMRS before land mobile, because the ranges overlap', () => {
    /*
     * 462.5625 is inside the 450-470 land-mobile block as well as GMRS. Match
     * order is what decides, and getting it backwards would have coloured every
     * GMRS row as Part 90 and told the user encryption was permitted there.
     */
    expect(serviceFor(mhz(462.5625)).service).toBe('GMRS/FRS')
    expect(encryptionLegality(mhz(462.5625)).allowed).toBe(false)
  })

  it('treats MURS as five channels, not a range', () => {
    expect(serviceFor(mhz(151.88)).service).toBe('MURS')
    // Half a megahertz away is somebody else's assignment.
    expect(serviceFor(mhz(152.38)).service).not.toBe('MURS')
  })

  it('never returns null, because the last entry holds everything', () => {
    for (const f of [0.5, 27.185, 88.5, 300, 700, 1200, 5800]) {
      expect(serviceFor(mhz(f)).service, `${f} MHz`).toBeTruthy()
    }
  })

  it('marks receive-only services as such', () => {
    expect(serviceFor(mhz(162.475)).receiveOnly).toBe(true)
    expect(serviceFor(mhz(121.5)).receiveOnly).toBe(true)
    expect(serviceFor(mhz(146.52)).receiveOnly).toBe(false)
  })
})

/**
 * The anti-drift assertions. This is the file's reason to exist.
 */
describe('the legality notice and the row edge agree', () => {
  it('attributes the same service at every boundary either could disagree on', () => {
    const edges = [
      50, 54, 144, 148, 219, 225, 420, 450, 902, 928, // amateur
      462.5, 462.75, 467.5, 467.75, // GMRS/FRS
      151.82, 154.6, // MURS
      162.4, 162.55, // weather
      108, 137, // air
      49.9, 155, 453.125, // land mobile either side
    ]
    for (const f of edges) {
      expect(encryptionLegality(mhz(f)).service, `${f} MHz`).toBe(serviceFor(mhz(f)).service)
    }
  })

  it('forbids encryption on every service except land mobile', () => {
    // The direction that matters: a service gaining permission by accident.
    for (const b of BANDS) {
      const sample = b.service === 'land mobile' ? mhz(453.125) : null
      if (!sample) continue
      expect(encryptionLegality(sample).allowed).toBe(true)
    }
    for (const f of [146.52, 462.5625, 151.82, 162.475, 121.5]) {
      expect(encryptionLegality(mhz(f)).allowed, `${f} MHz`).toBe(false)
    }
  })

  it('has no band ranges left in encryption.ts', () => {
    /*
     * The extraction is only worth anything if the old copy is gone. A stray
     * `mhz >= 462.5` there would compile, pass every test above, and drift the
     * day somebody corrects one table and not the other.
     */
    const src = readFileSync(fileURLToPath(new URL('../../../lib/model/encryption.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/mhz\s*[<>]=/)
    expect(src).toMatch(/serviceFor/)
  })
})

describe('the legend', () => {
  it('lists every service once, in match order', () => {
    const legend = bandLegend()
    expect(legend.map((b) => b.service)).toEqual([
      'amateur',
      'GMRS/FRS',
      'MURS',
      'NOAA weather',
      'air',
      'land mobile',
    ])
  })

  it('names a token for each, and they are the ones main.css defines', () => {
    const css = readFileSync(fileURLToPath(new URL('../../../app/assets/css/main.css', import.meta.url)), 'utf8')
    for (const b of bandLegend()) {
      expect(b.token, `${b.service} has no token`).toMatch(/^--band-/)
      // Defined in the dark block, the light block, and neutralised for print.
      const defs = css.match(new RegExp(`${b.token}:`, 'g')) ?? []
      expect(defs.length, `${b.token} is defined ${defs.length} times, expected 3`).toBe(3)
    }
  })

  it('gives every service a human range', () => {
    for (const b of bandLegend()) expect(b.range.length, b.service).toBeGreaterThan(4)
  })
})
