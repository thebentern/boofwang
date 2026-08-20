// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { PRESET_SETS, presetToChannel } from '#core/io/preset-data.js'

/**
 * The bundled sets are the one place boofwang puts frequencies into a radio
 * that the user did not type. A receive-only set that arrives transmit-capable
 * is the failure mode the whole `txAllowed` flag exists to prevent, so it is
 * guarded here rather than left to the screen that renders it.
 */
/** A fixed timestamp: nothing here depends on when the test runs. */
const WHEN = '2026-08-20T00:00:00.000Z'

describe('bundled presets', () => {
  const noaa = PRESET_SETS.find((s) => s.id === 'noaa')!

  it('ships the NOAA set with every channel receive-only', () => {
    // Transmitting on 162 MHz is unlawful. The set says so and the data has to
    // agree with the label - a chip that is only decoration is worse than none.
    expect(noaa.channels).toHaveLength(7)
    expect(noaa.channels.every((c) => c.txAllowed === false)).toBe(true)
  })

  it('keeps NOAA receive-only through the conversion into a channel', () => {
    // The screen converts a preset into a real Channel before staging it. That
    // is where a flag gets dropped, so it is checked on the far side.
    for (const [i, p] of noaa.channels.entries()) {
      const ch = presetToChannel(p, noaa, i + 1, null, WHEN)
      expect(ch.txAllowed, p.name).toBe(false)
      expect(ch.txInhibitReason, p.name).toBeTruthy()
    }
  })

  it('puts the NOAA channels on the real weather frequencies', () => {
    expect(noaa.channels.map((c) => c.rxFreq)).toEqual([
      162_400_000, 162_425_000, 162_450_000, 162_475_000, 162_500_000, 162_525_000, 162_550_000,
    ])
  })

  it('gives every set a description that does not overstate what it is', () => {
    for (const s of PRESET_SETS) {
      expect(s.channels.length, s.id).toBeGreaterThan(0)
      expect(s.description.length, s.id).toBeGreaterThan(20)
      expect(s.shortName, s.id).toBeTruthy()
    }
  })

  it('never leaves a receive-only channel without a reason to show the user', () => {
    // "Why can I not transmit here" has to be answerable everywhere a
    // receive-only channel appears, not just on the preset screen.
    for (const s of PRESET_SETS) {
      for (const [i, p] of s.channels.entries()) {
        if (p.txAllowed) continue
        const ch = presetToChannel(p, s, i + 1, null, WHEN)
        expect(ch.txInhibitReason, `${s.id} ${p.name}`).toBeTruthy()
      }
    }
  })

  it('gives GMRS all 30 of its channels and MURS its 5', () => {
    // 22 simplex channels plus the 8 repeater pairs, which is the full Part 95E
    // set - a GMRS licensee with a repeater needs the inputs too.
    expect(PRESET_SETS.find((s) => s.id === 'gmrs')!.channels).toHaveLength(30)
    expect(PRESET_SETS.find((s) => s.id === 'murs')!.channels).toHaveLength(5)
  })

  it('limits the 467 MHz interstitials to half a watt and narrowband', () => {
    // Channels 8-14 are FRS-only and capped at 0.5 W ERP with 12.5 kHz
    // bandwidth. A preset that ships them at 5 W is a rule violation boofwang
    // authored rather than inherited, so it is guarded.
    const gmrs = PRESET_SETS.find((s) => s.id === 'gmrs')!
    for (const n of [8, 9, 10, 11, 12, 13, 14]) {
      const ch = gmrs.channels.find((c) => c.name === `FRS ${n}`)
      expect(ch, `FRS ${n}`).toBeTruthy()
      expect(ch!.powerMW, `FRS ${n}`).toBeLessThanOrEqual(500)
      expect(ch!.bandwidthHz, `FRS ${n}`).toBeLessThanOrEqual(12_500)
    }
  })
})
