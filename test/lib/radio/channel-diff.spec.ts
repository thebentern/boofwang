// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { diffChannels, describeChannel } from '#core/radio/channel-diff.js'
import { emptyCodeplug, type Channel, type Codeplug } from '#core/model/index.js'
import { NO_TONE } from '#core/model/tones.js'
import { hz, mW } from '#core/model/units.js'

function channel(over: Partial<Channel> & { index: number }): Channel {
  return {
    name: 'CH',
    rxFreq: hz(145_500_000),
    tx: { kind: 'simplex' },
    txAllowed: true,
    tone: NO_TONE,
    modulation: 'FM',
    bandwidthHz: 12_500,
    power: { mW: mW(5000), label: 'High' },
    tuningStep: hz(5000),
    skip: 'none',
    comment: '',
    extras: {},
    ...over,
  }
}

function plug(channels: Channel[]): Codeplug {
  const cp = emptyCodeplug('uvk5', '2026-08-20T00:00:00.000Z')
  for (const c of channels) cp.channels.set(c.index, c)
  return cp
}

describe('diffChannels', () => {
  it('reports nothing when nothing changed', () => {
    const a = plug([channel({ index: 1 })])
    const b = plug([channel({ index: 1 })])
    expect(diffChannels(a, b).changes).toEqual([])
  })

  it('calls out a channel gaining transmit by name', () => {
    // The reason this module exists. A receive-only channel becoming
    // transmit-capable is invisible in a byte count and is the failure that
    // puts a weather or public-safety frequency into a radio someone can key.
    const before = plug([channel({ index: 3, txAllowed: false })])
    const after = plug([channel({ index: 3, txAllowed: true })])
    const d = diffChannels(before, after)

    expect(d.gainsTransmit).toBe(1)
    expect(d.changes[0]!.kind).toBe('gain')
    expect(d.changes[0]!.note).toBe('gains-transmit')
  })

  it('does not call an ordinary edit a gain', () => {
    const before = plug([channel({ index: 1, name: 'OLD' })])
    const after = plug([channel({ index: 1, name: 'NEW' })])
    const d = diffChannels(before, after)
    expect(d.changes[0]!.kind).toBe('edit')
    expect(d.gainsTransmit).toBe(0)
  })

  it('marks an erased slot, and counts a receive-only one as lost', () => {
    const before = plug([channel({ index: 5, txAllowed: false })])
    const after = plug([])
    const d = diffChannels(before, after)
    expect(d.changes[0]!.kind).toBe('erase')
    expect(d.changes[0]!.note).toBe('slot-cleared')
    expect(d.erased).toBe(1)
    expect(d.receiveOnlyLost).toBe(1)
  })

  it('marks a newly programmed slot as an addition', () => {
    const d = diffChannels(plug([]), plug([channel({ index: 9 })]))
    expect(d.changes[0]!.kind).toBe('add')
    expect(d.changes[0]!.before).toBe('')
  })

  it('notices a channel losing transmit', () => {
    const before = plug([channel({ index: 2, txAllowed: true })])
    const after = plug([channel({ index: 2, txAllowed: false })])
    expect(diffChannels(before, after).changes[0]!.note).toBe('loses-transmit')
  })

  it('sorts by slot so the list reads like the table', () => {
    const before = plug([channel({ index: 9 }), channel({ index: 2 })])
    const after = plug([channel({ index: 9, name: 'X' }), channel({ index: 2, name: 'Y' })])
    expect(diffChannels(before, after).changes.map((c) => c.slot)).toEqual([2, 9])
  })

  it('sees a change in any field the radio stores', () => {
    const fields: Partial<Channel>[] = [
      { rxFreq: hz(146_000_000) },
      { modulation: 'AM' },
      { bandwidthHz: 25_000 },
      { power: { mW: mW(1000), label: 'Low' } },
      { skip: 'skip' },
      { tx: { kind: 'offset', direction: 'minus', offset: hz(600_000) } },
    ]
    for (const f of fields) {
      const d = diffChannels(plug([channel({ index: 1 })]), plug([channel({ index: 1, ...f })]))
      expect(d.changed, JSON.stringify(f)).toBe(1)
    }
  })
})

describe('describeChannel', () => {
  it('says when a channel is receive-only', () => {
    expect(describeChannel(channel({ index: 1, txAllowed: false }))).toContain('RX only')
  })

  it('shows the computed transmit frequency for a repeater shift', () => {
    // Slot 1 at 145.23 with -0.600 transmits on 144.63.
    const c = channel({
      index: 1,
      name: '',
      rxFreq: hz(145_230_000),
      tx: { kind: 'offset', direction: 'minus', offset: hz(600_000) },
    })
    expect(describeChannel(c)).toBe('145.23000 → 144.63000')
  })

  it('leaves a simplex channel without an arrow', () => {
    expect(describeChannel(channel({ index: 1, name: 'S' }))).toBe('S · 145.50000')
  })
})
