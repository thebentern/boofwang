// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { hearham } from '#core/data/hearham.js'
import { radioid } from '#core/data/radioid.js'
import { SourceUnavailableError, loadSource } from '#core/data/load.js'
import { DATA_SOURCES } from '#core/data/registry.js'
import type { JsonFetcher } from '#core/data/source.js'
import { hz } from '#core/model/units.js'

const stub = (body: unknown): JsonFetcher => async () => body

/** Verbatim from a live hearham response on 2026-08-22. */
const VE7RHS = {
  id: 1,
  callsign: 'VE7RHS',
  latitude: 49.26973,
  longitude: -123.24992,
  city: 'Vancouver, BC Canada',
  mode: 'FM',
  encode: '100.0',
  decode: '100.0',
  frequency: 145270000,
  offset: -600000,
  operational: 1,
}

describe('hearham', () => {
  it('reads hertz integers directly and applies the signed offset', async () => {
    const { records } = await hearham.fetchRepeaters(stub([VE7RHS]), {})
    const r = records[0]!
    expect(r.rxFreq).toBe(hz(145_270_000))
    expect(r.tx).toEqual({ kind: 'offset', direction: 'minus', offset: hz(600_000) })
  })

  it('maps encode to transmit and decode to receive', async () => {
    const { records } = await hearham.fetchRepeaters(
      stub([{ ...VE7RHS, encode: '100.0', decode: '' }]),
      {},
    )
    // The repeater expects to hear 100.0, so that is what this radio sends. It
    // sends nothing back, so nothing is required to open our squelch.
    expect(records[0]!.tone.tx).toEqual({ kind: 'ctcss', deciHz: 1000 })
    expect(records[0]!.tone.rx).toBeNull()
  })

  it('recovers a colour code from the field that should hold a tone', async () => {
    const { records } = await hearham.fetchRepeaters(
      stub([{ ...VE7RHS, mode: 'DMR', encode: 'CC1' }]),
      {},
    )
    expect(records[0]!.dmr).toEqual({ colorCode: 1 })
    expect(records[0]!.tone.tx).toBeNull()
  })

  it('treats a zero offset as simplex rather than guessing a shift', async () => {
    // 3,236 records publish zero. A simplex node and a repeater whose shift
    // nobody filled in are indistinguishable here.
    const { records } = await hearham.fetchRepeaters(stub([{ ...VE7RHS, offset: 0 }]), {})
    expect(records[0]!.tx).toEqual({ kind: 'simplex' })
  })

  it('drops a mode no supported radio can use, and says which', async () => {
    const { records, issues } = await hearham.fetchRepeaters(stub([{ ...VE7RHS, mode: 'YSF' }]), {})
    expect(records).toHaveLength(0)
    expect(issues[0]!.message).toContain('VE7RHS')
    expect(issues[0]!.message).toContain('YSF')
  })

  it('carries the operational flag through', async () => {
    const { records } = await hearham.fetchRepeaters(stub([{ ...VE7RHS, operational: 0 }]), {})
    expect(records[0]!.operational).toBe(false)
  })
})

describe('radioid', () => {
  const W0JAY = {
    callsign: 'W0JAY',
    city: 'Seymour',
    state: 'Connecticut',
    color_code: 1,
    frequency: '444.50000',
    offset: '+5.000',
    status: 'on-air',
  }

  it('reads a signed shift', async () => {
    const { records } = await radioid.fetchRepeaters(
      stub({ results: [W0JAY] }),
      { callsign: 'W0JAY' },
    )
    expect(records[0]!.rxFreq).toBe(hz(444_500_000))
    expect(records[0]!.tx).toEqual({ kind: 'offset', direction: 'plus', offset: hz(5_000_000) })
  })

  it('refuses a shift published without a sign, rather than assuming a direction', async () => {
    // A bare '5.000' appears in live data. Assuming plus is right most of the
    // time; the rest of the time it transmits 5 MHz from anyone listening.
    const { records, issues } = await radioid.fetchRepeaters(
      stub({ results: [{ ...W0JAY, offset: '5.000' }] }),
      { callsign: 'W0JAY' },
    )
    expect(records).toHaveLength(0)
    expect(issues[0]!.message).toContain('no sign')
  })

  it('refuses to list rather than quietly downloading the database', async () => {
    // Their policy permits lookups and prohibits mirroring. A bare query must
    // not fall back to everything.
    const { records, issues } = await radioid.fetchRepeaters(stub({ results: [] }), {})
    expect(records).toEqual([])
    expect(issues[0]!.message).toContain('lookups')
  })

  it('says it cannot sort by distance instead of returning an unsorted list as sorted', async () => {
    const { issues } = await radioid.fetchRepeaters(
      stub({ results: [W0JAY] }),
      { callsign: 'W0JAY', near: { lat: 41.4, lon: -73.1 } },
    )
    expect(issues.some((i) => i.message.includes('no locations'))).toBe(true)
  })
})

describe('loadSource enforces what availableSources only explains', () => {
  it('refuses a source the host cannot reach, naming the reason', async () => {
    await expect(loadSource('hearham', 'browser')).rejects.toThrow(SourceUnavailableError)
    await expect(loadSource('hearham', 'browser')).rejects.toThrow(/desktop app/)
  })

  it('hands over the same source on a host that can reach it', async () => {
    const impl = await loadSource('hearham', 'desktop')
    expect(impl.id).toBe('hearham')
  })

  it('lets the ungated source through on both hosts', async () => {
    for (const host of ['browser', 'desktop'] as const) {
      expect((await loadSource('brandmeister', host)).id).toBe('brandmeister')
    }
  })

  it('refuses an id that is not in the registry', async () => {
    await expect(loadSource('repeaterbook', 'desktop')).rejects.toThrow(SourceUnavailableError)
  })

  it('has a reader for every source the registry lists', async () => {
    // The switch in load.ts and the registry drift apart silently otherwise:
    // a source would be offered in the interface and fail when picked.
    for (const s of DATA_SOURCES) {
      const impl = await loadSource(s.id, 'desktop')
      expect(impl.id, s.id).toBe(s.id)
    }
  })
})
