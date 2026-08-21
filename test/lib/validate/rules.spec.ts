// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { emptyCodeplug } from '#core/model/codeplug.js'
import { hz, mW } from '#core/model/units.js'
import { RADIO_IDS, SCHEMAS, createDriver } from '#core/radio/registry.js'
import { validateChannel, validateChannels } from '#core/validate/rules.js'
import type { Channel } from '#core/model/channel.js'
import type { RadioId } from '#core/model/index.js'
import type { RadioSchema } from '#core/radio/schema.js'

/**
 * The shared rules, over every radio there is.
 *
 * Parameterised on the registry rather than written out four times, which is
 * the whole point: these rules exist because four hand-written validators
 * drifted apart, and a test that named its radios would drift the same way.
 * Adding a radio adds its coverage here automatically, and a radio that cannot
 * satisfy a rule fails loudly instead of quietly not being checked.
 *
 * Synthesised channels rather than fixtures, so each rule is provoked
 * deliberately instead of hoping some real radio happens to have the case.
 */
const RADIOS = RADIO_IDS.map((id) => ({ id, schema: SCHEMAS[id]! }))

/** A channel that breaks nothing, built from what the schema says is allowed. */
function ordinary(schema: RadioSchema, over: Partial<Channel> = {}): Channel {
  const band = schema.rf.bands.find((b) => b.txAllowed)!
  const middle = Math.round((band.loHz + band.hiHz) / 2)
  return {
    index: schema.memory.firstIndex,
    name: 'A',
    rxFreq: hz(middle),
    tx: { kind: 'simplex' },
    txAllowed: true,
    tone: { rx: null, tx: null, rxInverted: false },
    modulation: schema.rf.modulations[0]!,
    bandwidthHz: schema.rf.bandwidths[0]!,
    power: { mW: mW(schema.rf.powerLevels[0]!.mW) },
    tuningStep: schema.rf.tuningSteps[0]!,
    skip: 'none',
    comment: '',
    extras: {},
    ...over,
  } as Channel
}

const ids = (d: { ruleId: string }[]) => d.map((x) => x.ruleId)

describe.each(RADIOS)('$id', ({ schema }) => {
  it('says nothing about an ordinary channel', () => {
    expect(validateChannel(ordinary(schema), schema)).toEqual([])
  })

  it('refuses a receive frequency outside every band', () => {
    const found = validateChannel(ordinary(schema, { rxFreq: hz(1_000_000) }), schema)
    expect(ids(found)).toContain('radio.band.rx-out-of-range')
    expect(found.find((d) => d.ruleId === 'radio.band.rx-out-of-range')!.severity).toBe('error')
  })

  it('refuses a transmit frequency outside every band, which reading rxFreq cannot see', () => {
    // Receives legally; a split parks transmit on CB, which no amateur licence
    // covers and no band on any of these radios reaches.
    const found = validateChannel(
      ordinary(schema, { tx: { kind: 'split', txFreq: hz(27_185_000) } }),
      schema,
    )
    expect(ids(found)).toContain('radio.band.tx-out-of-range')
    expect(found.find((d) => d.ruleId === 'radio.band.tx-out-of-range')!.severity).toBe('error')
  })

  it('refuses a repeater shift that drags transmit out of band', () => {
    const band = schema.rf.bands.find((b) => b.txAllowed)!
    const found = validateChannel(
      ordinary(schema, {
        rxFreq: hz(band.loHz + 1_000_000),
        tx: { kind: 'offset', direction: 'minus', offset: hz(band.loHz) },
      }),
      schema,
    )
    expect(ids(found)).toContain('radio.band.tx-out-of-range')
  })

  it('says nothing about transmit on a receive-only channel, which transmits nowhere', () => {
    const found = validateChannel(
      ordinary(schema, { txAllowed: false, tx: { kind: 'split', txFreq: hz(27_185_000) } }),
      schema,
    )
    expect(found.filter((d) => d.field === 'tx')).toEqual([])
  })

  it('warns about a name the radio cannot show, without blocking', () => {
    const found = validateChannel(ordinary(schema, { name: 'X'.repeat(schema.memory.nameLength + 3) }), schema)
    const hit = found.find((d) => d.ruleId === 'radio.name.too-long')!
    expect(hit).toBeDefined()
    expect(hit.severity).toBe('warning')
  })

  it('warns about a character outside the radio charset', () => {
    const bad = [...'~`£é'].find((c) => !schema.memory.nameCharset.includes(c))!
    expect(ids(validateChannel(ordinary(schema, { name: bad }), schema))).toContain('radio.name.charset')
  })

  it('warns about a bandwidth the radio does not have', () => {
    const found = validateChannel(ordinary(schema, { bandwidthHz: 6_250 }), schema)
    expect(ids(found)).toContain('radio.bandwidth.unsupported')
    expect(found.find((d) => d.ruleId === 'radio.bandwidth.unsupported')!.severity).toBe('warning')
  })

  it('warns about power above anything the radio can do', () => {
    const highest = Math.max(...schema.rf.powerLevels.map((p) => p.mW))
    const found = validateChannel(ordinary(schema, { power: { mW: mW(highest + 50_000) } }), schema)
    expect(ids(found)).toContain('radio.power.too-high')
  })

  it('never blocks on anything but the frequency rules', () => {
    // Warnings are clickable-past on purpose. Transmitting out of band is the
    // thing the radio will not stop you doing, and it is the only thing here
    // that stands in the way of a write.
    const found = [
      ...validateChannel(ordinary(schema, { name: 'X'.repeat(40) }), schema),
      ...validateChannel(ordinary(schema, { bandwidthHz: 6_250 }), schema),
      ...validateChannel(ordinary(schema, { power: { mW: mW(99_000) } }), schema),
    ]
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((d) => d.severity === 'error')).toEqual([])
  })
})

