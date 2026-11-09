// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { TxSpec } from '#core/model/channel.js'
import { shiftFormOf, txSpecOf } from '#core/model/shift-form.js'
import { hz } from '#core/model/units.js'

/**
 * The channel editor's Shift control, round-tripped.
 *
 * A form nobody touched has to give back the transmit side it was opened on.
 * That is the whole of the defect this exists for: the editor opened a split
 * channel as simplex, and Apply - for a rename - wrote it back as simplex,
 * moving where the channel transmits without a word.
 */
const RX = hz(146_520_000)

describe('a transmit side opened in the editor and applied untouched', () => {
  it('comes back as it went in, for every kind', () => {
    const sides: TxSpec[] = [
      { kind: 'simplex' },
      { kind: 'offset', direction: 'plus', offset: hz(600_000) },
      { kind: 'offset', direction: 'minus', offset: hz(5_000_000) },
      { kind: 'split', txFreq: hz(147_120_000) },
    ]
    for (const tx of sides) expect(txSpecOf(shiftFormOf(tx, RX))).toEqual(tx)
  })

  it('keeps a split as a split, which the editor used to drop', () => {
    const form = shiftFormOf({ kind: 'split', txFreq: hz(446_000_000) }, RX)
    expect(form.shift).toBe('split')
    expect(txSpecOf(form)).toEqual({ kind: 'split', txFreq: hz(446_000_000) })
  })

  it('holds to the hertz for any frequencies', () => {
    const freq = fc.integer({ min: 1, max: 1_300_000_000 }).map((n) => hz(n))
    const side: fc.Arbitrary<TxSpec> = fc.oneof(
      fc.constant<TxSpec>({ kind: 'simplex' }),
      fc
        .record({ direction: fc.constantFrom('plus' as const, 'minus' as const), offset: freq })
        .map((o): TxSpec => ({ kind: 'offset', ...o })),
      freq.map((txFreq): TxSpec => ({ kind: 'split', txFreq })),
    )
    fc.assert(
      fc.property(side, freq, (tx, rx) => {
        expect(txSpecOf(shiftFormOf(tx, rx))).toEqual(tx)
      }),
    )
  })
})

describe('switching the shift', () => {
  it('starts a split at where the channel transmits now', () => {
    // Not at zero: an emptied field parses as 0 Hz.
    expect(shiftFormOf({ kind: 'simplex' }, RX).txFreq).toBe('146.520000')
    expect(shiftFormOf({ kind: 'offset', direction: 'plus', offset: hz(600_000) }, RX).txFreq).toBe('147.120000')
    expect(shiftFormOf({ kind: 'offset', direction: 'minus', offset: hz(600_000) }, RX).txFreq).toBe('145.920000')
  })

  it('starts an offset at the distance a split covers', () => {
    expect(shiftFormOf({ kind: 'split', txFreq: hz(141_520_000) }, RX).offset).toBe('5.000000')
  })

  it('reads only the field the shift uses', () => {
    // A stale offset under a split cannot stop a save, or leak into one.
    expect(txSpecOf({ shift: 'split', offset: 'not a number', txFreq: '147.000' })).toEqual({
      kind: 'split',
      txFreq: hz(147_000_000),
    })
    expect(txSpecOf({ shift: 'plus', offset: '0.6', txFreq: 'garbage' })).toEqual({
      kind: 'offset',
      direction: 'plus',
      offset: hz(600_000),
    })
    expect(txSpecOf({ shift: 'simplex', offset: 'x', txFreq: 'y' })).toEqual({ kind: 'simplex' })
  })

  it('throws on a field the shift reads and cannot parse', () => {
    expect(() => txSpecOf({ shift: 'split', offset: '0', txFreq: '14x' })).toThrow(RangeError)
    expect(() => txSpecOf({ shift: 'minus', offset: 'abc', txFreq: '0' })).toThrow(RangeError)
  })
})
