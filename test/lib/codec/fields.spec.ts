// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  array,
  ascii,
  bcdBE,
  bcdFreqLE,
  bcdLE,
  bits,
  bytes,
  chirpBits,
  enumOf,
  i8,
  lbcdFreq,
  scaled,
  u16be,
  u16le,
  u24le,
  u32be,
  u32le,
  u8,
} from '#core/codec/fields.js'

const buf = (...b: number[]) => Uint8Array.from(b)

describe('integer fields', () => {
  it('reads little-endian widths', () => {
    const b = buf(0x78, 0x56, 0x34, 0x12)
    expect(u8.get(b, 0)).toBe(0x78)
    expect(u16le.get(b, 0)).toBe(0x5678)
    expect(u24le.get(b, 0)).toBe(0x345678)
    expect(u32le.get(b, 0)).toBe(0x12345678)
  })

  it('reads big-endian widths', () => {
    const b = buf(0x12, 0x34, 0x56, 0x78)
    expect(u16be.get(b, 0)).toBe(0x1234)
    expect(u32be.get(b, 0)).toBe(0x12345678)
  })

  it('handles u32le above 2^31 without sign trouble', () => {
    const b = buf(0xff, 0xff, 0xff, 0xff)
    expect(u32le.get(b, 0)).toBe(0xffffffff)
    const out = new Uint8Array(4)
    u32le.set(out, 0, 0xffffffff)
    expect(out).toEqual(b)
  })

  it('round-trips every unsigned width', () => {
    for (const [field, width] of [
      [u8, 1],
      [u16le, 2],
      [u24le, 3],
      [u32le, 4],
      [u16be, 2],
      [u32be, 4],
    ] as const) {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 2 ** (width * 8) - 1 }), (v) => {
          const b = new Uint8Array(width)
          field.set(b, 0, v)
          expect(field.get(b, 0)).toBe(v)
        }),
      )
    }
  })

  it('sign-extends i8', () => {
    expect(i8.get(buf(0xff), 0)).toBe(-1)
    expect(i8.get(buf(0x80), 0)).toBe(-128)
    expect(i8.get(buf(0x7f), 0)).toBe(127)
  })

  it('throws rather than reading past the end', () => {
    expect(() => u32le.get(buf(1, 2, 3), 0)).toThrow(RangeError)
    expect(() => u8.get(buf(1), 1)).toThrow(RangeError)
  })
})

describe('bytes', () => {
  it('returns a copy, not a view into the image', () => {
    const src = buf(1, 2, 3, 4)
    const got = bytes(4).get(src, 0)
    got[0] = 0xff
    expect(src[0]).toBe(1)
  })

  it('rejects a wrong-length write', () => {
    expect(() => bytes(4).set(new Uint8Array(4), 0, buf(1, 2))).toThrow(RangeError)
  })
})

describe('ascii', () => {
  it('stops at the terminator and trims trailing spaces', () => {
    expect(ascii(8).get(buf(0x41, 0x42, 0x00, 0x5a, 0, 0, 0, 0), 0)).toBe('AB')
    expect(ascii(8, { pad: 0xff }).get(buf(0x41, 0x42, 0xff, 0xff, 0, 0, 0, 0), 0)).toBe('AB')
    expect(ascii(4).get(buf(0x41, 0x20, 0x20, 0x20), 0)).toBe('A')
  })

  it('pads the remainder on write and does not spill', () => {
    const b = new Uint8Array(8).fill(0xaa)
    ascii(6, { pad: 0xff }).set(b, 1, 'HI')
    expect([...b]).toEqual([0xaa, 0x48, 0x49, 0xff, 0xff, 0xff, 0xff, 0xaa])
  })

  it('truncates a too-long string rather than overrunning', () => {
    const b = new Uint8Array(4)
    ascii(4).set(b, 0, 'ABCDEFGH')
    expect(ascii(4).get(b, 0)).toBe('ABCD')
  })

  it('round-trips any single-byte string that fits', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 10, unit: fc.constantFrom(...'ABCXYZ0189-/ '.split('')) }), (s) => {
        const b = new Uint8Array(10)
        ascii(10, { pad: 0x00 }).set(b, 0, s)
        expect(ascii(10, { pad: 0x00 }).get(b, 0)).toBe(s.replace(/ +$/, ''))
      }),
    )
  })

  it('rejects code points that are not single-byte', () => {
    expect(() => ascii(4).set(new Uint8Array(4), 0, '中')).toThrow(RangeError)
  })
})

