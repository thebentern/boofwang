// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Channel } from '#core/model/channel.js'
import type { Codeplug } from '#core/model/codeplug.js'
import { emptyCodeplug } from '#core/model/codeplug.js'
import type { RadioImage } from '#core/radio/image.js'
import { diffImages } from '#core/radio/diff.js'
import {
  applyRenumber,
  naturalCompare,
  planChangesSomething,
  planFitsDocument,
  planRenumber,
} from '#core/radio/renumber.js'
import { SCHEMAS, createDriver } from '#core/radio/registry.js'
import { REGIONS } from '#core/radios/uvk5/layout.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'

/**
 * Renumbering, and the references that go with it.
 *
 * The arithmetic of a sort is not what this guards. What it guards is that
 * every structure naming a channel by number follows the channel: a zone, a
 * scan list, and on the DM-32UV eight APRS settings that look like plain
 * integers and are written to the radio. A test that only checked the new slot
 * numbers would pass while a zone quietly pointed at somebody else's
 * frequencies.
 *
 * The DM-32UV cases run against the real hardware capture rather than a stub,
 * because that image is the one with a sparse channel bank, real zones and a
 * real encoder to answer to.
 */

const UVK5 = SCHEMAS.uvk5!
const DM32 = SCHEMAS.dm32uv!

