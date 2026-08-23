// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { emptyCodeplug, type Codeplug } from '#core/model/index.js'
import type { FleetOutcome, FleetUnit } from '#core/radio/fleet.js'
import { useFleetStore } from '~/stores/fleet'

/**
 * The run's bookkeeping, exercised through the store rather than around it.
 *
 * Two of these were written after the behaviour was wrong on screen. The roster
 * was validated against a schema the store only learned about when the run
 * started, so a roster with two radios on one DMR ID - the single failure this
 * whole feature exists to prevent - sat there with no complaint and started the
 * run. And the master was taken from the editor, which the first read replaces,
 * so it had to be a copy rather than a reference for reasons no type can state.
 */
const FACTS = { title: 'Club', variant: 'DM32.01.01.040', channels: 45, zones: 4, talkGroups: 6, keys: 0 }

const row = (over: Partial<FleetUnit> & { id: string }): FleetUnit => ({
  label: over.id,
  dmrId: 2_345_678,
  name: 'M0AAA',
  ...over,
})

const outcome = (over: Partial<FleetOutcome> = {}): FleetOutcome => ({
  state: 'written',
  at: '2026-08-23T09:00:00.000Z',
  unitHash: 'cal-aaaa',
  blocks: 4,
  note: '',
  ...over,
})

function master(): Codeplug {
  const cp = emptyCodeplug('dm32uv', '2026-08-23T09:00:00.000Z')
  cp.zones = [{ id: 'z1', name: 'CLUB', channels: [1] }]
  cp.radioIds = [{ id: 'rid-1', name: 'G0SEC', dmrId: 2_341_001 }]
  return cp
}

beforeEach(() => setActivePinia(createPinia()))

describe('checking the roster', () => {
  it('complains about a duplicate DMR ID before the run starts', () => {
    const fleet = useFleetStore()
    fleet.setRadio('dm32uv')
    fleet.setRoster([row({ id: 'a', label: 'Dave' }), row({ id: 'b', label: 'Sam' })])

    expect(fleet.errors.map((p) => p.ruleId)).toContain('fleet.id.duplicate')
  })

  it('says nothing at all until it knows which radio the roster is for', () => {
    // Not a silent pass: without a schema there is no answer to "may a DMR ID
    // be this large", and inventing one would be worse than waiting.
    const fleet = useFleetStore()
    fleet.setRoster([row({ id: 'a' }), row({ id: 'b' })])

    expect(fleet.problems).toEqual([])
  })

  it('keeps the run’s own radio once one is under way', () => {
    const fleet = useFleetStore()
    fleet.setRadio('dm32uv')
    fleet.setRoster([row({ id: 'a' })])
    fleet.startRun(master(), 'dm32uv', FACTS)

    fleet.setRadio('uvk5')

    expect(fleet.radio).toBe('dm32uv')
  })
})

describe('holding the master through a run', () => {
  it('copies it, so editing the document the run started from does not follow', () => {
    // The first read replaces the editor's document with that handset's. If the
    // master were a reference into the editor it would not survive that, and
    // every radio after the first would be given its predecessor's codeplug.
    const fleet = useFleetStore()
    const doc = master()
    fleet.startRun(doc, 'dm32uv', FACTS)

    doc.zones[0]!.name = 'CHANGED'
    doc.radioIds = []

    expect(fleet.master?.zones.map((z) => z.name)).toEqual(['CLUB'])
    expect(fleet.master?.radioIds).toEqual([{ id: 'rid-1', name: 'G0SEC', dmrId: 2_341_001 }])
  })

  it('carries the channel map across the copy', () => {
    // `structuredClone` handles a Map and `JSON` does not, which is the kind of
    // thing that is fine until somebody simplifies it.
    const fleet = useFleetStore()
    const doc = master()
    doc.channels.set(1, { index: 1 } as never)
    fleet.startRun(doc, 'dm32uv', FACTS)

    expect(fleet.master?.channels.get(1)).toEqual({ index: 1 })
  })
})

describe('the queue', () => {
  it('leaves a failed row to be tried again and takes a written one out', () => {
    const fleet = useFleetStore()
    fleet.setRadio('dm32uv')
    fleet.setRoster([row({ id: 'a', dmrId: 1 }), row({ id: 'b', dmrId: 2 }), row({ id: 'c', dmrId: 3 })])

    fleet.record('a', outcome())
    fleet.record('b', outcome({ state: 'failed', unitHash: 'cal-bbbb' }))
    fleet.record('c', outcome({ state: 'skipped', unitHash: 'cal-cccc' }))

    expect(fleet.pending.map((u) => u.id)).toEqual(['b'])
    expect(fleet.written.map((u) => u.id)).toEqual(['a'])
    expect(fleet.skipped.map((u) => u.id)).toEqual(['c'])
  })

  it('puts a row back, and releases the handset that took it', () => {
    const fleet = useFleetStore()
    fleet.setRadio('dm32uv')
    fleet.setRoster([row({ id: 'a', dmrId: 1 })])
    fleet.record('a', outcome())

    fleet.reopen('a')

    expect(fleet.pending.map((u) => u.id)).toEqual(['a'])
    expect(fleet.outcomes).toEqual({})
  })

  it('forgets the run’s record when the roster is replaced', () => {
    // A pasted roster is a different list of radios. Keeping outcomes keyed by
    // ids that now mean other people would report the wrong handsets as done.
    const fleet = useFleetStore()
    fleet.setRadio('dm32uv')
    fleet.setRoster([row({ id: 'a', dmrId: 1 })])
    fleet.record('a', outcome())

    fleet.setRoster([row({ id: 'a', dmrId: 9 })])

    expect(fleet.outcomes).toEqual({})
    expect(fleet.pending).toHaveLength(1)
  })
})
