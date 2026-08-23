// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { ctcss, dtcs } from '#core/model/tones.js'
import { hz, mW } from '#core/model/units.js'
import { bulkPatch, isEmptyChange, transmitExposure, type BulkChange } from '#core/radio/bulk-edit.js'
import { RADIO_IDS, SCHEMAS } from '#core/radio/registry.js'
import type { Channel } from '#core/model/channel.js'
import type { BandLimit } from '#core/radio/schema.js'

/**
 * One instruction over many channels.
 *
 * The rule under test in most of these is the same one: a key the change does
 * not mention must not appear in the patch at all. Across a mixed selection -
 * which is the only kind worth a bulk edit - any key that leaks in flattens a
 * field on channels the user never had in mind, and the only evidence is a diff
 * of forty rows they are about to write to a radio.
 */

const BASE: Channel = {
  index: 7,
  name: 'REPEATER',
  rxFreq: hz(146_940_000),
  tx: { kind: 'offset', direction: 'minus', offset: hz(600_000) },
  txAllowed: true,
  tone: { rx: ctcss(1000), tx: ctcss(1000), rxInverted: false },
  modulation: 'FM',
  bandwidthHz: 25_000,
  power: { mW: mW(5000), label: 'High' },
  tuningStep: hz(12_500),
  skip: 'none',
  comment: '',
  extras: {},
}

const ch = (over: Partial<Channel> = {}): Channel => ({ ...BASE, ...over })

describe('an instruction that says nothing', () => {
  it('is empty', () => {
    expect(isEmptyChange({})).toBe(true)
  })

  it('produces a patch with no keys, so nothing is overwritten', () => {
    expect(bulkPatch(ch(), {})).toEqual({})
  })

  it('is not empty once one field is set, including one set to null', () => {
    expect(isEmptyChange({ rxTone: null })).toBe(false)
    expect(isEmptyChange({ skip: 'skip' })).toBe(false)
  })
})

describe('the fields that are simply written', () => {
  it('carries only what was asked for', () => {
    const patch = bulkPatch(ch(), { bandwidthHz: 12_500 })
    expect(patch).toEqual({ bandwidthHz: 12_500 })
  })

  it('writes a power level as both its value and the radio\'s own name for it', () => {
    const patch = bulkPatch(ch(), { power: { mW: mW(1000), label: 'Low' } })
    expect(patch.power).toEqual({ mW: 1000, label: 'Low' })
  })

  it('leaves the frequency, the shift and the name alone whatever else is set', () => {
    const patch = bulkPatch(ch(), {
      power: { mW: mW(1000), label: 'Low' },
      bandwidthHz: 12_500,
      modulation: 'FM',
      tuningStep: hz(25_000),
      skip: 'skip',
      rxTone: null,
      txTone: null,
      transmit: 'rx-only',
    })
    expect(patch).not.toHaveProperty('rxFreq')
    expect(patch).not.toHaveProperty('tx')
    expect(patch).not.toHaveProperty('name')
    expect(patch).not.toHaveProperty('index')
  })
})

describe('the transmit gate', () => {
  it('disables transmit and says why, so the table has something to show', () => {
    const patch = bulkPatch(ch(), { transmit: 'rx-only' })
    expect(patch.txAllowed).toBe(false)
    expect(patch.txInhibitReason).toBe('Marked receive-only')
  })

  it('enables transmit when asked', () => {
    const patch = bulkPatch(ch({ txAllowed: false }), { transmit: 'allow' })
    expect(patch.txAllowed).toBe(true)
  })

  /*
   * The one that matters. `txAllowed` absent from the patch is what stops a
   * spread from turning a receive-only channel transmit-capable on the way
   * past, which is the failure this whole form is arranged around.
   */
  it('says nothing about transmit when transmit was not mentioned', () => {
    const patch = bulkPatch(ch({ txAllowed: false }), { power: { mW: mW(1000), label: 'Low' } })
    expect(patch).not.toHaveProperty('txAllowed')
    expect({ ...ch({ txAllowed: false }), ...patch }.txAllowed).toBe(false)
  })
})

