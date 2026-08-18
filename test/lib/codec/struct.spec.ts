// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ascii, bcdFreqLE, bits, bytes, chirpBits, u8, u16le } from '#core/codec/fields.js'
import {
  applyRanges,
  at,
  defineStruct,
  diffRanges,
  equalBytes,
  rangesContain,
} from '#core/codec/struct.js'

describe('defineStruct validation', () => {
  it('rejects overlapping fields at definition time', () => {
    expect(() => defineStruct(8, { a: at(0, u16le), b: at(1, u8) })).toThrow(/overlaps/)
  })

  it('rejects a field past the end of the record', () => {
    expect(() => defineStruct(4, { a: at(2, u16le), b: at(3, u16le) })).toThrow(/overlaps|exceeds/)
    expect(() => defineStruct(4, { a: at(3, u16le) })).toThrow(/exceeds/)
  })

  it('rejects a negative offset', () => {
    expect(() => defineStruct(4, { a: at(-1, u8) })).toThrow(/negative/)
  })

  it('allows deliberate gaps', () => {
    const s = defineStruct(8, { a: at(0, u8), b: at(4, u8) })
    expect(s.coverage().gaps).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 8 },
    ])
  })
})

describe('coverage', () => {
  it('reports how much of a record is understood', () => {
    const s = defineStruct(16, { name: at(0, ascii(10)), flags: at(12, u8) })
    const c = s.coverage()
    expect(c.named).toBe(11)
    expect(c.total).toBe(16)
    expect(c.ratio).toBeCloseTo(11 / 16)
    expect(c.gaps).toEqual([
      { start: 10, end: 12 },
      { start: 13, end: 16 },
    ])
  })

  it('reports full coverage with no gaps', () => {
    const s = defineStruct(2, { a: at(0, u8), b: at(1, u8) })
    expect(s.coverage()).toMatchObject({ named: 2, total: 2, gaps: [], ratio: 1 })
  })
})

// A record deliberately shaped like the hard case: fields we understand, bytes
// we do not, and a byte where we know only one bit.
const PARTIAL = defineStruct(16, {
  rxFreq: at(0x00, bcdFreqLE(4)),
  name: at(0x04, ascii(6, { pad: 0xff })),
  // We know bit 7 of 0x0a means "encryption on". We know nothing about 0-6.
  flags: at(0x0a, bits(1, { encryptEnable: [7, 1] })),
  keyId: at(0x0b, u8),
  // 0x0c..0x0f: undocumented.
})

describe('write is a patch, not a rebuild', () => {
  it('leaves fields absent from the patch untouched', () => {
    const buf = new Uint8Array(16).fill(0xaa)
    PARTIAL.write(buf, 0, { keyId: 3 })
    expect(buf[0x0b]).toBe(3)
    expect([...buf.subarray(0, 0x0b)]).toEqual(Array(0x0b).fill(0xaa))
    expect([...buf.subarray(0x0c)]).toEqual(Array(4).fill(0xaa))
  })

  it('treats an explicit undefined as absent', () => {
    const buf = new Uint8Array(16).fill(0x11)
    PARTIAL.write(buf, 0, { keyId: undefined })
    expect(buf[0x0b]).toBe(0x11)
  })

  it('never disturbs bits it does not model', () => {
    const buf = new Uint8Array(16).fill(0x00)
    buf[0x0a] = 0b0101_1011 // bits 0-6 carry meaning we have not decoded
    PARTIAL.write(buf, 0, { flags: { encryptEnable: 1 } })
    expect(buf[0x0a]).toBe(0b1101_1011)
    PARTIAL.write(buf, 0, { flags: { encryptEnable: 0 } })
    expect(buf[0x0a]).toBe(0b0101_1011)
  })

  it('never writes outside the bytes it owns', () => {
    const buf = new Uint8Array(32).fill(0x5a)
    PARTIAL.write(buf, 8, { rxFreq: 146_520_000, name: 'W4ABC', flags: { encryptEnable: 1 }, keyId: 2 })
    expect([...buf.subarray(0, 8)]).toEqual(Array(8).fill(0x5a))
    expect([...buf.subarray(8 + 0x0c)]).toEqual(Array(32 - 8 - 0x0c).fill(0x5a))
  })
})

