// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { createUv5gDriver } from '#core/radios/uv5g/driver.js'
import { UV5G_SETTINGS_GROUPS } from '#core/radios/uv5g/schema.js'
import { decodeSettings } from '#core/radios/uv82/driver.js'
import { SETTINGS_BASE, SETTINGS_CLAIM } from '#core/radios/uv82/layout.js'
import type { RadioImage } from '#core/radio/image.js'

/**
 * The UV-5G's settings, checked against CHIRP rather than against themselves.
 *
 * `uv5g-chirp-settings.json` was produced by `scripts/dump-uv5r-settings.py`
 * over this exact image - CHIRP's own `bitwise` engine and the `MEM_FORMAT`
 * out of `uv5r.py`. The settings block is byte-identical across the classic
 * family, so most of the machinery is the uv82 module's and is tested there;
 * what this file pins is that the shared decoder reads THIS radio's bytes the
 * way CHIRP does, and that the controls offered for this radio exist.
 */
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv5g-HN5RV011.bin', import.meta.url))),
)
const CHIRP = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/uv5g-chirp-settings.json', import.meta.url)), 'utf8'),
) as {
  settings: Record<string, number | string>
  poweron_msg: { line1: string; line2: string }
}

function image(): RadioImage {
  return {
    radioId: 'uv5g', variant: 'HN5RV011', layout: 'uv5g', createdAt: '2026-08-30T00:00:00.000Z',
    regions: [{ start: 0, data: RAW.slice(), readOnly: false, label: 'image' }], meta: {}, sha256: '',
  }
}
const driver = createUv5gDriver({ enableWrite: true })

/** Dotted bit keys compare against CHIRP's flat field names. */
const flatten = (settings: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(settings).map(([k, v]) => [k.includes('.') ? k.slice(k.indexOf('.') + 1) : k, v]))

describe('the settings block, against CHIRP', () => {
  const mine = flatten(decodeSettings(RAW))
  const fields = Object.entries(CHIRP.settings).filter(([, v]) => typeof v === 'number')

  it('reads all 48 fields CHIRP reads', () => {
    expect(fields.length).toBeGreaterThanOrEqual(48)
    expect(Object.keys(mine)).toEqual(expect.arrayContaining(fields.map(([k]) => k)))
  })

  it.each(fields)('agrees on %s', (key, value) => {
    expect(mine[key]).toBe(value)
  })

  it('reads the power-on message the radio actually shows', () => {
    // "BAOFENG UV-5G" across the two seven-character lines: the shell's
    // branding, on a radio CHIRP files under Radioddity.
    expect(mine.line1).toBe('BAOFENG')
    expect(mine.line1).toBe(CHIRP.poweron_msg.line1)
    expect(mine.line2).toBe(CHIRP.poweron_msg.line2.trimEnd())
  })
})

describe('the controls offered for this radio', () => {
  it('offers only what is decoded, and nothing the writer cannot reach', () => {
    const keys = new Set(Object.keys(decodeSettings(RAW)))
    for (const group of UV5G_SETTINGS_GROUPS) {
      for (const field of group.fields) {
        expect(keys.has(field.key), `${group.id}.${field.key} is offered but never decoded`).toBe(true)
        expect(field.key.startsWith('poweronMsg.'), `${field.key} cannot be written`).toBe(false)
      }
    }
    expect(SETTINGS_BASE + SETTINGS_CLAIM).toBeLessThanOrEqual(0x1808)
  })

  // CHIRP's `_get_settings` guards both of these by model: `singleptt` under
  // `isinstance(self, BaofengUV82Radio)` or `MODEL == "UV-82HP"`, `vfomrlock`
  // under either of those or `MODEL == "F-11"`. `RadioddityUV5GRadio` is a
  // bare subclass of `BaofengUV5R` and matches none of them.
  it.each(['f2b.singleptt', 'f2b.vfomrlock'])('does not offer %s, which CHIRP withholds from this model', (key) => {
    const keys = UV5G_SETTINGS_GROUPS.flatMap((g) => g.fields.map((f) => f.key))
    expect(keys).not.toContain(key)
    // The byte itself is still decoded and carried through - it is the control
    // that is withheld, not the data.
    expect(Object.keys(decodeSettings(RAW))).toContain(key)
  })
})

describe('writing settings back', () => {
  it('round-trips the whole image byte for byte', () => {
    const img = image()
    const out = driver.encode(driver.decode(img), img)
    expect(equalBytes(out.regions[0]!.data, RAW)).toBe(true)
  })

  it('changes one byte for one setting and leaves the rest alone', () => {
    const img = image()
    const doc = driver.decode(img)
    expect(doc.settings.squelch).toBe(5)
    doc.settings.squelch = 7

    const out = driver.encode(doc, img).regions[0]!.data
    const moved = [...out].map((b, i) => [i, b] as const).filter(([i, b]) => b !== RAW[i])
    expect(moved).toEqual([[SETTINGS_BASE, 7]])
  })
})
