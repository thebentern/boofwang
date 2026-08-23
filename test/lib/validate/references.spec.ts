// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { emptyCodeplug, type Codeplug } from '#core/model/codeplug.js'
import { hz, mW } from '#core/model/units.js'
import { RADIO_IDS, SCHEMAS, createDriver } from '#core/radio/registry.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import { validateReferences } from '#core/validate/references.js'
import type { Channel } from '#core/model/channel.js'
import type { Diagnostic } from '#core/radio/driver.js'
import type { RadioId } from '#core/model/index.js'
import type { RadioImage } from '#core/radio/image.js'
import type { RadioSchema } from '#core/radio/schema.js'

/**
 * The document checked against itself.
 *
 * Two halves, and the first is the one that matters. Every rule in
 * `references.ts` is a warning or an `info` on data a real radio can hold, so
 * the failure mode is not a missed defect - it is a rule that fires on a
 * codeplug nobody has done anything wrong to, which turns the diagnostics panel
 * into furniture and costs the rules that do mean something. So the fixtures go
 * through it first and have to come out silent. The provoked cases follow.
 *
 * The silence test is what caught the DM-32UV's `scanLists.channelsPer`, which
 * said 15 against a factory scan list of 16 members and a struct with room for
 * sixteen.
 */

const RADIOS = RADIO_IDS.map((id) => ({ id, schema: SCHEMAS[id]! }))
const WITH_ZONES = RADIOS.filter((r) => r.schema.features.zones !== false)

const F = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))))
const J = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url)), 'utf8'))

const CREATED = '2026-08-21T00:00:00.000Z'

function uv5rminiImage(): RadioImage {
  const raw = F('uv5rmini-5RMINI.bin')
  const index = J('uv5rmini-5RMINI.index.json') as { ident4d: string; regions: { start: number; size: number }[] }
  let off = 0
  return {
    radioId: 'uv5rmini',
    variant: index.ident4d,
    layout: 'uv5rmini',
    createdAt: CREATED,
    meta: {},
    sha256: '',
    regions: index.regions.map((r) => {
      const data = raw.slice(off, off + r.size)
      off += r.size
      return { start: r.start, data, label: `0x${r.start.toString(16)}` }
    }),
  }
}

function uv82Image(): RadioImage {
  return {
    radioId: 'uv82', variant: 'N822413', layout: 'uv82', createdAt: CREATED, meta: {}, sha256: '',
    regions: [{ start: 0, data: F('uv82-N822413.bin'), label: 'image' }],
  }
}

function uvk5Image(): RadioImage {
  return {
    radioId: 'uvk5', variant: '2.01.32', layout: 'stock', createdAt: CREATED, meta: {}, sha256: '',
    regions: [{ start: 0, data: F('uvk5-2.01.32.bin'), label: 'eeprom' }],
  }
}

function dm32uvImage(): RadioImage {
  const blob = F('dm32uv-DM32.01.01.040.blocks.bin')
  const index = J('dm32uv-DM32.01.01.040.index.json') as {
    firmware: string; model: string; blocks: { id: number; physical: number; offset: number }[]
  }
  return {
    radioId: 'dm32uv',
    variant: index.firmware,
    layout: index.model,
    createdAt: CREATED,
    sha256: '',
    meta: { placements: index.blocks.map((b) => ({ blockId: b.id, physical: b.physical })) },
    regions: index.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: blob.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
  }
}

const FIXTURES: { id: RadioId; image: () => RadioImage }[] = [
  { id: 'uv5rmini', image: uv5rminiImage },
  { id: 'uv82', image: uv82Image },
  { id: 'uvk5', image: uvk5Image },
  { id: 'dm32uv', image: dm32uvImage },
]

