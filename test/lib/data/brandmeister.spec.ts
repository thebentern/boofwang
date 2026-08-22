// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { brandmeister } from '#core/data/brandmeister.js'
import type { JsonFetcher } from '#core/data/source.js'
import { hz } from '#core/model/units.js'

/**
 * The device records below are verbatim from a live response on 2026-08-22.
 * SV4M is the one used to establish the frequency mapping: a European 70 cm
 * repeater with the standard -7.6 MHz shift, which only comes out right if
 * `tx` is read as the repeater transmitting.
 */
const SV4M = {
  id: 202004,
  callsign: 'SV4M',
  tx: '439.3750',
  rx: '431.7750',
  colorcode: 1,
  lat: 39.40425,
  lng: 23.05131,
  city: 'Volos, KM19MJ',
}

const stub = (body: unknown): JsonFetcher => async () => body

describe('brandmeister.fetchRepeaters', () => {
  it('reads the repeater output as our receive frequency, not the other way round', async () => {
    const { records } = await brandmeister.fetchRepeaters(stub([SV4M]), {})
    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r.rxFreq).toBe(hz(439_375_000))
    expect(r.tx).toEqual({ kind: 'offset', direction: 'minus', offset: hz(7_600_000) })
  })

  it('carries the colour code as DMR rather than forcing it into a tone', async () => {
    const { records } = await brandmeister.fetchRepeaters(stub([SV4M]), {})
    expect(records[0]!.dmr).toEqual({ colorCode: 1 })
    expect(records[0]!.tone).toEqual({ rx: null, tx: null, rxInverted: false })
    expect(records[0]!.modulation).toBe('DMR')
  })

  it('refuses a record whose colour code cannot be stored, and names it', async () => {
    // Live data carries one record with colour code 17. The DM-32UV stores this
    // in four bits, so 17 becomes 1 and the channel silently addresses the
    // wrong repeater.
    const { records, issues } = await brandmeister.fetchRepeaters(
      stub([{ ...SV4M, colorcode: 17 }]),
      {},
    )
    expect(records).toHaveLength(0)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('error')
    expect(issues[0]!.message).toContain('SV4M')
    expect(issues[0]!.message).toContain('17')
  })

  it('refuses a record with no usable output frequency', async () => {
    // Four live records publish a zero or blank tx.
    const { records, issues } = await brandmeister.fetchRepeaters(
      stub([{ ...SV4M, tx: '0.0000' }]),
      {},
    )
    expect(records).toHaveLength(0)
    expect(issues[0]!.message).toContain('output frequency')
  })

  it('drops the null island rather than placing a repeater in the Gulf of Guinea', async () => {
    const { records } = await brandmeister.fetchRepeaters(
      stub([{ ...SV4M, lat: 0, lng: 0 }]),
      {},
    )
    expect(records[0]!.location).toBeUndefined()
  })

  it('sorts by distance and honours a radius', async () => {
    const near = { ...SV4M, id: 1, callsign: 'NEAR', lat: 39.5, lng: 23.0 }
    const far = { ...SV4M, id: 2, callsign: 'FAR', lat: 52.5, lng: 13.4 }
    const { records } = await brandmeister.fetchRepeaters(stub([far, near]), {
      near: { lat: 39.4, lon: 23.05 },
      withinKm: 100,
    })
    expect(records.map((r) => r.callsign)).toEqual(['NEAR'])
  })

  it('excludes records with no coordinates from a distance search', async () => {
    const nowhere = { ...SV4M, id: 3, callsign: 'NOWHERE', lat: null, lng: null }
    const withNear = await brandmeister.fetchRepeaters(stub([SV4M, nowhere]), {
      near: { lat: 39.4, lon: 23.05 },
    })
    expect(withNear.records.map((r) => r.callsign)).toEqual(['SV4M'])

    // ...but keeps them when no distance was asked for. They are real
    // repeaters; they just cannot be shown to be near anything.
    const withoutNear = await brandmeister.fetchRepeaters(stub([SV4M, nowhere]), {})
    expect(withoutNear.records).toHaveLength(2)
  })

  it('reports a response that is not a list rather than throwing', async () => {
    const { records, issues } = await brandmeister.fetchRepeaters(stub({ error: 'nope' }), {})
    expect(records).toEqual([])
    expect(issues[0]!.severity).toBe('error')
  })
})

describe('brandmeister.fetchTalkGroups', () => {
  it('reads the number-to-name map', async () => {
    const { talkGroups } = await brandmeister.fetchTalkGroups!(
      stub({ '91': 'World-wide', '1': 'Local', '262': 'Deutschland' }),
    )
    expect(talkGroups).toEqual([
      { sourceId: 'brandmeister', number: 1, name: 'Local' },
      { sourceId: 'brandmeister', number: 91, name: 'World-wide' },
      { sourceId: 'brandmeister', number: 262, name: 'Deutschland' },
    ])
  })

  it('reports an unnamed or non-numeric entry instead of inventing one', async () => {
    const { talkGroups, issues } = await brandmeister.fetchTalkGroups!(
      stub({ '91': 'World-wide', '  ': 'Nameless key', '262': '  ' }),
    )
    expect(talkGroups.map((t) => t.number)).toEqual([91])
    expect(issues).toHaveLength(2)
  })
})
