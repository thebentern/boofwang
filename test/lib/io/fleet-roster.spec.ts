// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { exportFleetRoster, parseFleetRoster } from '#core/io/fleet-roster.js'
import type { FleetUnit } from '#core/radio/fleet.js'

describe('reading a club roster', () => {
  it('reads the three columns it writes', () => {
    const { units, problems } = parseFleetRoster('label,dmrId,name\r\nDave,2345678,M0DAV\r\nSam,2345679,M0SAM\r\n')

    expect(problems).toEqual([])
    expect(units).toEqual([
      { id: 'unit-1', label: 'Dave', dmrId: 2_345_678, name: 'M0DAV' },
      { id: 'unit-2', label: 'Sam', dmrId: 2_345_679, name: 'M0SAM' },
    ])
  })

  it('takes the columns in whatever order the header puts them', () => {
    const { units } = parseFleetRoster('Callsign,Owner,DMR ID\nM0DAV,Dave,2345678\n')
    expect(units).toEqual([{ id: 'unit-1', label: 'Dave', dmrId: 2_345_678, name: 'M0DAV' }])
  })

  it('reads a file with no header at all, positionally', () => {
    const { units } = parseFleetRoster('Dave,2345678,M0DAV\n')
    expect(units).toEqual([{ id: 'unit-1', label: 'Dave', dmrId: 2_345_678, name: 'M0DAV' }])
  })

  it('does not mistake a first radio for a header row', () => {
    // "Radio" and "Name" are both header spellings. A roster whose first entry
    // happens to use one must still be read as data, and the number in the ID
    // column is what settles it.
    const { units } = parseFleetRoster('Radio,2345678,Name\n')
    expect(units).toEqual([{ id: 'unit-1', label: 'Radio', dmrId: 2_345_678, name: 'Name' }])
  })

  it('strips the separators a spreadsheet adds', () => {
    const { units } = parseFleetRoster('label,dmrId,name\nDave,"2,345,678",M0DAV\n')
    expect(units[0]!.dmrId).toBe(2_345_678)
  })

  it('reports a number it cannot read rather than guessing at one', () => {
    // Number('1e7') is ten million. Coercing here would put a plausible,
    // entirely invented DMR ID into somebody's radio.
    const { units, problems } = parseFleetRoster('label,dmrId,name\nDave,1e7,M0DAV\nSam,2345679,M0SAM\n')

    expect(problems).toEqual([{ line: 2, message: '"1e7" is not a DMR ID this can read.' }])
    expect(units.map((u) => u.label)).toEqual(['Sam'])
  })

  it('counts lines the way the person looking at the file does', () => {
    const { problems } = parseFleetRoster('label,dmrId,name\nDave,2345678,M0DAV\nSam,nope,M0SAM\n')
    expect(problems).toEqual([{ line: 3, message: '"nope" is not a DMR ID this can read.' }])
  })

  it('keeps a row with no ID, because leaving one alone is a real instruction', () => {
    const { units, problems } = parseFleetRoster('label,dmrId,name\nSpare,,\n')
    expect(problems).toEqual([])
    expect(units).toEqual([{ id: 'unit-1', label: 'Spare', dmrId: null, name: '' }])
  })

  it('skips blank lines without counting them as radios', () => {
    const { units } = parseFleetRoster('label,dmrId,name\nDave,2345678,M0DAV\n\n\nSam,2345679,M0SAM\n')
    expect(units.map((u) => u.id)).toEqual(['unit-1', 'unit-2'])
  })

  it('falls back to the callsign when there is no label to use', () => {
    const { units } = parseFleetRoster('Callsign,DMR ID\nM0DAV,2345678\n')
    expect(units).toEqual([{ id: 'unit-1', label: 'M0DAV', dmrId: 2_345_678, name: 'M0DAV' }])
  })

  it('reads nothing out of nothing', () => {
    expect(parseFleetRoster('')).toEqual({ units: [], problems: [] })
    expect(parseFleetRoster('\n\n')).toEqual({ units: [], problems: [] })
  })
})

describe('writing a club roster back out', () => {
  const roster: FleetUnit[] = [
    { id: 'unit-1', label: 'Dave', dmrId: 2_345_678, name: 'M0DAV' },
    { id: 'unit-2', label: 'Spare, boxed', dmrId: null, name: '' },
  ]

  it('round-trips through the parser', () => {
    const { units, problems } = parseFleetRoster(exportFleetRoster(roster))
    expect(problems).toEqual([])
    expect(units).toEqual(roster)
  })

  it('quotes a label containing a comma, and ends lines as CHIRP’s CSV does', () => {
    expect(exportFleetRoster(roster)).toBe(
      'label,dmrId,name\r\nDave,2345678,M0DAV\r\n"Spare, boxed",,\r\n',
    )
  })
})
