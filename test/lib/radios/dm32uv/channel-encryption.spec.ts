// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Channel } from '#core/model/channel.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver, decodeChannel, encodeChannel } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { BLANK_CHANNEL, CHANNEL_SIZE, channelSlot } from '#core/radios/dm32uv/layout.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'

/**
 * Where a channel keeps its encryption.
 *
 * The key slot is byte 0x1E and the enable bit is 0x1F bit 6, as qdmr's
 * DM-32UV codeplug has them. The reference this driver started from put them
 * at 0x2A and 0x1D bit 7, which on two radios encrypted in the OEM CPS read
 * zero on every channel. These pin the mapping, and that the bytes it no
 * longer claims are carried through untouched.
 */

/** A digital channel on the radio's own blank record, with its encryption bytes as given. */
function digitalRecord(bytes: Partial<Record<number, number>> = {}): Uint8Array {
  const rec = BLANK_CHANNEL.slice()
  rec[0x18] = 0x10 // mode 1: digital
  for (const [off, value] of Object.entries(bytes)) rec[Number(off)] = value!
  return rec
}

function analogRecord(bytes: Partial<Record<number, number>> = {}): Uint8Array {
  const rec = BLANK_CHANNEL.slice()
  for (const [off, value] of Object.entries(bytes)) rec[Number(off)] = value!
  return rec
}

const decoded = (rec: Uint8Array): Channel => decodeChannel(rec, 0, 1)!
const vendor = (rec: Uint8Array) => {
  const v = decoded(rec).extras.vendor!
  return { encryptEnabled: v.encryptEnabled, encryptionKeyId: v.encryptionKeyId }
}

/** `rec` after decoding it, applying `change` to the channel, and encoding it back in place. */
function rewritten(rec: Uint8Array, change: (ch: Channel) => Channel = (ch) => ch): Uint8Array {
  const out = rec.slice()
  encodeChannel(out, 0, change(decoded(rec)))
  return out
}

const withVendor = (fields: Record<string, string>) => (ch: Channel): Channel => ({
  ...ch,
  extras: { ...ch.extras, vendor: { ...ch.extras.vendor, ...fields } },
})

describe('reading a channel', () => {
  it('takes the key slot from 0x1E and the enable bit from 0x1F bit 6', () => {
    // 0x1F's low bits are the RX group list, which says nothing about keys.
    expect(vendor(digitalRecord({ 0x1e: 5, 0x1f: 0x40 | 0x02 }))).toEqual({ encryptEnabled: '1', encryptionKeyId: '5' })
    expect(vendor(digitalRecord({ 0x1e: 14, 0x1f: 0x40 }))).toEqual({ encryptEnabled: '1', encryptionKeyId: '14' })
  })

  it('reads neither 0x2A nor 0x1D bit 7 as encryption', () => {
    expect(vendor(digitalRecord({ 0x2a: 7, 0x1d: 0x80 | 0x01 }))).toEqual({ encryptEnabled: '0', encryptionKeyId: '0' })
  })

  it('reports the slot and the bit separately, as the radio holds them', () => {
    expect(vendor(digitalRecord({ 0x1e: 3 }))).toEqual({ encryptEnabled: '0', encryptionKeyId: '3' })
    expect(vendor(digitalRecord({ 0x1f: 0x40 }))).toEqual({ encryptEnabled: '1', encryptionKeyId: '0' })
  })

  it('finds no key on an analog channel, where 0x1F is PTT ID settings', () => {
    expect(vendor(analogRecord({ 0x1e: 3, 0x1f: 0x40 | 0x05 }))).toEqual({ encryptEnabled: '0', encryptionKeyId: '0' })
  })
})

