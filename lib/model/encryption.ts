// SPDX-License-Identifier: GPL-3.0-or-later
import type { EncryptionType } from './codeplug.js'

/**
 * Encryption keys, and the rules about using them.
 *
 * Kept in the framework-agnostic core so the validation and the regulatory
 * facts are testable, and so the UI cannot quietly disagree with what the
 * encoder will accept.
 */

/** Key length in bytes for each type. */
export const KEY_BYTES: Readonly<Record<EncryptionType, number>> = {
  none: 0,
  // The short types are vendor-specific scramblers rather than real ciphers.
  custom: 7,
  arc4: 5,
  aes128: 16,
  aes256: 32,
}

export const KEY_TYPE_LABELS: Readonly<Record<EncryptionType, string>> = {
  none: 'None',
  custom: 'Custom',
  arc4: 'ARC4',
  aes128: 'AES-128',
  aes256: 'AES-256',
}

export interface KeyValidation {
  ok: boolean
  /** Normalised uppercase hex with separators stripped, when valid. */
  normalised: string
  error?: string
}

/**
 * Check and normalise a pasted key.
 *
 * Deliberately strict about length: a key that is one nibble short is not a
 * key, and accepting it would produce a radio that appears configured and
 * cannot decrypt anything.
 */
export function validateKeyHex(type: EncryptionType, input: string): KeyValidation {
  const cleaned = input.replace(/0x/gi, '').replace(/[\s:_-]/g, '').toUpperCase()

  if (type === 'none') {
    return { ok: cleaned.length === 0, normalised: '', ...(cleaned.length ? { error: 'Select a key type first.' } : {}) }
  }
  if (cleaned.length === 0) return { ok: false, normalised: '', error: 'Enter a key.' }
  if (!/^[0-9A-F]+$/.test(cleaned)) {
    return { ok: false, normalised: '', error: 'A key is hexadecimal: digits 0-9 and letters A-F only.' }
  }

  const wantHexChars = KEY_BYTES[type] * 2
  if (cleaned.length !== wantHexChars) {
    return {
      ok: false,
      normalised: '',
      error:
        `${KEY_TYPE_LABELS[type]} needs exactly ${KEY_BYTES[type]} bytes — ${wantHexChars} hex characters. ` +
        `This is ${cleaned.length}.`,
    }
  }

  return { ok: true, normalised: cleaned }
}

/** A key rendered for display, revealing only enough to tell slots apart. */
export function maskKey(hex: string): string {
  if (hex.length <= 8) return '•'.repeat(hex.length)
  return `${hex.slice(0, 4)}${'•'.repeat(Math.max(0, hex.length - 8))}${hex.slice(-4)}`
}

/** True when every byte is zero — a slot that has been cleared or redacted. */
export function isBlankKey(hex: string): boolean {
  return hex.length > 0 && /^0+$/.test(hex)
}

export interface EncryptionLegality {
  allowed: boolean
  service: string
  reason: string
  cfr?: string
}

/**
 * Whether encryption may lawfully be used on a frequency, in the United States.
 *
 * This is the part people get wrong, and the consequences are legal rather than
 * technical. Encryption is a normal feature of licensed land-mobile operation
 * and is flatly prohibited on the amateur and personal radio services. The
 * radio will happily do it either way, which is exactly why the tool should
 * say so.
 *
 * Written for the US; boofwang makes no claim about other administrations.
 */
export function encryptionLegality(rxHz: number): EncryptionLegality {
  const mhz = rxHz / 1e6

  // Amateur allocations. 47 CFR 97.113(a)(4) forbids "messages encoded for the
  // purpose of obscuring their meaning".
  const amateur =
    (mhz >= 50 && mhz <= 54) ||
    (mhz >= 144 && mhz <= 148) ||
    (mhz >= 219 && mhz <= 225) ||
    (mhz >= 420 && mhz <= 450) ||
    (mhz >= 902 && mhz <= 928)
  if (amateur) {
    return {
      allowed: false,
      service: 'amateur',
      reason: 'Encryption is prohibited on the amateur bands: transmissions may not be encoded to obscure their meaning.',
      cfr: '47 CFR 97.113(a)(4)',
    }
  }

  // GMRS and FRS share these channels; both forbid obscuring meaning.
  const gmrsFrs = (mhz >= 462.5 && mhz <= 462.75) || (mhz >= 467.5 && mhz <= 467.75)
  if (gmrsFrs) {
    return {
      allowed: false,
      service: 'GMRS/FRS',
      reason: 'Encryption is prohibited on GMRS and FRS: messages may not be encoded to obscure their meaning.',
      cfr: '47 CFR 95.1731 / 95.587',
    }
  }

  const murs = [151.82, 151.88, 151.94, 154.57, 154.6].some((f) => Math.abs(mhz - f) < 0.001)
  if (murs) {
    return {
      allowed: false,
      service: 'MURS',
      reason: 'Encryption is prohibited on MURS.',
      cfr: '47 CFR 95.2731',
    }
  }

  if (mhz >= 162.4 && mhz <= 162.55) {
    return { allowed: false, service: 'NOAA weather', reason: 'This is a receive-only weather channel.' }
  }

  return {
    allowed: true,
    service: 'land mobile',
    reason:
      'Encryption is permitted here only under a licence that authorises it — typically a Part 90 land-mobile ' +
      'licence for business, industrial or public-safety use. You are responsible for holding one.',
    cfr: '47 CFR Part 90',
  }
}