const F = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/images/${n}`, import.meta.url))))

function uvk5Image(): RadioImage {
  const raw = F('uvk5-2.01.32.bin')
  return {
    radioId: 'uvk5',
    variant: '2.01.32',
    layout: 'stock',
    createdAt: '2026-08-21T00:00:00.000Z',
    regions: REGIONS.map((r) => ({
      start: r.start,
      data: raw.slice(r.start, r.start + r.length),
      readOnly: r.readOnly,
      label: r.label,
    })),
    meta: {},
    sha256: '',
  }
}

function dm32Image(): RadioImage {
  const blob = F('dm32uv-DM32.01.01.040.blocks.bin')
  const index = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../fixtures/images/dm32uv-DM32.01.01.040.index.json', import.meta.url)),
      'utf8',
    ),
  ) as { firmware: string; model: string; blocks: { id: number; offset: number }[] }
  return {
    radioId: 'dm32uv',
    variant: index.firmware,
    layout: index.model,
    createdAt: '2026-08-21T00:00:00.000Z',
    regions: index.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: blob.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
    meta: {},
    sha256: '',
  }
}

const row = (index: number, name: string, rxFreq = 146_520_000 + index * 25_000): Channel =>
  ({ index, name, rxFreq, txAllowed: true, extras: { vendor: {} } }) as unknown as Channel

/** A codeplug holding exactly the given channels, in the slots they name. */
function doc(...channels: Channel[]): Codeplug {
  const cp = emptyCodeplug('dm32uv', '2026-08-23T00:00:00.000Z')
  for (const c of channels) cp.channels.set(c.index, c)
  return cp
}

describe('closing the gaps', () => {
  it('packs the channels down without changing the order they are in', () => {
    const cp = doc(row(1, 'A'), row(4, 'B'), row(9, 'C'))
    const plan = planRenumber(DM32, cp, { order: 'slot' })

    expect(plan.moves).toEqual([
      { from: 4, to: 2, name: 'B' },
      { from: 9, to: 3, name: 'C' },
    ])
    const next = applyRenumber(cp, plan)
    expect([...next.channels.keys()]).toEqual([1, 2, 3])
    expect([...next.channels.values()].map((c) => c.name)).toEqual(['A', 'B', 'C'])
  })

  it('gives every moved channel the index it now sits at', () => {
    const cp = doc(row(7, 'ONLY'))
    const next = applyRenumber(cp, planRenumber(DM32, cp, { order: 'slot' }))
    // The map key and the record's own `index` are two copies of the same fact,
    // and everything downstream - the encoder's slot arithmetic, the table's
    // row identity - reads whichever is nearer.
    expect(next.channels.get(1)!.index).toBe(1)
  })

  it('reports a codeplug that is already packed as changing nothing', () => {
    const cp = doc(row(1, 'A'), row(2, 'B'))
    const plan = planRenumber(DM32, cp, { order: 'slot' })
    expect(plan.moves).toEqual([])
    expect(planChangesSomething(plan)).toBe(false)
  })
})

describe('ordering', () => {
  it('sorts names the way a person reads them, not the way a byte comparison does', () => {
    const cp = doc(row(1, 'GMRS 10'), row(2, 'GMRS 2'), row(3, 'GMRS 1'))
    const plan = planRenumber(DM32, cp, { order: 'name' })
    const next = applyRenumber(cp, plan)
    expect([1, 2, 3].map((s) => next.channels.get(s)!.name)).toEqual(['GMRS 1', 'GMRS 2', 'GMRS 10'])
  })

  it('puts the unnamed channels last rather than first', () => {
    const cp = doc(row(1, ''), row(2, 'ZULU'), row(3, ''))
    const next = applyRenumber(cp, planRenumber(DM32, cp, { order: 'name' }))
    expect(next.channels.get(1)!.name).toBe('ZULU')
  })

  it('sorts by receive frequency', () => {
    const cp = doc(row(1, 'HIGH', 446_000_000), row(2, 'LOW', 144_000_000))
    const next = applyRenumber(cp, planRenumber(DM32, cp, { order: 'frequency' }))
    expect([1, 2].map((s) => next.channels.get(s)!.name)).toEqual(['LOW', 'HIGH'])
  })

  it('breaks every tie on the slot the channel is already in, so the result is stable', () => {
    const cp = doc(row(5, 'SAME', 146_000_000), row(2, 'SAME', 146_000_000))
    const plan = planRenumber(DM32, cp, { order: 'name' })
    expect(plan.mapping.get(2)).toBe(1)
    expect(plan.mapping.get(5)).toBe(2)
  })

  it('orders digit runs numerically and everything else by code unit', () => {
    expect(naturalCompare('GMRS 2', 'GMRS 10')).toBeLessThan(0)
    expect(naturalCompare('A', 'B')).toBeLessThan(0)
    expect(naturalCompare('CH1', 'CH1')).toBe(0)
    expect(naturalCompare('CH1', 'CH1A')).toBeLessThan(0)
  })
})

describe('the lists that name channels by number', () => {
  it('rewrites zone membership and keeps the order the radio presents it in', () => {
    const cp = doc(row(10, 'A'), row(20, 'B'), row(30, 'C'))
    cp.zones.push({ id: 'z1', name: 'Local', channels: [30, 10, 20] })

    const plan = planRenumber(DM32, cp, { order: 'slot' })
    expect(plan.rewritten).toEqual([{ kind: 'zone', id: 'z1', name: 'Local', entries: 3 }])

    const next = applyRenumber(cp, plan)
    expect(next.zones[0]!.channels, 'the order moved as well as the numbers').toEqual([3, 1, 2])
  })

  it('rewrites scan list membership the same way', () => {
    const cp = doc(row(4, 'A'), row(8, 'B'))
    cp.scanLists.push({ id: 's1', name: 'Scan', channels: [8, 4] })
    const next = applyRenumber(cp, planRenumber(DM32, cp, { order: 'slot' }))
    expect(next.scanLists[0]!.channels).toEqual([2, 1])
  })

  it('leaves the document it was given alone', () => {
    const cp = doc(row(4, 'A'))
    cp.zones.push({ id: 'z1', name: 'Local', channels: [4] })
    applyRenumber(cp, planRenumber(DM32, cp, { order: 'slot' }))
    expect([...cp.channels.keys()], 'planning mutated the codeplug').toEqual([4])
    expect(cp.zones[0]!.channels).toEqual([4])
  })

  /*
   * The case the whole module is for.
   *
   * A decoded codeplug can hold a zone entry pointing at a slot with no channel
   * in it - what the radio does with one is the question `docs/protocols/
   * dm32uv.md` still has open. A renumber is exactly the operation that turns
   * that from a number pointing at nothing into a number pointing at somebody
   * else's channel, which is not a dangling reference any more but a wrong one,
   * and nothing on the radio would say so.
   */
  it('drops a member pointing at an empty slot rather than repointing it', () => {
    const cp = doc(row(1, 'A'), row(2, 'B'))
    cp.zones.push({ id: 'z1', name: 'Local', channels: [1, 7, 2] })

    const plan = planRenumber(DM32, cp, { order: 'slot' })
    expect(plan.dropped).toEqual([{ kind: 'zone', id: 'z1', name: 'Local', channel: 7 }])
    expect(planChangesSomething(plan), 'a plan that drops an entry is not a no-op').toBe(true)

    const next = applyRenumber(cp, plan)
    expect(next.zones[0]!.channels, 'slot 7 was quietly given to another channel').toEqual([1, 2])
  })

  it('does not drop a member whose channel simply stays where it is', () => {
    const cp = doc(row(1, 'A'), row(2, 'B'))
    cp.zones.push({ id: 'z1', name: 'Local', channels: [1, 2] })
    const plan = planRenumber(DM32, cp, { order: 'slot' })
    expect(plan.dropped).toEqual([])
    expect(plan.rewritten).toEqual([])
  })
})

describe('the numbers this build cannot rewrite', () => {
  /*
   * A scan list's priority channels are decoded and never encoded, so the byte
   * the radio holds is the byte it keeps. Rewriting the document's copy would
   * show a value that was never sent, which is a worse failure than the one it
   * would paper over - so the plan reports it and leaves it exactly as it is.
   */
  it('reports a priority channel whose slot is about to hold a different channel', () => {
    const cp = doc(row(1, 'A'), row(5, 'B'))
    cp.scanLists.push({ id: 's1', name: 'Scan', channels: [1], priority1: 5, priority2: null })

    const plan = planRenumber(DM32, cp, { order: 'slot' })
    expect(plan.carried).toEqual([
      {
        kind: 'scanList',
        id: 's1',
        name: 'Scan',
        field: 'priority channel 1',
        channel: 5,
        was: 5,
        becomes: null,
      },
    ])

    const next = applyRenumber(cp, plan)
    expect(next.scanLists[0]!.priority1, 'a value that is never written was rewritten anyway').toBe(5)
  })

  it('names the channel that will arrive under a carried number', () => {
    const cp = doc(row(1, 'A'), row(2, 'B'), row(9, 'C'))
    cp.scanLists.push({ id: 's1', name: 'Scan', channels: [], priority1: 3, priority2: null })

    const plan = planRenumber(DM32, cp, { order: 'slot' })
    // Slot 3 holds nothing today and will hold what is now channel 9.
    expect(plan.carried[0]).toMatchObject({ channel: 3, was: null, becomes: 9 })
  })

  it('says nothing about a number whose slot is empty before and after', () => {
    const cp = doc(row(1, 'A'))
    cp.scanLists.push({ id: 's1', name: 'Scan', channels: [], priority1: 40, priority2: null })
    expect(planRenumber(DM32, cp, { order: 'slot' }).carried).toEqual([])
  })

  it('says nothing about a priority channel that does not move', () => {
    const cp = doc(row(1, 'A'), row(2, 'B'))
    cp.scanLists.push({ id: 's1', name: 'Scan', channels: [], priority1: 2, priority2: null })
    expect(planRenumber(DM32, cp, { order: 'slot' }).carried).toEqual([])
  })

  it('reports an emergency system whose revert channel changes underneath it', () => {
    const cp = doc(row(1, 'A'), row(6, 'B'))
    cp.emergency.push({
      id: 'demer-1',
      slot: 1,
      name: 'DEmer 1',
      alarmType: 1,
      alarmMode: 3,
      revertChannel: 6,
    })
    const plan = planRenumber(DM32, cp, { order: 'slot' })
    expect(plan.carried).toHaveLength(1)
    expect(plan.carried[0]).toMatchObject({ kind: 'emergency', field: 'revert channel', channel: 6 })
  })

  it('leaves a revert channel of 0 alone, because slot 0 is not a channel', () => {
    const cp = doc(row(1, 'A'), row(6, 'B'))
    cp.emergency.push({
      id: 'demer-1',
      slot: 1,
      name: 'DEmer 1',
      alarmType: 1,
      alarmMode: 3,
      revertChannel: 0,
    })
    expect(planRenumber(DM32, cp, { order: 'slot' }).carried).toEqual([])
  })
})

describe('settings that hold a channel number', () => {
  /*
   * These are `int` fields with a range of 0-4000 and nothing in their shape
   * says they are pointers. They are written to the radio, so a sort that left
   * them alone would have all eight APRS positions reporting on whatever
   * channel happened to land on their old number.
   */
  it('follows the channel an APRS report setting points at', () => {
    const cp = doc(row(1, 'A'), row(2, 'B'), row(30, 'APRS'))
    cp.settings.aprsReportChannel1 = 30
    cp.settings.aprsReportChannel2 = 0

    const plan = planRenumber(DM32, cp, { order: 'slot' })
    expect(plan.settings).toEqual([{ key: 'aprsReportChannel1', from: 30, to: 3 }])

    const next = applyRenumber(cp, plan)
    expect(next.settings.aprsReportChannel1).toBe(3)
    expect(next.settings.aprsReportChannel2, '0 means the current channel, not channel 0').toBe(0)
  })

  it('reports rather than moves a setting pointing at a slot that holds nothing', () => {
    const cp = doc(row(1, 'A'), row(2, 'B'), row(9, 'C'))
    cp.settings.aprsReportChannel1 = 3

    const plan = planRenumber(DM32, cp, { order: 'slot' })
    expect(plan.settings).toEqual([])
    expect(plan.carried[0]).toMatchObject({ kind: 'setting', channel: 3, was: null, becomes: 9 })
  })

  it('leaves a setting that is not declared a channel reference alone', () => {
    const cp = doc(row(1, 'A'), row(30, 'B'))
    cp.settings.aprsRepeaterActiveDelay = 30
    expect(planRenumber(DM32, cp, { order: 'slot' }).settings).toEqual([])
  })
})

describe('the slots a renumber may use', () => {
  /*
   * A UV-K5 document always carries the radio's own fourteen VFO band presets
   * at slots 201-214, past the 200 a person may program. They are not the
   * user's channels: moving one, or renumbering a real channel onto one, would
   * overwrite the radio's own settings with a memory.
   */
  it('neither moves a radio\'s own pseudo-channels nor renumbers onto them', () => {
    const image = uvk5Image()
    const cp = createDriver('uvk5').decode(image)
    const presets = [...cp.channels.keys()].filter((s) => s > 200)
    expect(presets.length, 'the fixture should carry the band presets').toBeGreaterThan(0)

    const plan = planRenumber(UVK5, cp, { order: 'slot' })
    for (const slot of presets) {
      expect(plan.mapping.has(slot), `preset ${slot} was picked up as a user channel`).toBe(false)
    }
    expect([...plan.mapping.values()].filter((s) => s > 200)).toEqual([])

    const next = applyRenumber(cp, plan)
    for (const slot of presets) {
      expect(next.channels.get(slot), `preset ${slot} did not survive`).toEqual(cp.channels.get(slot))
    }
  })

  it('steps over a slot the radio has no memory for', () => {
    const cp = doc(row(1, 'A'), row(2, 'B'), row(3, 'C'))
    const plan = planRenumber(DM32, cp, { order: 'slot', usable: (s) => s !== 2 })
    expect([...plan.mapping.entries()]).toEqual([
      [1, 1],
      [2, 3],
      [3, 4],
    ])
  })

  it('refuses to apply a plan that could not place every channel', () => {
    const cp = doc(row(1, 'A'), row(2, 'B'))
    const plan = planRenumber(DM32, cp, { order: 'slot', usable: (s) => s === 1 })
    expect(plan.unplaced).toHaveLength(1)
    expect(() => applyRenumber(cp, plan)).toThrow(/no slot/)
  })
})

/*
 * A plan is made for a preview and applied once somebody agrees to it, and the
 * document can move in between - undo and redo keep working while a dialog is
 * open. Applying a stale plan would overwrite a channel that arrived in the
 * meantime, and it is the quietest failure in this module: the diff only sees
 * the bytes that were written, and the history would record the overwrite as
 * the state to undo to.
 */
describe('a plan that no longer fits the codeplug', () => {
  it('refuses when a channel has appeared in a slot the plan means to fill', () => {
    const cp = doc(row(1, 'A'), row(9, 'B'))
    const plan = planRenumber(DM32, cp, { order: 'slot' })
    expect(plan.moves).toEqual([{ from: 9, to: 2, name: 'B' }])

    // Somebody programmed slot 2 between the preview and the confirmation.
    cp.channels.set(2, row(2, 'ARRIVED'))

    expect(planFitsDocument(cp, plan)).toBe(false)
    expect(() => applyRenumber(cp, plan)).toThrow(/changed after this ordering/)
  })

  it('refuses when a channel the plan means to move has gone', () => {
    const cp = doc(row(1, 'A'), row(9, 'B'))
    const plan = planRenumber(DM32, cp, { order: 'slot' })
    cp.channels.delete(9)
    expect(planFitsDocument(cp, plan)).toBe(false)
  })

  it('accepts a plan against the codeplug it was made for', () => {
    const cp = doc(row(1, 'A'), row(9, 'B'))
    expect(planFitsDocument(cp, planRenumber(DM32, cp, { order: 'slot' }))).toBe(true)
  })

  it('is not troubled by a channel outside the programmable range', () => {
    // The UV-K5's band presets sit at 201-214 and are in no plan's mapping.
    const image = uvk5Image()
    const cp = createDriver('uvk5').decode(image)
    expect(planFitsDocument(cp, planRenumber(UVK5, cp, { order: 'name' }))).toBe(true)
  })
})

describe('against the radio the zones came from', () => {
  const driver = createDriver('dm32uv')

  it('asks the image which slots exist rather than assuming a flat bank', () => {
    const image = dm32Image()
    expect(driver.storesSlot, 'the DM-32UV has a sparse bank and must answer this').toBeTypeOf('function')
    // Blocks 0x12-0x14 cover channels 1-254; this unit has no 0x15-0x17.
    expect(driver.storesSlot!(image, 1)).toBe(true)
    expect(driver.storesSlot!(image, 254)).toBe(true)
    expect(driver.storesSlot!(image, 255)).toBe(false)
  })

  /*
   * The end-to-end shape of the feature: empty some slots, close the gaps, and
   * check that the zones still name the same channels and that the result is
   * something the encoder will take. A zone that resolved to
   * "MURS-1, MURS-2, MURS-3" before must resolve to those three afterwards,
   * whatever numbers they are wearing.
   */
  it('keeps every zone naming the same channels across a compact', () => {
    const image = dm32Image()
    const cp = driver.decode(image)

    const namesIn = (c: Codeplug) =>
      c.zones.map((z) => z.channels.map((n) => c.channels.get(n)?.name ?? `MISSING ${n}`))
    const before = namesIn(cp)
    expect(before.flat(), 'the fixture zone entries should all resolve').not.toContain(
      expect.stringContaining('MISSING'),
    )

    // Empty four slots out of the middle, the way the table's delete does.
    for (const slot of [5, 6, 24, 40]) {
      cp.channels.delete(slot)
      for (const z of cp.zones) z.channels = z.channels.filter((n) => n !== slot)
      for (const l of cp.scanLists) l.channels = l.channels.filter((n) => n !== slot)
    }
    const gapped = namesIn(cp)

    const plan = planRenumber(DM32, cp, {
      order: 'slot',
      usable: (s) => driver.storesSlot!(image, s),
    })
    expect(plan.moves.length, 'closing four gaps should move the channels after them').toBeGreaterThan(0)

    const next = applyRenumber(cp, plan)
    expect(namesIn(next)).toEqual(gapped)
    expect([...next.channels.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: next.channels.size }, (_, i) => i + 1),
    )
  })

  it('produces a codeplug the encoder takes, with nothing landing outside the driver\'s claim', () => {
    const image = dm32Image()
    const cp = driver.decode(image)
    for (const slot of [5, 6, 24, 40]) {
      cp.channels.delete(slot)
      for (const z of cp.zones) z.channels = z.channels.filter((n) => n !== slot)
      for (const l of cp.scanLists) l.channels = l.channels.filter((n) => n !== slot)
    }

    const next = applyRenumber(
      cp,
      planRenumber(DM32, cp, { order: 'slot', usable: (s) => driver.storesSlot!(image, s) }),
    )

    const diff = diffImages(image, driver.encode(next, image), driver)
    expect(diff.unowned, 'a renumber changed bytes the driver does not claim').toEqual([])
    expect(diff.changedBytes, 'a renumber that sends nothing has not happened').toBeGreaterThan(0)
  })

  it('changes nothing at all when the bank is already in order', () => {
    const image = dm32Image()
    const cp = driver.decode(image)
    const plan = planRenumber(DM32, cp, {
      order: 'slot',
      usable: (s) => driver.storesSlot!(image, s),
    })
    expect(planChangesSomething(plan), 'the fixture holds channels 1-45 with no gaps').toBe(false)

    const diff = diffImages(image, driver.encode(applyRenumber(cp, plan), image), driver)
    expect(diff.changedBytes, 'a no-op renumber still sent bytes to the radio').toBe(0)
  })
})
