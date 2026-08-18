// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { checksum8, crc16Xmodem, fromHex, hexDump, sha256Hex, toHex } from '#core/codec/checksum.js'

const enc = (s: string) => new TextEncoder().encode(s)

describe('crc16Xmodem', () => {
  it('matches the published check vectors', () => {
    // The standard CRC-16/XMODEM check value for "123456789" is 0x31C3.
    expect(crc16Xmodem(enc('123456789'))).toBe(0x31c3)
    expect(crc16Xmodem(enc('A'))).toBe(0x58e5)
    expect(crc16Xmodem(new Uint8Array(0))).toBe(0x0000)
  })

  it('stays inside 16 bits for any input', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (d) => {
        const c = crc16Xmodem(d)
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(0xffff)
      }),
    )
  })
})

describe('checksum8', () => {
  it('truncates the byte sum to one byte', () => {
    expect(checksum8(Uint8Array.from([0xff, 0x01]))).toBe(0x00)
    expect(checksum8(Uint8Array.from([0x10, 0x20, 0x30]))).toBe(0x60)
  })
})

describe('hex helpers', () => {
  it('round-trips', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (d) => {
        expect([...fromHex(toHex(d))]).toEqual([...d])
      }),
    )
  })

  it('tolerates the separators people actually paste', () => {
    const want = [0xab, 0xcd, 0xef, 0x12]
    for (const s of ['ABCDEF12', 'ab:cd:ef:12', 'AB CD EF 12', '0xAB 0xCD 0xEF 0x12', 'AB-CD-EF-12', 'ab_cd_ef_12']) {
      expect([...fromHex(s)]).toEqual(want)
    }
  })

  it('rejects malformed hex rather than guessing', () => {
    expect(() => fromHex('ABC')).toThrow(/odd number/)
    expect(() => fromHex('ZZ')).toThrow(/non-hex/)
  })

  it('truncates a hex dump with a count', () => {
    const d = Uint8Array.from([1, 2, 3, 4, 5])
    expect(hexDump(d)).toBe('01 02 03 04 05')
    expect(hexDump(d, 2)).toBe('01 02 ... (+3 bytes)')
  })
})

describe('sha256Hex', () => {
  it('matches the known digest of the empty input', async () => {
    await expect(sha256Hex(new Uint8Array(0))).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('matches the known digest of "abc"', async () => {
    await expect(sha256Hex(enc('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('hashes a subarray by its own contents, not the parent buffer', async () => {
    const parent = enc('XXXabcXXX')
    await expect(sha256Hex(parent.subarray(3, 6))).resolves.toBe(await sha256Hex(enc('abc')))
  })
})
