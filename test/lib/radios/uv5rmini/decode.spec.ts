// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_SIZE,
  UV17PRO_DTCS_CODES,
  decodeName,
  decodeToneWord,
  encodeName,
  encodeToneWord,
  isChannelEmpty,
} from '#core/radios/uv5rmini/layout.js'
import { decodeChannel } from '#core/radios/uv5rmini/driver.js'
import { VARIANTS, decrypt, encrypt, frame, imageSize } from '#core/radios/uv5rmini/protocol.js'

/** Build a 32-byte channel record from CHIRP's `struct memory_obj`. */
function record(opts: {
  rxHz?: number
  txHz?: number
  rxTone?: number
  txTone?: number
  lowpower?: number
  wide?: boolean
  scan?: boolean
  name?: string
  txBlank?: 0x00 | 0xff
}): Uint8Array {
  const r = new Uint8Array(CHANNEL_SIZE).fill(0x00)
  const lbcd = (hz: number, at: number) => {
    const v = Math.round(hz / 10)
    const digits = String(v).padStart(8, '0')
    for (let i = 0; i < 4; i++) {
      // Little-endian pairs, big-endian nibbles within each byte.
      const pair = digits.slice(6 - i * 2, 8 - i * 2)
      r[at + i] = (Number(pair[0]) << 4) | Number(pair[1]!)
    }
  }
  lbcd(opts.rxHz ?? 145_500_000, 0x00)
  if (opts.txBlank !== undefined) r.fill(opts.txBlank, 0x04, 0x08)
  else lbcd(opts.txHz ?? opts.rxHz ?? 145_500_000, 0x04)

  const rt = opts.rxTone ?? 0
  const tt = opts.txTone ?? 0
  r[0x08] = rt & 0xff
  r[0x09] = (rt >> 8) & 0xff
  r[0x0a] = tt & 0xff
  r[0x0b] = (tt >> 8) & 0xff
  // byte 0x0E, MSB-first: unknown7:2 scramble:2 unknown8:2 lowpower:2
  r[0x0e] = (opts.lowpower ?? 0) & 0x03
  // byte 0x0F, MSB-first: unknown1:1 wide:1 sqmode:2 bcl:1 scan:1 unknown2:1 fhss:1
  r[0x0f] = ((opts.wide ? 1 : 0) << 6) | ((opts.scan ?? true) ? 1 << 2 : 0)
  r.set(encodeName(opts.name ?? 'TEST'), 0x14)
  return r
}

describe('the obfuscation', () => {
  it('is its own inverse', () => {
    const data = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff)
    expect([...decrypt(encrypt(data))]).toEqual([...data])
  })

  it('leaves alone the bytes CHIRP leaves alone', () => {
    // 0x00, 0xFF, the key byte and its complement pass through untouched, and
    // the third key byte is a space so that column never changes at all.
    const key = [0x43, 0x4f, 0x20, 0x37]
    for (let i = 0; i < 4; i++) {
      const k = key[i]!
      for (const b of [0x00, 0xff, k, k ^ 0xff]) {
        const buf = new Uint8Array(4)
        buf[i] = b
        expect(decrypt(buf)[i], `key byte ${i}, value ${b}`).toBe(b)
      }
    }
    // Column 2's key is a space, so nothing there is ever transformed.
    for (let v = 0; v < 256; v++) {
      const buf = new Uint8Array(4)
      buf[2] = v
      expect(decrypt(buf)[2]).toBe(v)
    }
  })

  it('does transform an ordinary byte', () => {
    const buf = Uint8Array.from([0x01, 0x01, 0x01, 0x01])
    const out = decrypt(buf)
    expect(out[0]).toBe(0x01 ^ 0x43)
    expect(out[1]).toBe(0x01 ^ 0x4f)
    expect(out[2]).toBe(0x01) // key byte is a space
    expect(out[3]).toBe(0x01 ^ 0x37)
  })
})

describe('framing', () => {
  it('puts the address in big-endian, unlike everything else here', () => {
    // CHIRP: cmd + struct.pack(">i", addr)[2:] + length.
    expect([...frame(0x52, 0x1234, 0x40)]).toEqual([0x52, 0x12, 0x34, 0x40])
    expect([...frame(0x52, 0x0000, 0x40)]).toEqual([0x52, 0x00, 0x00, 0x40])
    expect([...frame(0x52, 0xa000, 0x40)]).toEqual([0x52, 0xa0, 0x00, 0x40])
  })
})

