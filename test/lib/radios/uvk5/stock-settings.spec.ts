// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { settingsForLayout } from '#core/radio/schema.js'
import { createUvk5Driver } from '#core/radios/uvk5/driver.js'
import { decodeStockSettings, encodeStockSettings } from '#core/radios/uvk5/encode.js'
import { STOCK_SETTINGS_BLOCKS } from '#core/radios/uvk5/layout.js'
import { UVK5_SCHEMA } from '#core/radios/uvk5/schema.js'
import { PROG_SIZE } from '#core/radios/uvk5/protocol.js'
import type { RadioImage } from '#core/radio/image.js'

/**
 * The stock firmware's settings, checked against CHIRP rather than themselves.
 *
 * `uvk5-chirp-settings.json` comes from `scripts/dump-uvk5-settings.py`, which
 * parses this image with CHIRP's own `bitwise` engine and the `MEM_FORMAT` out
 * of `uvk5.py`. Stock keeps its settings in seven small blocks where egzumer
 * keeps them in one contiguous window, and the addresses are not a
 * rearrangement of each other - which is exactly the situation where a
 * transcription can look right, round-trip perfectly, and still be reading the
 * wrong byte.
 */
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uvk5-2.01.32.bin', import.meta.url))),
)
const CHIRP = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/uvk5-chirp-settings.json', import.meta.url)), 'utf8'),
) as { settings: Record<string, number>; logo: { line1: string; line2: string } }

function image(): RadioImage {
  return {
    radioId: 'uvk5', variant: '2.01.32', layout: 'stock', createdAt: '2026-08-21T00:00:00.000Z',
    regions: [
      { start: 0, data: RAW.slice(0, PROG_SIZE), label: 'programmable' },
      { start: PROG_SIZE, data: RAW.slice(PROG_SIZE), label: 'calibration', readOnly: true },
    ],
    meta: {}, sha256: '',
  }
}
const driver = createUvk5Driver({ enableWrite: true })

/** CHIRP writes snake_case; this build writes camelCase. Compare on the letters. */
const key = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')

describe('the stock settings, against CHIRP', () => {
  const mine = new Map(Object.entries(decodeStockSettings(RAW)).map(([k, v]) => [key(k), v]))
  const fields = Object.entries(CHIRP.settings)

  it('reads every field CHIRP reads', () => {
    expect(fields.length).toBe(44)
    for (const [k] of fields) expect(mine.has(key(k)), `${k} is not decoded`).toBe(true)
  })

  it.each(fields)('agrees on %s', (name, value) => {
    expect(mine.get(key(name))).toBe(value)
  })

  it('reads the welcome lines the radio shows at power-on', () => {
    expect(mine.get('logoline1')).toBe(CHIRP.logo.line1)
    expect(mine.get('logoline2')).toBe(CHIRP.logo.line2)
  })
})

describe('writing stock settings back', () => {
  it('round-trips the image byte for byte', () => {
    const img = image()
    const out = driver.encode(driver.decode(img), img)
    for (const region of out.regions) {
      const before = img.regions.find((r) => r.start === region.start)!
      expect(equalBytes(region.data, before.data), region.label).toBe(true)
    }
  })

  it('changes one byte for one setting and leaves the rest alone', () => {
    const img = image()
    const doc = driver.decode(img)
    expect(doc.settings.squelch).toBe(4)
    doc.settings.squelch = 1

    const out = driver.encode(doc, img).regions[0]!.data
    const moved = [...out].map((b, i) => [i, b] as const).filter(([i, b]) => b !== RAW[i])
    expect(moved).toEqual([[0x0e71, 1]])
  })

  it('writes the welcome line, which is a string rather than a byte', () => {
    const img = image()
    const doc = driver.decode(img)
    doc.settings.logoLine1 = 'BOOFWANG'

    const back = driver.decode({ ...img, regions: [{ ...img.regions[0]!, data: driver.encode(doc, img).regions[0]!.data }, img.regions[1]!] })
    expect(back.settings.logoLine1).toBe('BOOFWANG')
  })

  it('never rewrites the eight password bytes', () => {
    // Not modelled at all, which is the behaviour wanted for a secret: they
    // round-trip because nothing names them, and boofwang neither shows one
    // nor writes one.
    const img = image()
    const doc = driver.decode(img)
    doc.settings.squelch = 9
    doc.settings.beepControl = 0

    const out = driver.encode(doc, img).regions[0]!.data
    expect(equalBytes(out.subarray(0x0e98, 0x0ea0), RAW.subarray(0x0e98, 0x0ea0))).toBe(true)
    const owned = driver.ownedRanges(0)
    for (let addr = 0x0e98; addr < 0x0ea0; addr++) {
      expect(owned.some(([s, e]) => addr >= s && addr < e), `0x${addr.toString(16)} is claimed`).toBe(false)
    }
  })

  it('ignores a value of the wrong type rather than coercing it', () => {
    const mem = RAW.slice()
    encodeStockSettings(mem, { squelch: 'loud' as unknown as number, logoLine1: 7 as unknown as string })
    expect(equalBytes(mem, RAW)).toBe(true)
  })
})

describe('which layout gets which form', () => {
  it('offers the stock groups to a stock image and none of egzumer’s', () => {
    const groups = settingsForLayout(UVK5_SCHEMA, 'stock')
    expect(groups.length).toBeGreaterThan(0)
    expect(groups.every((g) => g.id.startsWith('stock-'))).toBe(true)
  })

  it('offers egzumer none of the stock groups', () => {
    const groups = settingsForLayout(UVK5_SCHEMA, 'egzumer')
    expect(groups.length).toBeGreaterThan(0)
    expect(groups.some((g) => g.id.startsWith('stock-'))).toBe(false)
  })

  it('backs every stock control with a key the stock decoder produces', () => {
    const decoded = new Set(Object.keys(decodeStockSettings(RAW)))
    for (const group of settingsForLayout(UVK5_SCHEMA, 'stock')) {
      for (const field of group.fields) {
        expect(decoded.has(field.key), `${group.id}.${field.key} is offered but never decoded`).toBe(true)
      }
    }
  })

  it('does not offer the remote-kill flag, whose only effect is to stop the radio', () => {
    const offered = settingsForLayout(UVK5_SCHEMA, 'stock').flatMap((g) => g.fields.map((f) => f.key))
    expect(offered).not.toContain('killed')
    // Decoded all the same, so it round-trips and can be seen.
    expect(Object.keys(decodeStockSettings(RAW))).toContain('killed')
  })

  it('keeps every claimed settings block below the calibration boundary', () => {
    for (const { base, struct } of STOCK_SETTINGS_BLOCKS) {
      expect(base + struct.size, `0x${base.toString(16)}`).toBeLessThanOrEqual(PROG_SIZE)
    }
  })
})