describe('every driver runs them', () => {
  it.each(RADIO_IDS)('%s reports an out-of-band transmit as an error', (id: RadioId) => {
    // The regression this module exists for: the same illegal channel was a
    // blocking error on the UV-K5 and silent on the UV-82 and the DM-32UV.
    const schema = SCHEMAS[id]!
    const doc = emptyCodeplug(id, '2026-08-21T00:00:00.000Z')
    const ch = ordinary(schema, { tx: { kind: 'split', txFreq: hz(27_185_000) } })
    doc.channels.set(ch.index, ch)

    const hit = createDriver(id).validate(doc).find((d) => d.ruleId === 'radio.band.tx-out-of-range')
    expect(hit, `${id} lets an out-of-band transmit through`).toBeDefined()
    expect(hit!.severity).toBe('error')
  })

  it.each(RADIO_IDS)('%s keeps quiet about a channel that is fine', (id: RadioId) => {
    const schema = SCHEMAS[id]!
    const doc = emptyCodeplug(id, '2026-08-21T00:00:00.000Z')
    const ch = ordinary(schema)
    doc.channels.set(ch.index, ch)
    expect(createDriver(id).validate(doc)).toEqual([])
  })
})

describe('the radio own pseudo-channels', () => {
  it('are exempt, because their contents are not the user doing', () => {
    // A stock UV-K5 ships with its F2 band preset parked in the air band. The
    // rule would give every single radio permanent errors about data its owner
    // never created, and the remedy it offers - mark the channel receive-only -
    // has no meaning for a VFO preset.
    const schema = SCHEMAS.uvk5!
    const vfo = schema.memory.specialChannels[0]!
    expect(vfo.index).toBeGreaterThan(schema.memory.channelCount)

    const found = validateChannel(
      ordinary(schema, { index: vfo.index, name: 'F3(136M-174M)B', rxFreq: hz(108_250_000) }),
      schema,
    )
    expect(found.filter((d) => d.field === 'tx' || d.field === 'name')).toEqual([])
  })

  it('are not exempt on a radio that declares none', () => {
    const schema = SCHEMAS.uv82!
    expect(schema.memory.specialChannels).toEqual([])
    const found = validateChannel(
      ordinary(schema, { name: 'X'.repeat(40), tx: { kind: 'split', txFreq: hz(27_185_000) } }),
      schema,
    )
    expect(ids(found)).toEqual(expect.arrayContaining(['radio.band.tx-out-of-range', 'radio.name.too-long']))
  })
})

describe('bands that differ from the schema', () => {
  it('are honoured, so a wide-receive build is not reported as broken', () => {
    const schema = SCHEMAS.uvk5!
    const ch = ordinary(schema, { rxFreq: hz(21_300_000), tx: { kind: 'simplex' } })
    expect(ids(validateChannel(ch, schema))).toContain('radio.band.rx-out-of-range')

    const wide = [{ loHz: hz(18_000_000), hiHz: hz(1_300_000_000), label: 'wide', txAllowed: true }]
    expect(validateChannel(ch, schema, { bands: wide })).toEqual([])
  })
})

describe('walking a whole codeplug', () => {
  it('reports in slot order, so the list reads like the table', () => {
    const schema = SCHEMAS.uv82!
    const doc = emptyCodeplug('uv82', '2026-08-21T00:00:00.000Z')
    for (const index of [7, 2, 5]) {
      doc.channels.set(index, ordinary(schema, { index, rxFreq: hz(1_000_000) }))
    }
    // Two each: a simplex channel out of band fails on receive and transmit
    // both, which is correct and is why this checks the order rather than the
    // count.
    const found = validateChannels(doc, schema)
    expect([...new Set(found.map((d) => d.channel))]).toEqual([2, 5, 7])
    expect(found.map((d) => d.channel)).toEqual([2, 2, 5, 5, 7, 7])
  })
})
