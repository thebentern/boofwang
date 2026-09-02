// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { KNOWN_BRIDGE_VENDORS, isKnownBridgeVendor } from '#core/transport/usb-bridges.js'
import { DRIVER_FACTORIES } from '#core/radio/registry.js'

/**
 * One table, five readers: four drivers order the port picker by it, the
 * serial composable names an adapter by it, and the Android app's USB device
 * filter is generated from it. A vendor that drifted out of any one of them
 * would be a cable that works on a laptop and is never offered on a phone.
 */
describe('the bridge vendor table', () => {
  it('names the four chips a programming cable is built around', () => {
    expect(KNOWN_BRIDGE_VENDORS).toEqual({
      0x1a86: 'QinHeng CH340',
      0x067b: 'Prolific PL2303',
      0x10c4: 'Silicon Labs CP210x',
      0x0403: 'FTDI',
    })
  })

  it('recognises each of them and nothing else', () => {
    for (const vid of Object.keys(KNOWN_BRIDGE_VENDORS)) expect(isKnownBridgeVendor(Number(vid))).toBe(true)
    expect(isKnownBridgeVendor(0x1234)).toBe(false)
    expect(isKnownBridgeVendor(undefined)).toBe(false)
  })
})

describe('every driver reads the same table', () => {
  const drivers = Object.entries(DRIVER_FACTORIES).flatMap(([id, make]) => (make ? [[id, make()] as const] : []))

  it('has drivers to check', () => {
    expect(drivers.length).toBeGreaterThan(0)
  })

  for (const [id, driver] of drivers) {
    it(`${id}: calls a known bridge possible, never likely - the handshake decides`, () => {
      for (const vid of Object.keys(KNOWN_BRIDGE_VENDORS)) {
        expect(driver.match({ usbVendorId: Number(vid) })).toBe('possible')
      }
    })

    it(`${id}: calls an unknown or absent vendor no`, () => {
      expect(driver.match({ usbVendorId: 0x1234 })).toBe('no')
      expect(driver.match({})).toBe('no')
    })
  }
})
