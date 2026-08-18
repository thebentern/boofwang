// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { UNKNOWN_VARIANT, classifyFirmware, variantsCompatible } from '#core/radios/uvk5/variants.js'

describe('classifyFirmware', () => {
  it('accepts every OEM prefix CHIRP approves', () => {
    // From k5_approve_firmware in chirp/drivers/uvk5.py.
    for (const fw of [
      'k5_2.01.26', 'app_2.01.23', '2.01.31', '3.00.05', '4.00.01',
      'k5_4.00.06', '5.00.01', '7.00.02', '1.02.05',
    ]) {
      const v = classifyFirmware(fw)
      expect(v.layout, fw).toBe('stock')
      expect(v.canWrite, fw).toBe(true)
      expect(v.calStart, fw).toBe(0x1d00)
    }
  })

  it('accepts oneofeleven user builds', () => {
    expect(classifyFirmware('1o11-05').layout).toBe('stock')
  })

  it('gives egzumer its own layout with a different calibration boundary', () => {
    const v = classifyFirmware('EGZUMER v0.22')
    expect(v.layout).toBe('egzumer')
    expect(v.calStart).toBe(0x1e00)
    // Not written until the layout is actually implemented.
    expect(v.canWrite).toBe(false)
  })

  it('treats anything unrecognised as read-only, not unreadable', () => {
    // Refusing to read would be backwards: a backup is exactly what someone on
    // an unsupported firmware needs, and it is how the variant gets supported.
    for (const fw of ['', 'IJV 3.5', 'f4hwn 2.9', 'wibble', '9.99.99']) {
      const v = classifyFirmware(fw)
      expect(v.layout, fw).toBe('unknown')
      expect(v.canWrite, fw).toBe(false)
    }
    expect(UNKNOWN_VARIANT.note).toMatch(/read and backed up/)
  })

  it('matches on prefix, not substring', () => {
    // "x2.01." must not be mistaken for the OEM "2.01." family.
    expect(classifyFirmware('x2.01.26').layout).toBe('unknown')
  })

  it('requires the trailing space in the egzumer prefix', () => {
    expect(classifyFirmware('EGZUMERISH').layout).toBe('unknown')
  })
})

describe('variantsCompatible', () => {
  it('allows an image back onto the firmware it came from', () => {
    expect(variantsCompatible('k5_2.01.26', 'k5_2.01.26')).toBe(true)
  })

  it('allows an image across firmwares that share a layout', () => {
    expect(variantsCompatible('k5_2.01.26', '3.00.05')).toBe(true)
  })

  it('refuses an egzumer image on a stock radio and vice versa', () => {
    // Different EEPROM layouts; writing one onto the other is how a radio gets
    // a corrupted calibration region.
    expect(variantsCompatible('EGZUMER v0.22', 'k5_2.01.26')).toBe(false)
    expect(variantsCompatible('k5_2.01.26', 'EGZUMER v0.22')).toBe(false)
  })

  it('never treats two unknown firmwares as compatible', () => {
    // They share the label "unknown", not a known layout.
    expect(variantsCompatible('mystery-a', 'mystery-b')).toBe(false)
  })
})