describe('the tone word', () => {
  it('treats 0 and 0xFFFF as no tone', () => {
    expect(decodeToneWord(0)).toBeNull()
    expect(decodeToneWord(0xffff)).toBeNull()
  })

  it('reads a value at or above 600 as CTCSS in tenths of a hertz', () => {
    expect(decodeToneWord(885)).toEqual({ kind: 'ctcss', deciHz: 885 })
    expect(decodeToneWord(1273)).toEqual({ kind: 'ctcss', deciHz: 1273 })
    expect(decodeToneWord(0x0258)).toEqual({ kind: 'ctcss', deciHz: 600 })
  })

  it('reads a low value as a one-based DTCS index, and 0x6A up as reversed', () => {
    expect(decodeToneWord(1)).toEqual({ kind: 'dtcs', code: 23, polarity: 'N' })
    expect(decodeToneWord(0x6a)).toEqual({ kind: 'dtcs', code: 23, polarity: 'R' })
    expect(decodeToneWord(105)).toEqual({ kind: 'dtcs', code: 754, polarity: 'N' })
    expect(decodeToneWord(210)).toEqual({ kind: 'dtcs', code: 754, polarity: 'R' })
  })

  it('uses the 105-code table, not the standard 104', () => {
    // This family is chirp_common.DTCS_CODES plus 645, re-sorted. Using the
    // ordinary table would shift every code above 645 by one place.
    expect(UV17PRO_DTCS_CODES).toHaveLength(105)
    expect(UV17PRO_DTCS_CODES.includes(645)).toBe(true)
    expect(UV17PRO_DTCS_CODES.indexOf(645)).toBe(93)
    expect(decodeToneWord(94)).toEqual({ kind: 'dtcs', code: 645, polarity: 'N' })
    expect(decodeToneWord(95)).toEqual({ kind: 'dtcs', code: 654, polarity: 'N' })
  })

  it('refuses an index the table cannot hold rather than inventing a code', () => {
    // 211..599 land in the DTCS branch but index past the table.
    expect(decodeToneWord(211)).toBeNull()
    expect(decodeToneWord(599)).toBeNull()
  })

  it('round-trips every code in both polarities', () => {
    for (const code of UV17PRO_DTCS_CODES) {
      for (const polarity of ['N', 'R'] as const) {
        const word = encodeToneWord({ kind: 'dtcs', code, polarity })
        expect(decodeToneWord(word), `D${code}${polarity}`).toEqual({ kind: 'dtcs', code, polarity })
      }
    }
  })
})

