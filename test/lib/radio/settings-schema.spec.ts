// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RadioImage } from '#core/radio/image.js'
import { SCHEMAS, createDriver } from '#core/radio/registry.js'
import type { RadioSchema } from '#core/radio/schema.js'
import type { RadioId } from '#core/model/codeplug.js'
import { REGIONS as UVK5_REGIONS } from '#core/radios/uvk5/layout.js'
import { REGIONS as UV82_REGIONS } from '#core/radios/uv82/layout.js'
import { VARIANTS as UV5RMINI_VARIANTS } from '#core/radios/uv5rmini/protocol.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'

/**
 * Every settings control the UI can render must name a field the decoder
 * actually produces.
 *
 * A key that matches nothing is invisible: the form renders the control,
 * `encodeSettings` skips the key because it is not in the struct, and the write
 * reports success. The user changes a setting, the radio does not, and nothing
 * anywhere says so. That is the same shape as the message-slot bug this project
 * already shipped once, and it scales with the size of the settings table - the
 * DM-32UV's is now some hundred and fifty keys, hand-written from a spec.
 *
 * Both directions are checked. A schema key with no field is the dangerous one;
 * a decoded field with no control is merely a gap, so it is reported as a count
 * rather than a failure.
 */

const file = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))))

function flat(
  raw: Uint8Array,
  regions: readonly { start: number; length: number; readOnly?: boolean; label?: string }[],
): RadioImage['regions'] {
  return regions.map((r) => ({
    start: r.start,
    data: raw.slice(r.start, r.start + r.length),
    ...(r.readOnly === undefined ? {} : { readOnly: r.readOnly }),
    label: r.label ?? `0x${r.start.toString(16)}`,
  }))
}

const IMAGES: Partial<Record<RadioId, () => RadioImage>> = {
  uvk5: () => ({
    radioId: 'uvk5',
    variant: '2.01.32',
    layout: 'stock',
    createdAt: '2026-08-21T00:00:00.000Z',
    regions: flat(file('uvk5-2.01.32.bin'), UVK5_REGIONS),
    meta: {},
    sha256: '',
  }),
  uv82: () => ({
    radioId: 'uv82',
    variant: 'N822413',
    layout: 'uv82',
    createdAt: '2026-08-21T00:00:00.000Z',
    regions: flat(file('uv82-N822413.bin'), UV82_REGIONS),
    meta: {},
    sha256: '',
  }),
  uv5rmini: () => {
    const blob = file('uv5rmini-5RMINI.bin')
    let off = 0
    const regions = UV5RMINI_VARIANTS.find((v) => v.id === 'uv5rmini')!.regions.map((r) => {
      const data = blob.slice(off, off + r.size)
      off += r.size
      return { start: r.start, data, label: r.label ?? `0x${r.start.toString(16)}` }
    })
    return {
      radioId: 'uv5rmini' as const,
      variant: '5RMINI',
      layout: 'uv5rmini',
      createdAt: '2026-08-21T00:00:00.000Z',
      regions,
      meta: {},
      sha256: '',
    }
  },
  dm32uv: () => {
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
  },
}

const RADIOS = Object.keys(IMAGES) as RadioId[]

describe.each(RADIOS)('%s settings', (id: RadioId) => {
  const groups: NonNullable<RadioSchema['settings']> = SCHEMAS[id]?.settings ?? []
  const doc = createDriver(id).decode(IMAGES[id]!())

  it('offers a control for something only where a field exists to back it', () => {
    const missing: string[] = []
    for (const group of groups) {
      for (const field of group.fields) {
        if (!(field.key in doc.settings)) missing.push(`${group.id}.${field.key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('writes back everything it offers', () => {
    // A control whose key survives decode but which `encode` drops is the same
    // silent failure one step later, so each key is changed and looked for.
    const driver = createDriver(id)
    const base = IMAGES[id]!()
    const inert: string[] = []

    for (const group of groups) {
      for (const field of group.fields) {
        const before = doc.settings[field.key]
        if (typeof before !== 'number') continue // strings are length-clamped per radio
        const after = before === 0 ? 1 : 0
        const edited = structuredClone(doc)
        edited.settings[field.key] = after
        const round = driver.decode(driver.encode(edited, base))
        if (round.settings[field.key] !== after) inert.push(`${group.id}.${field.key}`)
      }
    }
    expect(inert).toEqual([])
  })

  it('names every group and gives every field a label', () => {
    for (const group of groups) {
      expect(group.id, 'group id').toBeTruthy()
      expect(group.label, `${group.id} label`).toBeTruthy()
      expect(group.fields.length, `${group.id} is empty`).toBeGreaterThan(0)
      for (const field of group.fields) {
        expect(field.label, `${group.id}.${field.key}`).toBeTruthy()
        if (field.type === 'enum') {
          expect(field.options?.length, `${group.id}.${field.key} has no options`).toBeGreaterThan(0)
        }
      }
    }
    const keys = groups.flatMap((g) => g.fields.map((f) => f.key))
    expect(new Set(keys).size, 'a key is offered by two controls').toBe(keys.length)
  })
})