/** A channel that breaks nothing, built from what the schema says is allowed. */
function ordinary(schema: RadioSchema, over: Partial<Channel> = {}): Channel {
  const band = schema.rf.bands.find((b) => b.txAllowed)!
  return {
    index: schema.memory.firstIndex,
    name: 'A',
    rxFreq: hz(Math.round((band.loHz + band.hiHz) / 2)),
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

/**
 * A document holding `n` ordinary channels from the first programmable slot.
 *
 * Each on its own frequency, spread across a transmittable band. That is not
 * tidiness: the first version of this gave every channel the same frequency and
 * a different name, which is the exact shape `codeplug.channel.duplicate`
 * exists to report, so every test built on it started by tripping the rule it
 * was not about.
 */
function withChannels(schema: RadioSchema, n: number): Codeplug {
  const doc = emptyCodeplug(null, CREATED)
  const band = schema.rf.bands.find((b) => b.txAllowed)!
  const delta = Math.floor((band.hiHz - band.loHz) / (n + 2))
  for (let i = 0; i < n; i++) {
    const index = schema.memory.firstIndex + i
    doc.channels.set(index, ordinary(schema, { index, name: `CH${index}`, rxFreq: hz(band.loHz + delta * (i + 1)) }))
  }
  return doc
}

const ids = (d: readonly Diagnostic[]) => d.map((x) => x.ruleId)
const find = (d: readonly Diagnostic[], rule: string) => d.filter((x) => x.ruleId === rule)

describe('silent on a codeplug read from a real radio', () => {
  it.each(FIXTURES)('$id', ({ id, image }) => {
    const doc = createDriver(id).decode(image())
    expect(validateReferences(doc, SCHEMAS[id]!)).toEqual([])
  })
})

describe.each(RADIOS)('$id', ({ schema }) => {
  it('says nothing about a document whose lists are empty', () => {
    expect(validateReferences(withChannels(schema, 3), schema)).toEqual([])
  })

  it('reports a zone member that no slot holds', () => {
    const doc = withChannels(schema, 3)
    const dead = schema.memory.firstIndex + schema.memory.channelCount - 1
    doc.zones.push({ id: 'z1', name: 'Local', channels: [schema.memory.firstIndex, dead] })

    const found = find(validateReferences(doc, schema), 'codeplug.zone.missing-channel')
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('warning')
    expect(found[0]!.message).toContain('"Local"')
    expect(found[0]!.message).toContain(String(dead))
  })

  it('reports a scan list member that no slot holds, and its priority channel separately', () => {
    const doc = withChannels(schema, 3)
    const dead = schema.memory.firstIndex + schema.memory.channelCount - 1
    doc.scanLists.push({ id: 's1', name: '', channels: [dead], priority1: dead, priority2: null })

    const found = validateReferences(doc, schema)
    expect(ids(found)).toContain('codeplug.scan-list.missing-channel')
    expect(ids(found)).toContain('codeplug.scan-list.missing-priority')
    // An unnamed list still has to be identifiable in the sentence.
    expect(find(found, 'codeplug.scan-list.missing-channel')[0]!.message).toContain('unnamed')
  })

  it('leaves a priority channel of zero alone, which is how a list with none is stored', () => {
    const doc = withChannels(schema, 3)
    doc.scanLists.push({ id: 's1', name: 'S', channels: [], priority1: 0, priority2: null })
    expect(ids(validateReferences(doc, schema))).not.toContain('codeplug.scan-list.missing-priority')
  })

  /*
   * The rule that would be loudest if it were wrong, so it is checked on every
   * radio rather than only on the one that has talk groups. Two channels alike
   * in every field this model names are a duplicate; the radio's own
   * pseudo-channels are not, and neither is a DMR pair that differs only in
   * which talk group it transmits to.
   */
  it('reports two channels programmed identically, naming each other', () => {
    const doc = withChannels(schema, 2)
    const a = schema.memory.firstIndex
    const b = a + 1
    doc.channels.set(b, { ...doc.channels.get(a)!, index: b, name: 'DIFFERENT LABEL' })

    const found = find(validateReferences(doc, schema), 'codeplug.channel.duplicate')
    expect(found).toHaveLength(2)
    expect(found.every((d) => d.severity === 'info')).toBe(true)
    expect(found.map((d) => d.channel).sort((x, y) => x! - y!)).toEqual([a, b])
    expect(found.find((d) => d.channel === a)!.message).toContain(String(b))
  })

  it('does not call two channels duplicates when a radio-specific field differs', () => {
    const doc = withChannels(schema, 2)
    const a = schema.memory.firstIndex
    const b = a + 1
    const base = doc.channels.get(a)!
    doc.channels.set(a, { ...base, extras: { ...base.extras, vendor: { txContact: '3' } } })
    doc.channels.set(b, { ...base, index: b, extras: { ...base.extras, vendor: { txContact: '7' } } })

    expect(ids(validateReferences(doc, schema))).not.toContain('codeplug.channel.duplicate')
  })

  it('does not mind two channels whose vendor fields were built in a different order', () => {
    const doc = withChannels(schema, 2)
    const a = schema.memory.firstIndex
    const b = a + 1
    const base = doc.channels.get(a)!
    doc.channels.set(a, { ...base, extras: { vendor: { colorCode: '1', timeSlot: '2' } } })
    doc.channels.set(b, { ...base, index: b, extras: { vendor: { timeSlot: '2', colorCode: '1' } } })

    expect(ids(validateReferences(doc, schema))).toContain('codeplug.channel.duplicate')
  })

  it('never raises an error, because none of this stops a radio being programmed', () => {
    const doc = withChannels(schema, 2)
    const dead = schema.memory.firstIndex + schema.memory.channelCount - 1
    doc.zones.push({ id: 'z1', name: 'Z', channels: [dead] })
    doc.scanLists.push({ id: 's1', name: 'S', channels: [dead], priority1: dead, priority2: null })
    doc.channels.set(dead - 1, { ...doc.channels.get(schema.memory.firstIndex)!, index: dead - 1 })

    const found = validateReferences(doc, schema)
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((d) => d.severity === 'error')).toEqual([])
  })
})

/**
 * The UV-K5 keeps fourteen VFO band presets in the same channel map, past the
 * 200 slots a person can program. Several of them are alike, and `place.ts`
 * records what happens when code forgets they are there.
 */
describe('the radio\'s own pseudo-channels', () => {
  it('are left out of duplicate detection', () => {
    const schema = SCHEMAS.uvk5!
    const special = schema.memory.specialChannels
    expect(special.length).toBeGreaterThan(1)

    const doc = emptyCodeplug('uvk5', CREATED)
    for (const s of special.slice(0, 2)) doc.channels.set(s.index, ordinary(schema, { index: s.index, name: s.name }))

    expect(validateReferences(doc, schema)).toEqual([])
  })
})

describe.each(WITH_ZONES)('$id lists against the radio\'s own limits', ({ schema }) => {
  const zones = schema.features.zones as Exclude<RadioSchema['features']['zones'], false>
  const scanLists = schema.features.scanLists as Exclude<RadioSchema['features']['scanLists'], false>

  it('reports a zone with more channels than the radio keeps per zone', () => {
    const doc = withChannels(schema, zones.channelsPer + 2)
    doc.zones.push({ id: 'z1', name: 'Big', channels: [...doc.channels.keys()] })

    const found = find(validateReferences(doc, schema), 'codeplug.zone.over-capacity')
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('warning')
    expect(found[0]!.message).toContain(`The last 2`)
  })

  it('reports a scan list over capacity', () => {
    const doc = withChannels(schema, scanLists.channelsPer + 1)
    doc.scanLists.push({ id: 's1', name: 'Big', channels: [...doc.channels.keys()], priority1: null, priority2: null })

    expect(ids(validateReferences(doc, schema))).toContain('codeplug.scan-list.over-capacity')
  })

  it('accepts a zone filled exactly to capacity', () => {
    const doc = withChannels(schema, zones.channelsPer)
    doc.zones.push({ id: 'z1', name: 'Full', channels: [...doc.channels.keys()] })

    expect(ids(validateReferences(doc, schema))).not.toContain('codeplug.zone.over-capacity')
  })

  it('reports more zones than the radio holds', () => {
    const doc = withChannels(schema, 1)
    for (let i = 0; i <= zones.max; i++) doc.zones.push({ id: `z${i}`, name: `Z${i}`, channels: [] })

    const found = find(validateReferences(doc, schema), 'codeplug.list.over-capacity')
    expect(found).toHaveLength(1)
    expect(found[0]!.message).toContain('zones')
  })

  it('reports a zone name longer than the radio shows', () => {
    const doc = withChannels(schema, 1)
    doc.zones.push({ id: 'z1', name: 'x'.repeat(zones.nameLength + 1), channels: [] })

    expect(ids(validateReferences(doc, schema))).toContain('codeplug.name.too-long')
  })

  it('reports two talk groups sharing a number, as info rather than a warning', () => {
    const doc = withChannels(schema, 1)
    doc.talkGroups.push({ id: 'tg-0x12-1', name: 'Local', number: 91, callType: 'group' })
    doc.talkGroups.push({ id: 'tg-0x12-2', name: 'Worldwide', number: 91, callType: 'group' })

    const found = find(validateReferences(doc, schema), 'codeplug.talk-group.duplicate-number')
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('info')
    expect(found[0]!.message).toContain('"Local"')
    expect(found[0]!.message).toContain('"Worldwide"')
  })

  it('reports a text message longer than the radio stores', () => {
    const messages = schema.features.messages
    if (messages === false) return
    const doc = withChannels(schema, 1)
    doc.messages.push('x'.repeat(messages.maxChars + 1))

    expect(ids(validateReferences(doc, schema))).toContain('codeplug.message.too-long')
  })
})
