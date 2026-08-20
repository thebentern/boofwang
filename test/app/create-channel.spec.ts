// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createUv5rMiniDriver } from '#core/radios/uv5rmini/driver.js'
import { VARIANTS } from '#core/radios/uv5rmini/protocol.js'
import { CHANNEL_BASE, CHANNEL_SIZE } from '#core/radios/uv5rmini/layout.js'
import type { RadioImage } from '#core/radio/image.js'

/**
 * Creating a channel is exercised through the driver rather than the store,
 * because what matters is the bytes: an empty record is 32 bytes of 0xFF, so a
 * new channel must not inherit the bits that reads as set.
 */
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/images/uv5rmini-5RMINI.bin', import.meta.url))),
)
const variant = VARIANTS.find((v) => v.id === 'uv5rmini')!
const driver = createUv5rMiniDriver({ enableWrite: true })

function image(): RadioImage {
  let off = 0
  const regions = variant.regions.map((r) => {
    const data = RAW.slice(off, off + r.size)
    off += r.size
    return { start: r.start, data, label: r.label }
  })
  return {
    radioId: 'uv5rmini',
    variant: '5RMINI',
    layout: 'uv5rmini',
    createdAt: '2026-08-20T00:00:00.000Z',
    regions,
    meta: {},
    sha256: '',
  }
}

describe('programming a slot that was empty', () => {
  it('produces a channel the decoder reads back', () => {
    const img = image()
    const doc = driver.decode(img)
    const slot = 40
    expect(doc.channels.has(slot)).toBe(false)

    doc.channels.set(slot, {
      ...doc.channels.get(1)!,
      index: slot,
      name: 'NEW',
      rxFreq: 146_520_000 as never,
    })

    const out = driver.encode(doc, img)
    const back = driver.decode(out)
    const made = back.channels.get(slot)

    expect(made, 'the new channel did not survive a round trip').toBeTruthy()
    expect(made!.name).toBe('NEW')
    expect(made!.rxFreq).toBe(146_520_000)
  })

  it('clears the erased-flash bits rather than inheriting them', () => {
    // An unused record is 0xFF throughout, so every unmodelled bit reads as set.
    // A new channel must not arrive with scramble, FHSS and a squelch mode
    // nobody chose and the interface does not show.
    const img = image()
    const doc = driver.decode(img)
    const slot = 41
    const at = CHANNEL_BASE + (slot - 1) * CHANNEL_SIZE
    expect(img.regions[0]!.data[at]).toBe(0xff)

    doc.channels.set(slot, { ...doc.channels.get(1)!, index: slot, name: 'CLEAN' })
    const mem = driver.encode(doc, img).regions[0]!.data
    const record = mem.subarray(at, at + CHANNEL_SIZE)

    expect([...record.subarray(0x10, 0x14)]).toEqual([0, 0, 0, 0])
    expect(record[0x0f]! & 0b1000_0001).toBe(0)
  })

  it('leaves every other slot untouched', () => {
    const img = image()
    const doc = driver.decode(img)
    doc.channels.set(42, { ...doc.channels.get(1)!, index: 42, name: 'X' })

    const before = img.regions[0]!.data
    const after = driver.encode(doc, img).regions[0]!.data
    const at = CHANNEL_BASE + 41 * CHANNEL_SIZE

    for (let i = 0; i < before.length; i++) {
      if (i >= at && i < at + CHANNEL_SIZE) continue
      expect(after[i], `byte 0x${i.toString(16)} moved`).toBe(before[i])
    }
  })
})

describe('what a new channel starts as', () => {
  it('does not default to full power', () => {
    // A schema carrying two variants' tables lists 8 W first, which the UV-5R
    // Mini does not have. Defaulting to the highest entry both overstates the
    // radio and starts every new channel at maximum output.
    const schema = createUv5rMiniDriver({ enableWrite: true }).schema
    const lowest = [...schema.rf.powerLevels].sort((a, b) => a.mW - b.mW)[0]!
    expect(lowest.mW).toBe(1000)
    expect(schema.rf.powerLevels[0]!.mW).toBe(8000)
  })
})