describe('the round-trip invariant', () => {
  // This is the property the whole safety story rests on: decoding a record and
  // writing the decoded values straight back must not change a single byte,
  // including bytes no field claims.
  it('read then write-back is byte-identical for arbitrary content', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (raw) => {
        const base = Uint8Array.from(raw)
        const original = Uint8Array.from(base)
        PARTIAL.write(base, 0, PARTIAL.read(base))
        expect(equalBytes(base, original)).toBe(true)
      }),
      { numRuns: 1000 },
    )
  })

  it('holds for undecodable BCD and every padding convention', () => {
    // 0xFF fill is what an unprogrammed slot looks like on these radios: the
    // frequency is not valid BCD and the name field is empty. Neither may be
    // "helpfully" rewritten to zeros.
    for (const fill of [0x00, 0xff, 0x20, 0xaa]) {
      const base = new Uint8Array(16).fill(fill)
      const original = Uint8Array.from(base)
      PARTIAL.write(base, 0, PARTIAL.read(base))
      expect(equalBytes(base, original)).toBe(true)
    }
  })

  it('holds for a struct with gaps and every primitive kind', () => {
    const S = defineStruct(24, {
      a: at(0, u8),
      b: at(2, u16le),
      c: at(4, ascii(6, { pad: 0x00 })),
      d: at(12, bytes(4)),
      e: at(20, chirpBits(1, [
        ['unknown1', 3],
        ['power', 2],
        ['bandwidth', 1],
        ['unknown2', 2],
      ])),
      // 1, 10-11, 16-19, 21-23 deliberately unmodelled
    })
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 24, maxLength: 24 }), (raw) => {
        const base = Uint8Array.from(raw)
        const original = Uint8Array.from(base)
        S.write(base, 0, S.read(base))
        expect(equalBytes(base, original)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})

describe('view', () => {
  it('reads and writes through to the buffer', () => {
    const buf = new Uint8Array(16).fill(0)
    const v = PARTIAL.view(buf)
    v.keyId = 7
    expect(buf[0x0b]).toBe(7)
    buf[0x0b] = 4
    expect(v.keyId).toBe(4)
  })

  it('honours a non-zero base offset', () => {
    const buf = new Uint8Array(32).fill(0)
    const v = PARTIAL.view(buf, 16)
    v.keyId = 9
    expect(buf[16 + 0x0b]).toBe(9)
    expect(buf[0x0b]).toBe(0)
  })
})

describe('ranges', () => {
  it('merges adjacent fields and sorts', () => {
    expect(PARTIAL.ranges()).toEqual([
      [0, 12],
    ])
  })

  it('keeps disjoint ranges separate', () => {
    const s = defineStruct(16, { a: at(0, u8), b: at(8, u8) })
    expect(s.ranges()).toEqual([
      [0, 1],
      [8, 9],
    ])
  })
})

describe('applyRanges', () => {
  it('copies only the listed ranges', () => {
    const live = new Uint8Array(16).fill(0x11)
    const ours = new Uint8Array(16).fill(0x22)
    applyRanges(live, ours, [[4, 8]])
    expect([...live]).toEqual([
      0x11, 0x11, 0x11, 0x11, 0x22, 0x22, 0x22, 0x22, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11,
    ])
  })

  it('is the mechanism that preserves undocumented bytes', () => {
    // The radio holds bytes we have never decoded (0x0c..0x0f here). Our image
    // may be stale there. Merging only owned ranges carries the device's own
    // bytes through untouched.
    const fromRadio = new Uint8Array(16).fill(0x00)
    fromRadio.set([0xde, 0xad, 0xbe, 0xef], 0x0c)
    const ourStaleImage = new Uint8Array(16).fill(0x99)
    applyRanges(fromRadio, ourStaleImage, PARTIAL.ranges())
    expect([...fromRadio.subarray(0x0c)]).toEqual([0xde, 0xad, 0xbe, 0xef])
    expect([...fromRadio.subarray(0, 12)]).toEqual(Array(12).fill(0x99))
  })

  it('refuses to run off the end', () => {
    expect(() => applyRanges(new Uint8Array(4), new Uint8Array(4), [[0, 8]])).toThrow(RangeError)
  })
})