describe('writing a channel', () => {
  it('puts the key slot in 0x1E and the enable bit in 0x1F bit 6', () => {
    const rec = digitalRecord({ 0x1f: 0x02 })
    const out = rewritten(rec, withVendor({ encryptEnabled: '1', encryptionKeyId: '9' }))
    expect(out[0x1e]).toBe(9)
    expect(out[0x1f]).toBe(0x40 | 0x02)
  })

  it('clears them both for a channel with encryption off', () => {
    const rec = digitalRecord({ 0x1e: 4, 0x1f: 0x40 | 0x02 })
    const out = rewritten(rec, withVendor({ encryptEnabled: '0', encryptionKeyId: '0' }))
    expect(out[0x1e]).toBe(0)
    expect(out[0x1f]).toBe(0x02)
  })

  it('leaves 0x2A and 0x1D bit 7 as the radio had them', () => {
    const rec = digitalRecord({ 0x2a: 0x5a, 0x1d: 0x80 | 0x01 })
    const out = rewritten(rec, withVendor({ encryptEnabled: '1', encryptionKeyId: '2' }))
    expect(out[0x2a]).toBe(0x5a)
    expect(out[0x1d]! & 0x80).toBe(0x80)
  })

  it('round-trips a digital and an analog record byte for byte', () => {
    for (const rec of [
      digitalRecord({ 0x1e: 12, 0x1f: 0x40 | 0x01, 0x2a: 0x33, 0x1d: 0x80 | 0x11 }),
      analogRecord({ 0x1e: 3, 0x1f: 0x40 | 0x05 }),
    ]) {
      expect([...rewritten(rec)]).toEqual([...rec])
    }
  })

  it('does not touch the encryption bytes of an analog channel', () => {
    const rec = analogRecord({ 0x1e: 3, 0x1f: 0x40 | 0x05 })
    const out = rewritten(rec, withVendor({ encryptEnabled: '1', encryptionKeyId: '9' }))
    expect(out[0x1e]).toBe(3)
    expect(out[0x1f]).toBe(0x40 | 0x05)
  })

  it('drops the key of a digital channel switched to FM, and keeps the rest of 0x1F', () => {
    const rec = digitalRecord({ 0x1e: 4, 0x1f: 0x40 | 0x02 })
    const out = rewritten(rec, (ch) => ({ ...ch, modulation: 'FM' }))
    expect(out[0x1e]).toBe(0)
    expect(out[0x1f]).toBe(0x02)
  })
})

describe('the radio this was read from', () => {
  const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/images/${name}`, import.meta.url))
  const BLOB = new Uint8Array(readFileSync(fixture('dm32uv-DM32.01.01.040.blocks.bin')))
  const INDEX = JSON.parse(readFileSync(fixture('dm32uv-DM32.01.01.040.index.json'), 'utf8')) as {
    model: string
    firmware: string
    blocks: { id: number; physical: number; offset: number }[]
  }
  const image = (): RadioImage => ({
    radioId: 'dm32uv',
    variant: INDEX.firmware,
    layout: INDEX.model,
    createdAt: '2026-08-19T21:30:00.000Z',
    regions: INDEX.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: BLOB.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
    meta: { placements: INDEX.blocks.map((b) => ({ blockId: b.id, physical: b.physical })) },
    sha256: '',
  })
  const driver = createDm32uvDriver()

  it('reads every channel the CPS encrypted, and only those, off the capture', () => {
    // Derived from the record bytes rather than restated, so this holds for
    // whatever the capture carries: a digital channel is encrypted exactly
    // when 0x1F bit 6 is set, with the slot in 0x1E.
    const img = image()
    const doc = driver.decode(img)
    for (const ch of doc.channels.values()) {
      const at = channelSlot(ch.index)!
      const page = img.regions.find((r) => r.start === logicalAddress(at.blockId))!.data
      const rec = page.subarray(at.offset, at.offset + CHANNEL_SIZE)
      const digital = ch.modulation === 'DMR'
      expect(ch.extras.vendor?.encryptEnabled, `${ch.name} enable`).toBe(digital ? String((rec[0x1f]! >> 6) & 1) : '0')
      expect(ch.extras.vendor?.encryptionKeyId, `${ch.name} key slot`).toBe(digital ? String(rec[0x1e]) : '0')
    }
  })

  it('writes the capture back unchanged', () => {
    const img = image()
    const out = driver.encode(driver.decode(img), img)
    for (const region of img.regions) {
      const after = out.regions.find((r) => r.start === region.start)!
      expect([...after.data], region.label).toEqual([...region.data])
    }
  })
})
