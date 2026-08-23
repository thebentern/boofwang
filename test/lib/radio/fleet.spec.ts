// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  planFleetUnit,
  unitAlreadyProgrammed,
  validateFleetRoster,
  type FleetOutcome,
  type FleetUnit,
} from '#core/radio/fleet.js'
import { emptyCodeplug, type Channel, type Codeplug } from '#core/model/index.js'
import { NO_TONE } from '#core/model/tones.js'
import { hz, mW } from '#core/model/units.js'
import { DM32UV_SCHEMA } from '#core/radios/dm32uv/schema.js'
import { UVK5_SCHEMA } from '#core/radios/uvk5/schema.js'

const NOW = '2026-08-23T09:00:00.000Z'

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

function plug(over: Partial<Codeplug> = {}, radio: Codeplug['radio'] = 'dm32uv'): Codeplug {
  return Object.assign(emptyCodeplug(radio, '2026-01-01T00:00:00.000Z'), over)
}

/** The codeplug the club built, on the club secretary's own radio. */
function master(): Codeplug {
  const cp = plug({
    zones: [{ id: 'z1', name: 'CLUB', channels: [1, 2] }],
    talkGroups: [{ id: 't1', name: 'Local', number: 91, callType: 'group' }],
    radioIds: [{ id: 'rid-1', name: 'G0SEC', dmrId: 2_341_001 }],
    encryptionKeys: [{ id: 'k1', slot: 1, name: 'Fleet', type: 'aes256', keyHex: 'AABBCCDD' }],
  })
  cp.channels.set(1, channel({ index: 1, name: 'GB3CLUB' }))
  cp.channels.set(2, channel({ index: 2, name: 'SIMPLEX' }))
  return cp
}

/** A member's handset, carrying their own identity and their own channels. */
function member(over: Partial<Codeplug> = {}): Codeplug {
  const cp = plug({
    zones: [{ id: 'mz', name: 'MINE', channels: [7] }],
    radioIds: [{ id: 'rid-1', name: 'M0OLD', dmrId: 2_349_999 }],
    ...over,
  })
  cp.channels.set(7, channel({ index: 7, name: 'MYCHAN' }))
  return cp
}

const UNIT: FleetUnit = { id: 'u1', label: "Dave's HT", dmrId: 2_345_678, name: 'M0DAV' }