describe('names', () => {
  it('maps both fill bytes to spaces rather than ending the string', () => {
    // CHIRP: replace 0xFF and 0x00 with ' ', then rstrip. A name containing one
    // keeps everything after it.
    const raw = Uint8Array.from([65, 66, 0xff, 67, 68, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    expect(decodeName(raw)).toBe('AB CD')
  })

  it('strips the padding but not interior spaces', () => {
    expect(decodeName(encodeName('CH 001'))).toBe('CH 001')
  })

  it('pads with 0xFF, which is what the radio writes', () => {
    expect([...encodeName('AB')].slice(2)).toEqual(new Array(10).fill(0xff))
  })
})

describe('a channel record', () => {
  it('is empty when its first byte is 0xFF, and only then', () => {
    const r = record({})
    expect(isChannelEmpty(r)).toBe(false)
    r[0] = 0xff
    expect(isChannelEmpty(r)).toBe(true)
  })

  it('decodes a plain simplex channel', () => {
    const ch = decodeChannel(record({ rxHz: 145_500_000, name: 'SIMPLEX' }), 0)!
    expect(ch.index).toBe(1)
    expect(ch.name).toBe('SIMPLEX')
    expect(ch.rxFreq).toBe(145_500_000)
    expect(ch.tx).toEqual({ kind: 'simplex' })
    expect(ch.txAllowed).toBe(true)
  })

  it('derives a repeater shift from the absolute transmit frequency', () => {
    // txfreq is always absolute on this family; the offset is computed.
    const ch = decodeChannel(record({ rxHz: 145_500_000, txHz: 145_000_000 }), 0)!
    expect(ch.tx).toEqual({ kind: 'offset', direction: 'minus', offset: 500_000 })
  })

  it('treats a blank transmit frequency as receive-only, both spellings', () => {
    for (const fill of [0xff, 0x00] as const) {
      const ch = decodeChannel(record({ txBlank: fill }), 0)!
      expect(ch.txAllowed, `fill 0x${fill.toString(16)}`).toBe(false)
    }
  })

  it('reads the bit named "wide" as narrow, because that is what it means', () => {
    // MODES = ["NFM", "FM"] and mem.mode = wide and MODES[0] or MODES[1], so a
    // set bit selects NFM. The name is the trap.
    expect(decodeChannel(record({ wide: true }), 0)!.bandwidthHz).toBe(12_500)
    expect(decodeChannel(record({ wide: false }), 0)!.bandwidthHz).toBe(25_000)
  })

  it('takes the power table from whichever radio answered', () => {
    // These two are different radios with near-identical names. The UV-5R Mini
    // has High 5 W and Low 1 W; the 5RM has High 8 W, Low 1 W and Medium 5 W.
    // Sharing one table would put every channel on the wrong power - and 5 W is
    // "High" on one and "Medium" on the other, so the label is wrong too.
    const mini = VARIANTS.find((v) => v.id === 'uv5rmini')!
    const rm = VARIANTS.find((v) => v.id === '5rm')!

    expect(decodeChannel(record({ lowpower: 0 }), 0, mini)!.power).toMatchObject({ mW: 5000, label: 'High' })
    expect(decodeChannel(record({ lowpower: 1 }), 0, mini)!.power).toMatchObject({ mW: 1000, label: 'Low' })

    expect(decodeChannel(record({ lowpower: 0 }), 0, rm)!.power).toMatchObject({ mW: 8000, label: 'High' })
    expect(decodeChannel(record({ lowpower: 1 }), 0, rm)!.power).toMatchObject({ mW: 1000, label: 'Low' })
    expect(decodeChannel(record({ lowpower: 2 }), 0, rm)!.power).toMatchObject({ mW: 5000, label: 'Medium' })
  })

  it('falls back to the first level for an index the radio does not have', () => {
    // The field is two bits, so a UV-5R Mini can present a 2 or a 3 that its
    // own table cannot answer. CHIRP falls back to level 0 and so does this.
    const mini = VARIANTS.find((v) => v.id === 'uv5rmini')!
    expect(decodeChannel(record({ lowpower: 3 }), 0, mini)!.power.mW).toBe(5000)
  })

  it('keeps the two radios' + String.fromCharCode(39) + ' layouts apart', () => {
    const mini = VARIANTS.find((v) => v.id === 'uv5rmini')!
    const rm = VARIANTS.find((v) => v.id === '5rm')!
    expect(mini.regions).toHaveLength(3)
    expect(rm.regions).toHaveLength(4)
    expect(mini.channelCount).toBe(999)
    expect(rm.channelCount).toBe(1000)
    expect(new TextDecoder().decode(mini.ident)).toBe('PROGRAMCOLORPROU')
    expect(new TextDecoder().decode(rm.ident)).toBe('PROGRAMBFNORMALU')
    expect(imageSize(mini)).toBe(0x8240)
    expect(imageSize(rm)).toBe(0x8380)
  })

  it('picks AM from the frequency, since nothing stores it', () => {
    expect(decodeChannel(record({ rxHz: 120_000_000, txBlank: 0xff }), 0)!.modulation).toBe('AM')
    expect(decodeChannel(record({ rxHz: 145_500_000 }), 0)!.modulation).toBe('FM')
  })

  it('marks a channel excluded from scan', () => {
    expect(decodeChannel(record({ scan: true }), 0)!.skip).toBe('none')
    expect(decodeChannel(record({ scan: false }), 0)!.skip).toBe('skip')
  })

  it('carries tones in both directions', () => {
    const ch = decodeChannel(record({ rxTone: 885, txTone: 1273 }), 0)!
    expect(ch.tone.rx).toEqual({ kind: 'ctcss', deciHz: 885 })
    expect(ch.tone.tx).toEqual({ kind: 'ctcss', deciHz: 1273 })
  })
})