describe('bits', () => {
  const f = bits(1, { low: [0, 3], mid: [3, 2], high: [5, 3] })

  it('extracts LSB-first slices', () => {
    // 0b101_11_010 -> high=5, mid=3, low=2
    expect(f.get(buf(0b10111010), 0)).toEqual({ low: 0b010, mid: 0b11, high: 0b101 })
  })

  it('leaves neighbouring bits alone when setting one slice', () => {
    const b = buf(0b10111010)
    f.set(b, 0, { mid: 0b00 })
    expect(b[0]).toBe(0b10100010)
  })

  it('preserves bits the map does not cover', () => {
    const partial = bits(1, { flag: [7, 1] })
    const b = buf(0b0101_0101)
    partial.set(b, 0, { flag: 1 })
    expect(b[0]).toBe(0b1101_0101)
  })

  it('rejects a value too wide for its slice', () => {
    expect(() => f.set(new Uint8Array(1), 0, { mid: 4 })).toThrow(RangeError)
  })

  it('rejects overlapping slices at construction', () => {
    expect(() => bits(1, { a: [0, 4], b: [3, 2] })).toThrow(/overlaps/)
  })

  it('rejects slices past the end of the word', () => {
    expect(() => bits(1, { a: [6, 4] })).toThrow(RangeError)
  })

  it('round-trips all slices', () => {
    fc.assert(
      fc.property(
        fc.record({
          low: fc.integer({ min: 0, max: 7 }),
          mid: fc.integer({ min: 0, max: 3 }),
          high: fc.integer({ min: 0, max: 7 }),
        }),
        (v) => {
          const b = new Uint8Array(1)
          f.set(b, 0, v)
          expect(f.get(b, 0)).toEqual(v)
        },
      ),
    )
  })
})

describe('chirpBits', () => {
  it('assigns MSB-first exactly like CHIRP bitwise declarations', () => {
    // CHIRP: u8 unknown1:1, wide:1, sqmode:2, bcl:1, scan:1, unknown2:1, fhss:1;
    const f = chirpBits(1, [
      ['unknown1', 1],
      ['wide', 1],
      ['sqmode', 2],
      ['bcl', 1],
      ['scan', 1],
      ['unknown2', 1],
      ['fhss', 1],
    ])
    // unknown1 is bit 7 (the high bit), fhss is bit 0.
    expect(f.get(buf(0b1000_0000), 0).unknown1).toBe(1)
    expect(f.get(buf(0b0000_0001), 0).fhss).toBe(1)
    expect(f.get(buf(0b0100_0000), 0).wide).toBe(1)
    expect(f.get(buf(0b0011_0000), 0).sqmode).toBe(3)
  })

  it('insists the declarations cover the word exactly', () => {
    expect(() => chirpBits(1, [['a', 3]])).toThrow(/cover 3 bit/)
    expect(() =>
      chirpBits(1, [
        ['a', 4],
        ['b', 5],
      ]),
    ).toThrow(/cover 9 bit/)
  })
})

describe('scaled', () => {
  const freq = scaled(u32le, 10, [0, 0xffffffff])

  it('applies the factor in both directions', () => {
    const b = new Uint8Array(4)
    freq.set(b, 0, 145_350_000)
    expect(u32le.get(b, 0)).toBe(14_535_000)
    expect(freq.get(b, 0)).toBe(145_350_000)
  })

  it('passes sentinels through untouched', () => {
    const b = buf(0xff, 0xff, 0xff, 0xff)
    expect(freq.get(b, 0)).toBe(0xffffffff)
    const out = new Uint8Array(4)
    freq.set(out, 0, 0xffffffff)
    expect(out).toEqual(b)
  })
})

describe('bcdFreqLE', () => {
  it('matches the DM-32UV worked example', () => {
    // 145.350 MHz -> 14535000 -> `14 53 50 00` -> stored little-endian.
    const b = new Uint8Array(4)
    bcdFreqLE(4).set(b, 0, 145_350_000)
    expect([...b]).toEqual([0x00, 0x50, 0x53, 0x14])
    expect(bcdFreqLE(4).get(b, 0)).toBe(145_350_000)
  })

  it('survives the 462.5625 MHz case that breaks truncation', () => {
    const b = new Uint8Array(4)
    bcdFreqLE(4).set(b, 0, 462_562_500)
    expect(bcdFreqLE(4).get(b, 0)).toBe(462_562_500)
  })

  it('reports NaN for non-BCD nibbles instead of inventing a frequency', () => {
    expect(Number.isNaN(bcdFreqLE(4).get(buf(0xff, 0xff, 0xff, 0xff), 0))).toBe(true)
  })

  it('round-trips VHF and UHF frequencies on a 10 Hz grid', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99_999_999 }), (units) => {
        const b = new Uint8Array(4)
        bcdFreqLE(4).set(b, 0, units * 10)
        expect(bcdFreqLE(4).get(b, 0)).toBe(units * 10)
      }),
    )
  })
})