describe('planning one unit of a fleet run', () => {
  it('gives the radio the roster’s identity, not the master’s', () => {
    const plan = planFleetUnit({ master: master(), unit: UNIT, recipient: member(), schema: DM32UV_SCHEMA, now: NOW })

    expect(plan.codeplug.radioIds).toEqual([{ id: 'rid-1', name: 'M0DAV', dmrId: 2_345_678 }])
    // The master's ID is the one failure this whole module exists to prevent.
    expect(plan.codeplug.radioIds.some((r) => r.dmrId === 2_341_001)).toBe(false)
  })

  it('carries the master’s channels, zones and talk groups', () => {
    const plan = planFleetUnit({ master: master(), unit: UNIT, recipient: member(), schema: DM32UV_SCHEMA, now: NOW })

    expect([...plan.codeplug.channels.keys()]).toEqual([1, 2])
    expect(plan.codeplug.zones.map((z) => z.name)).toEqual(['CLUB'])
    expect(plan.codeplug.talkGroups.map((g) => g.name)).toEqual(['Local'])
  })

  it('reports what it replaced, in the radio’s own terms', () => {
    const plan = planFleetUnit({ master: master(), unit: UNIT, recipient: member(), schema: DM32UV_SCHEMA, now: NOW })

    expect(plan.overrides).toEqual([
      { field: 'dmrId', from: '2349999', to: '2345678' },
      { field: 'name', from: 'M0OLD', to: 'M0DAV' },
    ])
  })

  it('reports nothing replaced when the radio already holds the roster’s identity', () => {
    const already = member({ radioIds: [{ id: 'rid-1', name: 'M0DAV', dmrId: 2_345_678 }] })
    const plan = planFleetUnit({ master: master(), unit: UNIT, recipient: already, schema: DM32UV_SCHEMA, now: NOW })

    expect(plan.overrides).toEqual([])
    expect(plan.codeplug.radioIds).toEqual([{ id: 'rid-1', name: 'M0DAV', dmrId: 2_345_678 }])
  })

  it('creates the first slot on a radio that has no DMR ID at all', () => {
    const blank = member({ radioIds: [] })
    const plan = planFleetUnit({ master: master(), unit: UNIT, recipient: blank, schema: DM32UV_SCHEMA, now: NOW })

    // `rid-1` is the encoder's own spelling for the first slot. Anything else is
    // treated as a new entry and lands in the lowest free one.
    expect(plan.codeplug.radioIds).toEqual([{ id: 'rid-1', name: 'M0DAV', dmrId: 2_345_678 }])
    expect(plan.overrides).toEqual([
      { field: 'dmrId', from: 'none', to: '2345678' },
      { field: 'name', from: 'none', to: 'M0DAV' },
    ])
  })

  it('leaves a blank roster column alone rather than clearing the radio', () => {
    const unit: FleetUnit = { id: 'u1', label: 'Spare', dmrId: null, name: '' }
    const plan = planFleetUnit({ master: master(), unit, recipient: member(), schema: DM32UV_SCHEMA, now: NOW })

    expect(plan.codeplug.radioIds).toEqual([{ id: 'rid-1', name: 'M0OLD', dmrId: 2_349_999 }])
    expect(plan.overrides).toEqual([])
  })

  it('sets only the ID when only the ID is given', () => {
    const unit: FleetUnit = { id: 'u1', label: 'Spare', dmrId: 2_345_678, name: '' }
    const plan = planFleetUnit({ master: master(), unit, recipient: member(), schema: DM32UV_SCHEMA, now: NOW })

    expect(plan.codeplug.radioIds).toEqual([{ id: 'rid-1', name: 'M0OLD', dmrId: 2_345_678 }])
    expect(plan.overrides).toEqual([{ field: 'dmrId', from: '2349999', to: '2345678' }])
  })

  it('keeps the radio’s later ID slots and says they are there', () => {
    const twoIds = member({
      radioIds: [
        { id: 'rid-1', name: 'M0OLD', dmrId: 2_349_999 },
        { id: 'rid-2', name: 'PREVOWN', dmrId: 2_340_000 },
      ],
    })
    const plan = planFleetUnit({ master: master(), unit: UNIT, recipient: twoIds, schema: DM32UV_SCHEMA, now: NOW })

    expect(plan.codeplug.radioIds).toEqual([
      { id: 'rid-1', name: 'M0DAV', dmrId: 2_345_678 },
      { id: 'rid-2', name: 'PREVOWN', dmrId: 2_340_000 },
    ])
    // Reported, because a channel asking for radio ID 2 would transmit as the
    // previous owner and nothing else on screen would say so.
    expect(plan.carriedRadioIds).toEqual([{ id: 'rid-2', name: 'PREVOWN', dmrId: 2_340_000 }])
  })

  it('cuts a name to what the radio stores', () => {
    const unit: FleetUnit = { id: 'u1', label: 'Long', dmrId: 2_345_678, name: 'ABCDEFGHIJKLMNOP' }
    const plan = planFleetUnit({ master: master(), unit, recipient: member(), schema: DM32UV_SCHEMA, now: NOW })

    expect(DM32UV_SCHEMA.features.radioIds).not.toBe(false)
    expect(plan.codeplug.radioIds[0]!.name).toBe('ABCDEFGHIJKL')
  })

  it('leaves the master and the radio’s own document untouched', () => {
    const club = master()
    const mine = member()
    planFleetUnit({ master: club, unit: UNIT, recipient: mine, schema: DM32UV_SCHEMA, now: NOW })

    expect(club.radioIds).toEqual([{ id: 'rid-1', name: 'G0SEC', dmrId: 2_341_001 }])
    expect(mine.radioIds).toEqual([{ id: 'rid-1', name: 'M0OLD', dmrId: 2_349_999 }])
    expect([...mine.channels.keys()]).toEqual([7])
  })

  it('keeps the master’s key slots out of it unless they are asked for', () => {
    const kept = planFleetUnit({ master: master(), unit: UNIT, recipient: member(), schema: DM32UV_SCHEMA, now: NOW })
    expect(kept.codeplug.encryptionKeys).toEqual([])
    expect(kept.skipped.map((s) => s.feature)).toContain('encryptionKeys')

    const copied = planFleetUnit({
      master: master(),
      unit: UNIT,
      recipient: member(),
      schema: DM32UV_SCHEMA,
      now: NOW,
      copyEncryptionKeys: true,
    })
    expect(copied.codeplug.encryptionKeys.map((k) => k.keyHex)).toEqual(['AABBCCDD'])
  })

  it('is the transplant, so a radio with no DMR identity still gets the plan', () => {
    const club = plug({ zones: [{ id: 'z1', name: 'CLUB', channels: [1] }] }, 'uvk5')
    club.channels.set(1, channel({ index: 1, name: 'CLUB1' }))
    const mine = plug({}, 'uvk5')
    mine.channels.set(9, channel({ index: 9, name: 'MINE' }))

    const plan = planFleetUnit({ master: club, unit: UNIT, recipient: mine, schema: UVK5_SCHEMA, now: NOW })

    expect(UVK5_SCHEMA.features.radioIds).toBe(false)
    expect([...plan.codeplug.channels.keys()]).toEqual([1])
    expect(plan.overrides).toEqual([])
    expect(plan.carriedRadioIds).toEqual([])
  })
})

