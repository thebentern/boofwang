// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createUv5rMiniDriver } from '#core/radios/uv5rmini/driver.js'
import { VARIANTS } from '#core/radios/uv5rmini/protocol.js'
import { UV5RM_BLE, bluetoothProfile } from '#core/transport/bluetooth-uuids.js'
import type { RadioImage } from '#core/radio/image.js'

/**
 * The same radio, read twice over two different transports.
 *
 * A fake GATT link proves the port reassembles fragments; it cannot prove the
 * radio answers, that the profile is the right one, or that 521 block reads
 * survive a link running at a fortieth of the cable's speed. These two images
 * are the evidence for all three: one taken over the cable, one over Bluetooth,
 * decoded here by the same driver and compared.
 */
const read = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))))

const CABLE = read('uv5rmini-5RMINI.bin')
const BLE = read('uv5rmini-5RMINI-ble.bin')

const variant = VARIANTS.find((v) => v.id === 'uv5rmini')!

function image(raw: Uint8Array): RadioImage {
  let off = 0
  const regions = variant.regions.map((r) => {
    const data = raw.slice(off, off + r.size)
    off += r.size
    return { start: r.start, data, label: r.label }
  })
  return {
    radioId: 'uv5rmini',
    variant: '5RMINI  +L00000',
    layout: 'uv5rmini',
    createdAt: '2026-08-21T00:00:00.000Z',
    regions,
    meta: {},
    sha256: '',
  }
}

/**
 * The three bytes the two reads disagree on, as radio addresses.
 *
 * Every one is state the radio changed between the reads rather than anything
 * the transport did: it was on a cable for one and in wireless CPS mode for the
 * other, so the `bluetooth` flag at 0x9022 is set in exactly one of them.
 */
const EXPECTED_STATE_BYTES = [0x9018, 0x901a, 0x9022]

describe('a UV-5R Mini read over Bluetooth and over a cable', () => {
  it('produces images of the same size', () => {
    expect(BLE.length).toBe(CABLE.length)
    expect(BLE.length).toBe(33_344)
  })

  it('differs only in the radio-state bytes, and nowhere else', () => {
    const REGIONS = variant.regions
    const radioAddress = (offset: number) => {
      let base = 0
      for (const r of REGIONS) {
        if (offset < base + r.size) return r.start + (offset - base)
        base += r.size
      }
      throw new Error(`offset ${offset} is past the end of the image`)
    }

    const differing: number[] = []
    for (let i = 0; i < CABLE.length; i++) if (CABLE[i] !== BLE[i]) differing.push(radioAddress(i))
    expect(differing).toEqual(EXPECTED_STATE_BYTES)
  })

  it('decodes to the same channels, byte for byte', () => {
    // The whole point. If the transport dropped or duplicated a fragment
    // anywhere across 521 reads, a channel would move and this would fail.
    const overCable = createUv5rMiniDriver().decode(image(CABLE))
    const overBle = createUv5rMiniDriver().decode(image(BLE))

    expect(overBle.channels.size).toBe(overCable.channels.size)
    expect(overBle.channels.size).toBeGreaterThan(0)
    for (const [slot, cabled] of overCable.channels) {
      expect(JSON.stringify(overBle.channels.get(slot)), `channel ${slot}`).toBe(JSON.stringify(cabled))
    }
  })

  it('leaves the entire channel array identical, before any decoding', () => {
    const channelBytes = 999 * 32
    expect(Buffer.compare(Buffer.from(BLE.subarray(0, channelBytes)),
                          Buffer.from(CABLE.subarray(0, channelBytes)))).toBe(0)
  })

  it('is the profile the radio actually answered on', () => {
    expect(bluetoothProfile()).toBe(UV5RM_BLE)
    expect(UV5RM_BLE.verified).toBe(true)
  })
})