describe('lbcdFreq / bcdLE', () => {
  it('stores 146.520 MHz exactly as CHIRP lbcd does', () => {
    // Derived from chirp/bitwise.py: an lbcd array reverses its items and each
    // element is dec_to_bbcd(twodigits), so 14652000 -> 00 20 65 14.
    const b = new Uint8Array(4)
    lbcdFreq(4).set(b, 0, 146_520_000)
    expect([...b]).toEqual([0x00, 0x20, 0x65, 0x14])
    expect(lbcdFreq(4).get(b, 0)).toBe(146_520_000)
  })

  it('is the same encoding as the DM-32UV spec describes', () => {
    const a = new Uint8Array(4)
    const c = new Uint8Array(4)
    lbcdFreq(4).set(a, 0, 462_562_500)
    bcdFreqLE(4).set(c, 0, 462_562_500)
    expect([...a]).toEqual([...c])
  })

  it('round-trips raw BCD in both byte orders', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99_999_999 }), (v) => {
        const le = new Uint8Array(4)
        const be = new Uint8Array(4)
        bcdLE(4).set(le, 0, v)
        bcdBE(4).set(be, 0, v)
        expect(bcdLE(4).get(le, 0)).toBe(v)
        expect(bcdBE(4).get(be, 0)).toBe(v)
        expect([...le]).toEqual([...be].reverse())
      }),
    )
  })

  it('refuses a value with more digits than the field holds', () => {
    expect(() => bcdLE(2).set(new Uint8Array(2), 0, 12345)).toThrow(RangeError)
  })
})

describe('enumOf', () => {
  const f = enumOf(u8, { 0: 'none', 3: 'aes128', 4: 'aes256' } as const)

  it('maps known values to symbols', () => {
    expect(f.get(buf(4), 0)).toBe('aes256')
  })

  it('passes unknown values through as numbers so they survive write-back', () => {
    expect(f.get(buf(9), 0)).toBe(9)
    const b = new Uint8Array(1)
    f.set(b, 0, 9)
    expect(b[0]).toBe(9)
  })

  it('rejects an unknown symbol', () => {
    expect(() => f.set(new Uint8Array(1), 0, 'nope' as never)).toThrow(RangeError)
  })
})

describe('array', () => {
  it('honours a stride larger than the element', () => {
    const f = array(3, u8, 4)
    expect(f.size).toBe(9)
    expect(f.get(buf(1, 0, 0, 0, 2, 0, 0, 0, 3), 0)).toEqual([1, 2, 3])
  })

  it('rejects a stride smaller than the element', () => {
    expect(() => array(2, u16le, 1)).toThrow(RangeError)
  })
})

describe('idempotent writes (the property uploads depend on)', () => {
  it('ascii leaves existing padding alone when the string is unchanged', () => {
    const f = ascii(8, { pad: 0xff })
    // Radio wrote NUL padding; our field declares 0xFF. Rewriting the same name
    // must not touch a byte, or every upload diff fills with phantom changes.
    const b = buf(0x41, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)
    const before = [...b]
    f.set(b, 0, f.get(b, 0))
    expect([...b]).toEqual(before)
  })

  it('ascii still normalises padding for a genuine edit', () => {
    const f = ascii(8, { pad: 0xff })
    const b = buf(0x41, 0x42, 0x43, 0x44, 0x00, 0x00, 0x00, 0x00)
    f.set(b, 0, 'XY')
    expect([...b]).toEqual([0x58, 0x59, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  })

  it('BCD write-back of an undecodable slot is a no-op', () => {
    const f = bcdFreqLE(4)
    const b = buf(0xff, 0xff, 0xff, 0xff)
    expect(Number.isNaN(f.get(b, 0))).toBe(true)
    f.set(b, 0, f.get(b, 0))
    expect([...b]).toEqual([0xff, 0xff, 0xff, 0xff])
  })
})
