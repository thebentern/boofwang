// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { createUv82Driver, decodeSettings, encodeSettings } from '#core/radios/uv82/driver.js'
import { SETTINGS_BASE, SETTINGS_CLAIM } from '#core/radios/uv82/layout.js'
import { UV82_SETTINGS_GROUPS } from '#core/radios/uv82/schema.js'
import type { RadioImage } from '#core/radio/image.js'

/**
 * The UV-82's settings, checked against CHIRP rather than against themselves.
 *
 * `uv82-chirp-settings.json` was produced by `scripts/dump-uv5r-settings.py`,
 * which parses this exact image with CHIRP's own `bitwise` engine and the
 * `MEM_FORMAT` out of `uv5r.py`. So what is asserted here is agreement with the
 * reference implementation on real hardware bytes, which is a different and far
 * stronger claim than agreement with a second reading of the same spec by the
 * same author. An offset that slipped by one would pass a round-trip test and
 * fail this one.
 */
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv82-N822413.bin', import.meta.url))),
)
const CHIRP = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/uv82-chirp-settings.json', import.meta.url)), 'utf8'),
) as {
  settings: Record<string, number | string>
  poweron_msg: { line1: string; line2: string }
}

function image(): RadioImage {
  return {
    radioId: 'uv82', variant: 'N822413', layout: 'uv82', createdAt: '2026-08-21T00:00:00.000Z',
    regions: [{ start: 0, data: RAW.slice(), readOnly: false, label: 'image' }], meta: {}, sha256: '',
  }
}
const driver = createUv82Driver({ enableWrite: true })

/** Dotted bit keys compare against CHIRP's flat field names. */
const flatten = (settings: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(settings).map(([k, v]) => [k.includes('.') ? k.slice(k.indexOf('.') + 1) : k, v]))

describe('the settings block, against CHIRP', () => {
  const mine = flatten(decodeSettings(RAW))

  // Every numeric field CHIRP's parser reports, the unknown runs included. The
  // byte arrays are skipped only because they have no single value to compare.
  const fields = Object.entries(CHIRP.settings).filter(([, v]) => typeof v === 'number')

  it('reads all 48 fields CHIRP reads', () => {
    expect(fields.length).toBeGreaterThanOrEqual(48)
    expect(Object.keys(mine)).toEqual(expect.arrayContaining(fields.map(([k]) => k)))
  })

  it.each(fields)('agrees on %s', (key, value) => {
    expect(mine[key]).toBe(value)
  })

  it('reads the power-on message the radio actually shows', () => {
    expect(mine.line1).toBe(CHIRP.poweron_msg.line1)
    expect(mine.line2).toBe(CHIRP.poweron_msg.line2.trimEnd())
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
    expect(doc.settings.squelch).toBe(2)
    doc.settings.squelch = 7

    const out = driver.encode(doc, img).regions[0]!.data
    const moved = [...out].map((b, i) => [i, b] as const).filter(([i, b]) => b !== RAW[i])
    expect(moved).toEqual([[SETTINGS_BASE, 7]])
  })

  it('sets a single bit without disturbing the six sharing its byte', () => {
    const img = image()
    const doc = driver.decode(img)
    const before = RAW[SETTINGS_BASE + 0x2a]!
    doc.settings['f2a.fmradio'] = doc.settings['f2a.fmradio'] === 1 ? 0 : 1

    const out = driver.encode(doc, img).regions[0]!.data
    const after = out[SETTINGS_BASE + 0x2a]!
    expect(after ^ before, 'more than the fmradio bit moved').toBe(0b0001_0000)
    expect(driver.decode({ ...img, regions: [{ ...img.regions[0]!, data: out }] }).settings['f2a.displayab'])
      .toBe(doc.settings['f2a.displayab'])
  })

  it('never writes the power-on message, which the writer cannot reach', () => {
    // It lives past the end of the main block. A control that changed it would
    // report a change the radio never receives.
    const mem = RAW.slice()
    encodeSettings(mem, { 'poweronMsg.line1': 'NOPE' })
    expect(equalBytes(mem, RAW)).toBe(true)
  })

  it('ignores a value of the wrong type rather than coercing it', () => {
    // A settings map can arrive from an imported file. A string where a byte
    // belongs must not quietly become zero.
    const mem = RAW.slice()
    encodeSettings(mem, { squelch: 'loud' as unknown as number, beep: null as unknown as number })
    expect(equalBytes(mem, RAW)).toBe(true)
  })

  it('keeps every offered control inside the claimed range', () => {
    const keys = new Set(Object.keys(decodeSettings(RAW)))
    for (const group of UV82_SETTINGS_GROUPS) {
      for (const field of group.fields) {
        expect(keys.has(field.key), `${group.id}.${field.key} is offered but never decoded`).toBe(true)
        expect(field.key.startsWith('poweronMsg.'), `${field.key} cannot be written`).toBe(false)
      }
    }
    expect(SETTINGS_BASE + SETTINGS_CLAIM).toBeLessThanOrEqual(0x1808)
  })
})

/**
 * The same illegal channel used to be an error on the UV-K5 and silent here.
 *
 * `validate` checked the receive frequency and stopped, so a repeater shift
 * that dragged transmit out of band produced no diagnostic at all - and the
 * write gate only blocks on diagnostics, so nothing stood between that channel
 * and the radio. Part of issue #5, taken for this driver.
 */
describe('transmitting out of band', () => {
  const withChannel = (over: Record<string, unknown>) => {
    const doc = driver.decode(image())
    const first = [...doc.channels.values()][0]!
    doc.channels = new Map([[first.index, { ...first, ...over }]])
    return doc
  }

  it('is an error when a minus shift drops transmit below the band', () => {
    const doc = withChannel({
      rxFreq: 144_000_000, txAllowed: true, tx: { kind: 'offset', direction: 'minus', offset: 20_000_000 },
    })
    const found = driver.validate(doc).filter((d) => d.ruleId === 'radio.band.tx-out-of-range')
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('error')
    expect(found[0]!.message).toContain('124.00000 MHz')
  })

  it('is an error for a split transmitting outside both bands', () => {
    const doc = withChannel({ rxFreq: 145_500_000, txAllowed: true, tx: { kind: 'split', txFreq: 27_185_000 } })
    expect(driver.validate(doc).map((d) => d.ruleId)).toContain('radio.band.tx-out-of-range')
  })

  it('says nothing about a receive-only channel, which transmits nowhere', () => {
    const doc = withChannel({ rxFreq: 162_400_000, txAllowed: false, tx: { kind: 'simplex' } })
    expect(driver.validate(doc).filter((d) => d.field === 'tx')).toEqual([])
  })

  it('leaves an ordinary in-band channel alone', () => {
    const doc = withChannel({
      rxFreq: 146_940_000, txAllowed: true, tx: { kind: 'offset', direction: 'minus', offset: 600_000 },
    })
    expect(driver.validate(doc).filter((d) => d.field === 'tx')).toEqual([])
  })
})
