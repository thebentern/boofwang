// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Channel } from '#core/model/channel.js'
import type { RadioImage } from '#core/radio/image.js'
import { firstFreeSlot, isReservedSlot, planPlacement, programmedOnly, slotRange } from '#core/radio/place.js'
import { SCHEMAS, createDriver } from '#core/radio/registry.js'
import { REGIONS } from '#core/radios/uvk5/layout.js'

/**
 * Placement, against the radio that broke it.
 *
 * The bug this module exists for was invisible from inside the component that
 * held it: copying a bank onto a UV-K5 placed nothing, reported success, and
 * looked to the user like their file was at fault. Nothing caught it because
 * the only test over that component matched its source text for a tag name.
 *
 * So these run against the real `uvk5-2.01.32.bin` fixture rather than a
 * hand-built schema. A stub with no `specialChannels` passes the buggy
 * arithmetic just as happily as the fixed version.
 */

const UVK5 = SCHEMAS.uvk5!
const DM32 = SCHEMAS.dm32uv!

function uvk5Image(): RadioImage {
  const raw = new Uint8Array(
    readFileSync(fileURLToPath(new URL('../../fixtures/images/uvk5-2.01.32.bin', import.meta.url))),
  )
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

const row = (index: number, name = `CH${index}`): Channel =>
  ({ index, name, rxFreq: 146_520_000, txAllowed: true, extras: { vendor: {} } }) as unknown as Channel

describe('the programmable range', () => {
  it('stops at the last slot a person may write, not at the last key in the document', () => {
    const r = slotRange(UVK5)
    expect(r.first).toBe(1)
    expect(r.last).toBe(200)
    // The fourteen VFO band presets, which live above it.
    expect([...r.reserved].sort((a, b) => a - b)).toEqual([
      201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214,
    ])
  })

  it('derives the last slot rather than assuming it equals the channel count', () => {
    // True only while firstIndex is 1, which is every radio here today and is
    // not a thing to build on.
    for (const id of ['uvk5', 'uv82', 'uv5r', 'uv5rmini', 'dm32uv'] as const) {
      const s = SCHEMAS[id]!
      expect(slotRange(s).last, id).toBe(s.memory.firstIndex + s.memory.channelCount - 1)
    }
  })

  it('reports a reserved slot as reserved on a radio that has them, and none on one that does not', () => {
    expect(isReservedSlot(UVK5, 201)).toBe(true)
    expect(isReservedSlot(UVK5, 200)).toBe(false)
    expect(slotRange(DM32).reserved.size).toBe(0)
  })
})

describe('placing channels onto a real UV-K5 codeplug', () => {
  const doc = createDriver('uvk5').decode(uvk5Image())
  const occupied = [...doc.channels.keys()]

  it('is the exact shape that used to place nothing', () => {
    // Guarding the premise: if a future decode stops returning the band presets
    // this whole test file is checking something else, and should say so.
    expect(Math.max(...occupied)).toBe(214)
    expect(occupied.filter((k) => k > 200)).toHaveLength(14)
    // The old arithmetic, kept here as the thing being refuted.
    const oldFirstFree = Math.max(...occupied) + 1
    expect(oldFirstFree).toBe(215)
    expect(oldFirstFree).toBeGreaterThan(UVK5.memory.channelCount)
  })

  it('places every channel it is given', () => {
    const rows = Array.from({ length: 39 }, (_, i) => row(i + 1))
    const plan = planPlacement(UVK5, occupied, rows)
    expect(plan.unplaced).toEqual([])
    expect(plan.placed).toHaveLength(39)
  })

  it('starts after the highest programmed slot, ignoring the band presets above it', () => {
    const highestReal = Math.max(...occupied.filter((k) => k <= 200))
    const plan = planPlacement(UVK5, occupied, [row(1)])
    expect(plan.placed[0]!.slot).toBe(highestReal + 1)
    expect(firstFreeSlot(UVK5, occupied)).toBe(highestReal + 1)
  })

  it('never lands on a reserved slot', () => {
    // Fill the radio right up so placement has to run through 201-214.
    const nearlyFull = Array.from({ length: 190 }, (_, i) => i + 1)
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1))
    const plan = planPlacement(UVK5, [...nearlyFull, ...occupied.filter((k) => k > 200)], rows)
    for (const p of plan.placed) {
      expect(p.slot).toBeLessThanOrEqual(200)
      expect(isReservedSlot(UVK5, p.slot)).toBe(false)
    }
    // 191-200 is ten slots; the rest do not fit and are reported, not dropped.
    expect(plan.placed).toHaveLength(10)
    expect(plan.unplaced).toHaveLength(20)
  })

  it('renumbers each channel to the slot it landed in', () => {
    const plan = planPlacement(UVK5, occupied, [row(7, 'A'), row(9, 'B')])
    expect(plan.placed.map((p) => p.channel.index)).toEqual(plan.placed.map((p) => p.slot))
    expect(plan.placed.map((p) => p.channel.name)).toEqual(['A', 'B'])
  })

  it('never writes over an occupied slot, even a sparse one', () => {
    const sparse = [1, 2, 3, 50, 51]
    const plan = planPlacement(UVK5, sparse, [row(1), row(2)])
    for (const p of plan.placed) expect(sparse).not.toContain(p.slot)
    // Appends after 51 rather than filling 4-49, which is the documented choice.
    expect(plan.placed.map((p) => p.slot)).toEqual([52, 53])
  })

  it('starts at firstIndex when nothing is programmed', () => {
    expect(planPlacement(UVK5, [], [row(1)]).placed[0]!.slot).toBe(UVK5.memory.firstIndex)
    expect(firstFreeSlot(UVK5, [])).toBe(1)
  })

  it('reports a full radio rather than placing anything', () => {
    const full = Array.from({ length: 200 }, (_, i) => i + 1)
    const plan = planPlacement(UVK5, full, [row(1)])
    expect(plan.placed).toEqual([])
    expect(plan.unplaced).toHaveLength(1)
    expect(firstFreeSlot(UVK5, full)).toBeNull()
  })
})

describe('the source side', () => {
  it('drops the donor radio’s own band presets', () => {
    const doc = createDriver('uvk5').decode(uvk5Image())
    const all = [...doc.channels.values()]
    const real = programmedOnly(UVK5, all)
    expect(all.length - real.length).toBe(14)
    expect(real.every((c) => c.index <= 200)).toBe(true)
  })

  it('leaves a radio without reserved slots untouched', () => {
    const rows = [row(1), row(2), row(4000)]
    expect(programmedOnly(DM32, rows)).toHaveLength(3)
  })

  it('drops a row outside the programmable range entirely', () => {
    expect(programmedOnly(UVK5, [row(0), row(1), row(201), row(999)]).map((c) => c.index)).toEqual([1])
  })
})