describe('checking a roster before anything is plugged in', () => {
  const row = (over: Partial<FleetUnit> & { id: string }): FleetUnit => ({
    label: over.id,
    dmrId: 2_345_678,
    name: 'M0AAA',
    ...over,
  })

  it('refuses two radios set to the same DMR ID', () => {
    const problems = validateFleetRoster(
      [row({ id: 'a', label: 'Dave' }), row({ id: 'b', label: 'Sam' })],
      DM32UV_SCHEMA,
    )
    const dup = problems.find((p) => p.ruleId === 'fleet.id.duplicate')
    expect(dup?.severity).toBe('error')
    expect(dup?.message).toContain('"Dave"')
    expect(dup?.message).toContain('"Sam"')
  })

  it('refuses an ID the radio cannot store', () => {
    const problems = validateFleetRoster(
      [row({ id: 'a', dmrId: 0 }), row({ id: 'b', dmrId: 16_777_216 }), row({ id: 'c', dmrId: 1.5 })],
      DM32UV_SCHEMA,
    )
    expect(problems.filter((p) => p.ruleId === 'fleet.id.range')).toHaveLength(3)
  })

  it('accepts a roster that varies nothing', () => {
    const problems = validateFleetRoster(
      [row({ id: 'a', label: 'One', dmrId: null, name: '' }), row({ id: 'b', label: 'Two', dmrId: null, name: '' })],
      DM32UV_SCHEMA,
    )
    expect(problems).toEqual([])
  })

  it('warns rather than refuses when a name will be cut', () => {
    const problems = validateFleetRoster([row({ id: 'a', name: 'ABCDEFGHIJKLMNOP' })], DM32UV_SCHEMA)
    const cut = problems.find((p) => p.ruleId === 'fleet.name.too-long')
    expect(cut?.severity).toBe('warning')
    expect(cut?.message).toContain('"ABCDEFGHIJKL"')
  })

  it('warns when two rows are called the same thing', () => {
    const problems = validateFleetRoster(
      [row({ id: 'a', label: 'Spare', dmrId: 1 }), row({ id: 'b', label: 'spare ', dmrId: 2 })],
      DM32UV_SCHEMA,
    )
    expect(problems.find((p) => p.ruleId === 'fleet.label.duplicate')?.severity).toBe('warning')
  })

  it('refuses an ID for a radio that has nowhere to keep one', () => {
    const problems = validateFleetRoster([row({ id: 'a' })], UVK5_SCHEMA)
    expect(problems.find((p) => p.ruleId === 'fleet.id.unsupported')?.severity).toBe('error')
  })

  it('refuses an empty roster, and says nothing else about it', () => {
    expect(validateFleetRoster([], DM32UV_SCHEMA)).toEqual([
      {
        severity: 'error',
        ruleId: 'fleet.roster.empty',
        message: 'The roster has no radios in it, so there is nothing to programme.',
      },
    ])
  })
})

describe('catching the same handset twice in one run', () => {
  const outcome = (over: Partial<FleetOutcome> = {}): FleetOutcome => ({
    state: 'written',
    at: NOW,
    unitHash: 'cal-aaaa',
    blocks: 4,
    note: '',
    ...over,
  })

  it('names the row a radio already took', () => {
    expect(unitAlreadyProgrammed('cal-aaaa', 'u2', { u1: outcome() })).toBe('u1')
  })

  it('lets the row that took it be done again', () => {
    // A failed write retried on the same radio is the ordinary case, and so is
    // reopening a row to correct a typo in its callsign.
    expect(unitAlreadyProgrammed('cal-aaaa', 'u1', { u1: outcome() })).toBeNull()
  })

  it('does not count a row that was skipped or that failed', () => {
    expect(unitAlreadyProgrammed('cal-aaaa', 'u2', { u1: outcome({ state: 'skipped' }) })).toBeNull()
    expect(unitAlreadyProgrammed('cal-aaaa', 'u2', { u1: outcome({ state: 'failed' }) })).toBeNull()
  })

  it('claims nothing when the driver cannot fingerprint a unit', () => {
    // Null is "cannot tell", never "no match". Treating it as a match would
    // stop every radio on a driver that has no calibration to hash.
    expect(unitAlreadyProgrammed(null, 'u2', { u1: outcome({ unitHash: null }) })).toBeNull()
    expect(unitAlreadyProgrammed('cal-aaaa', 'u2', { u1: outcome({ unitHash: null }) })).toBeNull()
  })

  it('lets a different radio take the next row', () => {
    expect(unitAlreadyProgrammed('cal-bbbb', 'u2', { u1: outcome() })).toBeNull()
  })
})
