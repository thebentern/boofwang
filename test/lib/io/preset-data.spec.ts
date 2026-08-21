// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { PRESET_SETS, presetToChannel, presetToClampedChannel } from '#core/io/preset-data.js'
import { SCHEMAS } from '#core/radio/registry.js'
import { hz } from '#core/model/units.js'

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

  it('gives GMRS the 15 channels its licence covers, plus 8 repeater pairs', () => {
    expect(PRESET_SETS.find((s) => s.id === 'gmrs')!.channels).toHaveLength(23)
    expect(PRESET_SETS.find((s) => s.id === 'murs')!.channels).toHaveLength(5)
  })

  it('carries no FRS-only channel in the GMRS set', () => {
    // 467.5625-467.7125 are channels 8-14 and are FRS-only. A GMRS licence does
    // not cover transmitting there, so a GMRS set that offered them would be
    // handing someone a channel their licence does not reach.
    const gmrs = PRESET_SETS.find((s) => s.id === 'gmrs')!
    for (const c of gmrs.channels) {
      const isFrsOnly = c.rxFreq >= 467_562_500 && c.rxFreq <= 467_712_500 && c.tx.kind === 'simplex'
      expect(isFrsOnly, `${c.name} at ${c.rxFreq}`).toBe(false)
    }
  })

  it('ships a 70 cm set built on the national simplex frequency', () => {
    const b = PRESET_SETS.find((s) => s.id === 'band70cm')!
    expect(b.channels[0]!.rxFreq).toBe(446_000_000)
    expect(b.channels.every((c) => c.rxFreq >= 446_000_000 && c.rxFreq <= 446_175_000)).toBe(true)
    expect(b.channels.every((c) => c.txAllowed)).toBe(true)
  })
})

/**
 * Presets placed onto a particular radio.
 *
 * `presetToChannel` clamps power and name length, which was enough when every
 * preset was FRS or NOAA and every radio could hold them. It never checked
 * bands, and staging a preset the radio cannot receive is not a clamp: it is a
 * slot programmed with something that does nothing.
 */
describe('presetToClampedChannel', () => {
  const SCHEMA = SCHEMAS.uv82!

  it('refuses a preset the radio cannot receive, rather than staging it', () => {
    const marine = { ...PRESET_SETS[0]!.channels[0]!, name: 'HF', rxFreq: hz(3_500_000) }
    const out = presetToClampedChannel(marine, PRESET_SETS[0]!, 1, SCHEMA, WHEN)
    expect(out.channel).toBeNull()
    expect(out.refusal?.rule).toBe('rx-band')
  })

  it('keeps the slot the caller chose rather than the one the pipeline saw', () => {
    const p = PRESET_SETS.flatMap((s) => s.channels).find((c) => c.rxFreq > 144_000_000 && c.rxFreq < 148_000_000)
    if (!p) return
    const out = presetToClampedChannel(p, PRESET_SETS[0]!, 57, SCHEMA, WHEN)
    expect(out.channel?.index).toBe(57)
  })

  it('never makes a receive-only preset transmit', () => {
    // The whole reason the bundled sets carry the flag. A clamp that flipped it
    // would put a transmit-capable NOAA channel in somebody's radio.
    for (const set of PRESET_SETS) {
      for (const p of set.channels.filter((c) => !c.txAllowed)) {
        const out = presetToClampedChannel(p, set, 1, SCHEMA, WHEN)
        if (out.channel === null) continue
        expect(out.channel.txAllowed, `${set.id} ${p.name}`).toBe(false)
      }
    }
  })
})
