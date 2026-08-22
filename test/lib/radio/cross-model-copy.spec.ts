// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RadioImage } from '#core/radio/image.js'
import { planPlacement, programmedOnly } from '#core/radio/place.js'
import { SCHEMAS, createDriver } from '#core/radio/registry.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import { REGIONS } from '#core/radios/uvk5/layout.js'
import { acceptTranslation, translateChannels } from '#core/radio/translate.js'

/**
 * The cross-model copy, composed exactly as the open-file flow composes it.
 *
 * Every step of this was already covered on its own and the feature still
 * placed nothing: `translate.spec.ts` proved the clamp rules, and the only test
 * over the component that drives them matched its source text for a tag name.
 * The defect lived in the arithmetic joining the two, which is precisely what
 * per-unit tests do not see.
 *
 * So this runs the whole pipeline over two real radio images and asserts on the
 * outcome a person would notice: how many channels arrive, and where.
 */

const file = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))))

function uvk5Image(): RadioImage {
  const raw = file('uvk5-2.01.32.bin')
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
  const blob = file('dm32uv-DM32.01.01.040.blocks.bin')
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

/** Exactly what `OpenCodeplugButton.vue` does, in the same order. */
function copy(from: RadioImage, to: RadioImage) {
  const source = createDriver(from.radioId)
  const target = createDriver(to.radioId)
  const sourceDoc = source.decode(from)
  const targetDoc = target.decode(to)

  const result = translateChannels({
    channels: programmedOnly(source.schema, [...sourceDoc.channels.values()]).sort(
      (a, b) => a.index - b.index,
    ),
    target: target.schema,
    ...(target.rfFor ? { rf: target.rfFor(targetDoc) } : {}),
  })
  const taken = acceptTranslation(result, {})
  const plan = planPlacement(target.schema, targetDoc.channels.keys(), taken)
  return { result, taken, plan, sourceDoc, targetDoc }
}

describe('copying a DM-32UV bank onto a UV-K5', () => {
  // The direction that was broken. Nothing arrived, and the flow said it had
  // copied zero while the dialog had offered to copy dozens.
  const { taken, plan, targetDoc } = copy(dm32Image(), uvk5Image())

  it('offers channels to copy at all', () => {
    expect(taken.length).toBeGreaterThan(0)
  })

  it('actually places them', () => {
    expect(plan.placed.length).toBeGreaterThan(0)
    expect(plan.placed).toHaveLength(taken.length)
    expect(plan.unplaced).toEqual([])
  })

  it('places them inside the programmable range, never on a band preset', () => {
    const reserved = new Set(SCHEMAS.uvk5!.memory.specialChannels.map((s) => s.index))
    for (const p of plan.placed) {
      expect(p.slot).toBeGreaterThanOrEqual(1)
      expect(p.slot).toBeLessThanOrEqual(200)
      expect(reserved.has(p.slot)).toBe(false)
    }
  })

  it('never lands on a slot the UV-K5 already uses', () => {
    const occupied = new Set(targetDoc.channels.keys())
    for (const p of plan.placed) expect(occupied.has(p.slot)).toBe(false)
  })
})

describe('copying a UV-K5 bank onto a DM-32UV', () => {
  const { result, taken, plan } = copy(uvk5Image(), dm32Image())

  it('does not offer the UV-K5’s own band presets as channels', () => {
    // Fourteen of them, and letting them through copies duplicate A/B pairs for
    // whichever happen to sit in a band the DM-32UV covers while the rest are
    // refused - which reads like the clamp working rather than like junk.
    const source = createDriver('uvk5')
    const all = [...source.decode(uvk5Image()).channels.values()]
    expect(all).toHaveLength(result.rows.length + 14)
    for (const name of ['F1(50M-76M)A', 'F3(136M-174M)B', 'F7(470M-600M)B']) {
      expect(result.rows.some((r) => r.channel?.name === name)).toBe(false)
    }
  })

  it('places everything it accepted', () => {
    expect(plan.placed).toHaveLength(taken.length)
    expect(plan.unplaced).toEqual([])
  })

  it('carries the source radio’s own block so copying back is lossless', () => {
    const withExtras = plan.placed.filter((p) => p.channel.extras.uvk5 !== undefined)
    expect(withExtras.length).toBeGreaterThan(0)
  })
})

describe('the pipeline still refuses what it should', () => {
  it('refuses a channel the target cannot receive', () => {
    const { result } = copy(uvk5Image(), dm32Image())
    // The DM-32UV covers 136-174 and 400-480; the UV-K5 fixture reaches wider.
    const rx = result.refusals.filter((r) => r.rule === 'rx-band')
    for (const r of rx) expect(r.why).toMatch(/outside every band/)
  })

  it('reports refusals rather than silently dropping them', () => {
    const { result, taken } = copy(uvk5Image(), dm32Image())
    expect(result.rows).toHaveLength(taken.length + result.refusals.length)
  })
})
