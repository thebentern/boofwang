// SPDX-License-Identifier: GPL-3.0-or-later
import { fromHex } from '#core/codec/checksum.js'
import { MEM_SIZE, PROG_SIZE } from '#core/radios/uvk5/protocol.js'
import { ATTR_BASE, CHANNEL_BASE, NAME_BASE, NAME_SIZE } from '#core/radios/uvk5/layout.js'
import type { RadioImage } from '#core/radio/image.js'

/**
 * Channel records produced by CHIRP's own `bitwise` parser against the
 * `MEM_FORMAT` from `chirp/drivers/uvk5.py`.
 *
 * Generating them with CHIRP rather than by hand is the point: if our bit
 * ordering or field offsets were wrong, these would decode to different values.
 * A fixture we encoded ourselves could only ever confirm that our decoder
 * agrees with our encoder.
 */
export const CHIRP_CHANNELS = {
  /** 146.520 MHz simplex, no tone, FM wide, high power, 5 kHz step. */
  SIMPLEX: '6092df00000000000000000008000100',
  /** 146.940 -600 kHz, TX CTCSS 88.5, RX DTCS 023 normal, NFM, medium, in scan list. */
  REPEATER: '7036e00060ea00000008120606000100',
  /** 442.100 +5 MHz, TSQL 100.0 both ways, FM wide, high, 12.5 kHz step. */
  UHF_PLUS: '5097a20220a107000c0c110108000400',
  /** 162.550 (NOAA WX) with a minus shift whose offset equals the frequency. */
  TX_DISABLED: '1808f8001808f8000000000202000100',
  /** 121.500 air band, AM, low power. */
  AIR_AM: 'f064b900000000000000001000000400',
  /** 145.000 with an inverted DTCS code (031) on transmit. */
  DTCS_R: 'a040dd00000000000003300008000100',
  /** 143.000 with every extra flag exercised. */
  EXTRAS: '6033da0000000000000000001907050a',
} as const

/** Attribute bytes, also produced by CHIRP's bitwise. */
export const CHIRP_ATTRS = {
  SL1_BAND2: 0x82,
  SL2_COMP3_BAND5: 0x75,
  NONE_BAND2: 0x02,
} as const

export interface FixtureChannel {
  slot: number
  record: string
  name?: string
  attr?: number
}

/**
 * Build a full 0x2000 EEPROM image.
 *
 * Filled with 0xFF, which is what an erased UV-K5 actually looks like - so any
 * slot the caller does not populate is genuinely empty rather than
 * suspiciously zeroed.
 */
export function buildEeprom(channels: FixtureChannel[], calibration?: Uint8Array): Uint8Array {
  const mem = new Uint8Array(MEM_SIZE).fill(0xff)
  for (const c of channels) {
    mem.set(fromHex(c.record), CHANNEL_BASE + c.slot * 16)
    if (c.attr !== undefined) mem[ATTR_BASE + c.slot] = c.attr
    if (c.name !== undefined) {
      const bytes = new Uint8Array(NAME_SIZE).fill(0xff)
      for (let i = 0; i < Math.min(c.name.length, NAME_SIZE); i++) bytes[i] = c.name.charCodeAt(i)
      mem.set(bytes, NAME_BASE + c.slot * NAME_SIZE)
    }
  }
  if (calibration) mem.set(calibration, PROG_SIZE)
  return mem
}

export function imageFrom(mem: Uint8Array, variant = 'k5_2.01.26', layout = 'stock'): RadioImage {
  return {
    radioId: 'uvk5',
    variant,
    layout,
    createdAt: '2026-08-18T00:00:00.000Z',
    regions: [
      { start: 0x0000, data: mem.slice(0, PROG_SIZE), readOnly: false, label: 'programmable' },
      { start: PROG_SIZE, data: mem.slice(PROG_SIZE, MEM_SIZE), readOnly: true, label: 'calibration' },
    ],
    meta: { firmware: variant },
    sha256: '',
  }
}
