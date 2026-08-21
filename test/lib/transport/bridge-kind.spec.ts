// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { BridgeSerialPort, type BridgePortInfo } from '#core/transport/bridge-serial-port.js'
import { uploadBlockSize, BLE_UPLOAD_BLOCK_SIZE, BLOCK_SIZE } from '#core/radios/uv5rmini/protocol.js'

/**
 * The bridge has to say which carrier it is.
 *
 * A driver may change behaviour on it - the UV-5R Mini sends 0x80 upload blocks
 * over Bluetooth where the cable takes 0x40 - so a Bluetooth bridge that
 * reported itself as serial would write the wrong size while looking perfectly
 * healthy. That is the failure this pair of tests exists to prevent.
 */
const port = (over: Partial<BridgePortInfo> = {}): BridgePortInfo => ({
  path: '/dev/cu.usbserial-A50285BI',
  manufacturer: 'FTDI',
  serialNumber: 'A50285BI',
  vendorId: 0x0403,
  productId: 0x6001,
  ...over,
})

describe('what the bridge says it is', () => {
  it('is serial when the bridge does not say, which is what the cable one does', () => {
    // The serial bridge predates the field and never sends it. Defaulting the
    // other way would make every cable session claim to be Bluetooth.
    expect(new BridgeSerialPort('ws://127.0.0.1:8765', port()).kind).toBe('serial')
  })

  it('is bluetooth when the bridge says so', () => {
    const p = new BridgeSerialPort('ws://127.0.0.1:8766', port({ path: 'AA:BB', kind: 'bluetooth' }))
    expect(p.kind).toBe('bluetooth')
  })

  it('drives the block size a UV-5R Mini write actually uses', () => {
    // The two halves joined up: what the bridge reports decides what goes on
    // the wire.
    const cable = new BridgeSerialPort('ws://x', port())
    const radio = new BridgeSerialPort('ws://x', port({ kind: 'bluetooth' }))

    expect(uploadBlockSize(cable.kind)).toBe(BLOCK_SIZE)
    expect(uploadBlockSize(radio.kind)).toBe(BLE_UPLOAD_BLOCK_SIZE)
    expect(BLE_UPLOAD_BLOCK_SIZE).not.toBe(BLOCK_SIZE)
  })
})