describe('diffRanges', () => {
  it('finds contiguous runs of difference', () => {
    const a = Uint8Array.from([1, 2, 3, 4, 5, 6])
    const b = Uint8Array.from([1, 9, 9, 4, 5, 8])
    expect(diffRanges(a, b)).toEqual([
      [1, 3],
      [5, 6],
    ])
  })

  it('returns nothing for identical buffers', () => {
    expect(diffRanges(new Uint8Array(8), new Uint8Array(8))).toEqual([])
  })

  it('rejects a length mismatch rather than comparing a prefix', () => {
    expect(() => diffRanges(new Uint8Array(4), new Uint8Array(5))).toThrow(RangeError)
  })
})

describe('rangesContain', () => {
  it('detects a change that falls outside what a driver claims to own', () => {
    const owned = PARTIAL.ranges()
    expect(rangesContain(owned, [4, 8])).toBe(true)
    // A write landing at 0x0c is a driver bug: nothing there is modelled.
    expect(rangesContain(owned, [12, 13])).toBe(false)
  })
})

describe('blank', () => {
  it('fills with the radio’s erase value, not an implicit zero', () => {
    expect([...PARTIAL.blank(0xff)]).toEqual(Array(16).fill(0xff))
    expect([...PARTIAL.blank(0x00)]).toEqual(Array(16).fill(0x00))
  })
})

describe('rangesContain across adjacent ranges', () => {
  // The UV-K5's owned ranges are adjacent: the channel table ends at 0x0D60 and
  // the attribute table begins there. A diff spanning that boundary is fully
  // owned, but fits inside neither range on its own - so testing each range
  // separately would report a legitimate write as an encoder bug and block it.
  const UVK5_OWNED = [
    [0x0000, 0x0d60],
    [0x0d60, 0x0e28],
    [0x0f50, 0x1bd0],
  ] as const

  it('accepts a probe spanning two adjacent ranges', () => {
    expect(rangesContain(UVK5_OWNED, [0x0d5e, 0x0d62])).toBe(true)
  })

  it('accepts a probe covering two adjacent ranges entirely', () => {
    expect(rangesContain(UVK5_OWNED, [0x0000, 0x0e28])).toBe(true)
  })

  it('still rejects a probe that crosses a genuine gap', () => {
    // 0x0E28..0x0F50 is unmodelled: nothing may write there.
    expect(rangesContain(UVK5_OWNED, [0x0e20, 0x0f60])).toBe(false)
    expect(rangesContain(UVK5_OWNED, [0x0e30, 0x0e40])).toBe(false)
  })

  it('rejects a probe that runs past the last range', () => {
    expect(rangesContain(UVK5_OWNED, [0x1bc0, 0x1c00])).toBe(false)
  })

  it('handles single ranges and empty probes', () => {
    expect(rangesContain([[0, 16]], [4, 8])).toBe(true)
    expect(rangesContain([[0, 16]], [16, 20])).toBe(false)
    expect(rangesContain([], [4, 4])).toBe(true)
    expect(rangesContain([], [4, 8])).toBe(false)
  })

  it('does not depend on the ranges being sorted', () => {
    expect(rangesContain([[0x0d60, 0x0e28], [0x0000, 0x0d60]], [0x0d5e, 0x0d62])).toBe(true)
  })
})
