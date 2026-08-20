// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  encryptionLegality,
  isBlankKey,
  maskKey,
  resolveKeyEdit,
  validateKeyHex,
  KEY_BYTES,
} from '#core/model/encryption.js'

describe('validateKeyHex', () => {
  it('accepts a full AES-256 key and normalises it', () => {
    const r = validateKeyHex('aes256', '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff')
    expect(r.ok).toBe(true)
    expect(r.normalised).toBe('00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF')
  })

  it('tolerates the separators people paste', () => {
    const spaced = validateKeyHex('aes128', '00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff')
    const colons = validateKeyHex('aes128', '00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff')
    expect(spaced.ok).toBe(true)
    expect(colons.normalised).toBe(spaced.normalised)
  })

  it('rejects a key that is one nibble short', () => {
    // A short key is not a key. Accepting it produces a radio that looks
    // configured and cannot decrypt anything.
    const r = validateKeyHex('aes256', 'aa'.repeat(31) + 'b')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/exactly 32 bytes/)
    expect(r.error).toMatch(/This is 63/)
  })

  it('rejects non-hexadecimal input', () => {
    expect(validateKeyHex('aes128', 'zz'.repeat(16)).error).toMatch(/hexadecimal/)
  })

  it('states the required length for every type', () => {
    expect(KEY_BYTES).toMatchObject({ arc4: 5, custom: 7, aes128: 16, aes256: 32 })
    for (const t of ['arc4', 'custom', 'aes128', 'aes256'] as const) {
      expect(validateKeyHex(t, 'ab'.repeat(KEY_BYTES[t])).ok).toBe(true)
      expect(validateKeyHex(t, 'ab'.repeat(KEY_BYTES[t] + 1)).ok).toBe(false)
    }
  })
})

describe('maskKey', () => {
  it('shows enough to tell two slots apart and no more', () => {
    const masked = maskKey('00112233445566778899AABBCCDDEEFF')
    expect(masked.startsWith('0011')).toBe(true)
    expect(masked.endsWith('EEFF')).toBe(true)
    expect(masked).not.toContain('2233')
  })

  it('never reveals more than a quarter of a key', () => {
    for (const type of ['arc4', 'custom', 'aes128', 'aes256'] as const) {
      const hex = 'A'.repeat(KEY_BYTES[type] * 2)
      const shown = [...maskKey(hex)].filter((c) => c !== '•').length
      expect(shown, `${type} reveals ${shown} of ${hex.length}`).toBeLessThanOrEqual(hex.length / 4)
    }
  })

  it('hides a short key completely', () => {
    // A fixed four-either-end budget showed eight of an ARC4 key's ten
    // characters. Short slots are told apart by their names instead.
    expect(maskKey('A'.repeat(KEY_BYTES.arc4 * 2))).toBe('•'.repeat(10))
    expect(maskKey('A'.repeat(KEY_BYTES.custom * 2))).toBe('•'.repeat(14))
  })

  it('keeps the masked string the same length as the key', () => {
    for (const n of [0, 1, 8, 10, 14, 32, 64]) {
      expect(maskKey('A'.repeat(n))).toHaveLength(n)
    }
  })
})

describe('isBlankKey', () => {
  it('recognises a cleared or redacted slot', () => {
    expect(isBlankKey('0'.repeat(64))).toBe(true)
    expect(isBlankKey('00112233')).toBe(false)
  })
})

describe('encryptionLegality', () => {
  it('forbids encryption on the amateur bands', () => {
    for (const mhz of [52.525, 146.52, 223.5, 446.0, 927.0]) {
      const r = encryptionLegality(mhz * 1e6)
      expect(r.allowed, `${mhz} MHz`).toBe(false)
      expect(r.service).toBe('amateur')
      expect(r.cfr).toMatch(/97\.113/)
    }
  })

  it('forbids encryption on GMRS, FRS and MURS', () => {
    expect(encryptionLegality(462_562_500).allowed).toBe(false)
    expect(encryptionLegality(467_712_500).allowed).toBe(false)
    expect(encryptionLegality(151_820_000).service).toBe('MURS')
  })

  it('flags weather channels as receive-only', () => {
    expect(encryptionLegality(162_550_000).allowed).toBe(false)
  })

  it('permits it on land mobile, while naming the licence needed', () => {
    const r = encryptionLegality(464_500_000)
    expect(r.allowed).toBe(true)
    expect(r.reason).toMatch(/Part 90 land-mobile|licence that authorises/)
    expect(r.reason).toMatch(/You are responsible/)
  })
})

describe('resolveKeyEdit', () => {
  const AES256 = 'A'.repeat(64)
  const stored = { type: 'aes256', keyHex: AES256 } as const

  it('keeps the stored key when the field is left blank, so a slot can be renamed', () => {
    const r = resolveKeyEdit({ type: 'aes256', hex: '' }, stored)
    expect(r).toEqual({ ok: true, keyHex: AES256, keptExisting: true })
  })

  it('treats a field of only separators as blank rather than as a malformed key', () => {
    // Selecting the masked key and typing over it can leave stray spacing
    // behind; that is still "I did not enter a key", not a bad key.
    const r = resolveKeyEdit({ type: 'aes256', hex: '  : - ' }, stored)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.keptExisting).toBe(true)
  })

  it('replaces the key when one is actually entered', () => {
    const fresh = 'b'.repeat(64)
    const r = resolveKeyEdit({ type: 'aes256', hex: fresh }, stored)
    expect(r).toEqual({ ok: true, keyHex: 'B'.repeat(64), keptExisting: false })
  })

  it('refuses to reinterpret stored bytes as a different type', () => {
    // 32 stored bytes are not a 5-byte ARC4 key, and silently truncating them
    // would produce a slot that looks configured and cannot decrypt.
    const r = resolveKeyEdit({ type: 'arc4', hex: '' }, stored)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/needs a new key/)
      expect(r.error).toContain('32 bytes')
      expect(r.error).toContain('5')
    }
  })

  it('still requires a key for a slot that has none', () => {
    const r = resolveKeyEdit({ type: 'aes256', hex: '' }, null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Enter a key/)
  })

  it('rejects a short key rather than padding it', () => {
    const r = resolveKeyEdit({ type: 'aes256', hex: 'AA' }, stored)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/exactly 32 bytes/)
  })

  it('rejects non-hex input', () => {
    const r = resolveKeyEdit({ type: 'aes256', hex: 'Z'.repeat(64) }, stored)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/hexadecimal/)
  })

  it('keeps a blank stored key blank rather than inventing material', () => {
    // A slot read from a radio can legitimately hold all zeros. Renaming it
    // must not conjure a key, and must not be blocked either.
    const blank = { type: 'aes256', keyHex: '0'.repeat(64) } as const
    const r = resolveKeyEdit({ type: 'aes256', hex: '' }, blank)
    expect(r).toEqual({ ok: true, keyHex: '0'.repeat(64), keptExisting: true })
  })
})