describe('tones', () => {
  it('clears one side and leaves the other exactly as it was', () => {
    const before = ch({ tone: { rx: ctcss(885), tx: dtcs(23, 'R'), rxInverted: false } })
    const patch = bulkPatch(before, { rxTone: null })

    expect(patch.tone!.rx).toBeNull()
    expect(patch.tone!.tx).toBe(before.tone.tx)
  })

  it('does not touch the pair at all when neither side was mentioned', () => {
    expect(bulkPatch(ch(), { skip: 'skip' })).not.toHaveProperty('tone')
  })

  /*
   * TSQL-R: squelch opens when the tone is *absent*. Carrying it onto a tone
   * somebody has just chosen makes a channel that goes silent exactly when the
   * repeater is talking, from a control that never mentioned inversion.
   */
  it('drops receive inversion along with the receive tone that carried it', () => {
    const before = ch({ tone: { rx: ctcss(885), tx: null, rxInverted: true } })
    expect(bulkPatch(before, { rxTone: ctcss(1000) }).tone!.rxInverted).toBe(false)
    expect(bulkPatch(before, { rxTone: null }).tone!.rxInverted).toBe(false)
  })

  it('keeps receive inversion when only the transmit tone is set', () => {
    const before = ch({ tone: { rx: ctcss(885), tx: null, rxInverted: true } })
    const patch = bulkPatch(before, { txTone: ctcss(1000) })

    expect(patch.tone!.rxInverted).toBe(true)
    expect(patch.tone!.rx).toBe(before.tone.rx)
  })

  it('replaces a DTCS code when a CTCSS tone is chosen, rather than merging them', () => {
    const before = ch({ tone: { rx: dtcs(125, 'N'), tx: null, rxInverted: false } })
    expect(bulkPatch(before, { rxTone: ctcss(1000) }).tone!.rx).toEqual({ kind: 'ctcss', deciHz: 1000 })
  })
})

describe('what allowing transmit would unlock', () => {
  const BANDS: readonly BandLimit[] = [
    { loHz: hz(108_000_000), hiHz: hz(136_999_999), label: 'Air', txAllowed: false },
    { loHz: hz(144_000_000), hiHz: hz(148_000_000), label: '2 m', txAllowed: true },
  ]

  const air = ch({ index: 1, rxFreq: hz(121_500_000), txAllowed: false })
  const twoMetres = ch({ index: 2, rxFreq: hz(146_520_000), txAllowed: false })
  const already = ch({ index: 3, rxFreq: hz(146_940_000), txAllowed: true })

  it('counts nothing while transmit is being left alone', () => {
    expect(transmitExposure([air, twoMetres], { power: { mW: mW(1000), label: 'Low' } }, BANDS)).toEqual({
      unlocked: [],
      inReceiveOnlyBand: [],
    })
  })

  it('counts nothing when the change is making channels receive-only instead', () => {
    expect(transmitExposure([already], { transmit: 'rx-only' }, BANDS).unlocked).toEqual([])
  })

  it('names the receive-only channels, and not the ones that already transmit', () => {
    const found = transmitExposure([air, twoMetres, already], { transmit: 'allow' }, BANDS)
    expect(found.unlocked.map((c) => c.index)).toEqual([1, 2])
  })

  it('separates out the ones the band plan forbids transmitting on', () => {
    const found = transmitExposure([air, twoMetres], { transmit: 'allow' }, BANDS)
    expect(found.inReceiveOnlyBand.map((c) => c.index)).toEqual([1])
  })

  it('leaves a frequency outside every band to the rule that already blocks it', () => {
    const nowhere = ch({ index: 4, rxFreq: hz(1_000_000), txAllowed: false })
    const found = transmitExposure([nowhere], { transmit: 'allow' }, BANDS)

    expect(found.unlocked.map((c) => c.index)).toEqual([4])
    expect(found.inReceiveOnlyBand).toEqual([])
  })
})

/**
 * Every radio's own values go through it, rather than the hand-written channel
 * above only. A schema whose power levels or bandwidths this could not express
 * would be a radio the form silently offers nothing for.
 */
describe.each(RADIO_IDS.map((id) => ({ id, schema: SCHEMAS[id]! })))('$id', ({ schema }) => {
  it('accepts every power level, bandwidth and step the schema declares', () => {
    for (const level of schema.rf.powerLevels) {
      expect(bulkPatch(ch(), { power: { mW: level.mW, label: level.label } }).power).toEqual({
        mW: level.mW,
        label: level.label,
      })
    }
    for (const b of schema.rf.bandwidths) {
      expect(bulkPatch(ch(), { bandwidthHz: b }).bandwidthHz).toBe(b)
    }
    for (const s of schema.rf.tuningSteps) {
      expect(bulkPatch(ch(), { tuningStep: s }).tuningStep).toBe(s)
    }
  })

  it('accepts every CTCSS tone the schema declares', () => {
    for (const deciHz of schema.rf.ctcssDeciHz) {
      const change: BulkChange = { rxTone: ctcss(deciHz), txTone: ctcss(deciHz) }
      expect(bulkPatch(ch(), change).tone).toEqual({
        rx: { kind: 'ctcss', deciHz },
        tx: { kind: 'ctcss', deciHz },
        rxInverted: false,
      })
    }
  })
})
