// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * CRC-16/XMODEM: poly 0x1021, init 0x0000, no reflection, no final xor.
 * Used by the Quansheng UV-K5 framing.
 */
export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc & 0xffff
}

/** Sum of all bytes, truncated to one byte. Common in Baofeng-family framing. */
export function checksum8(data: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < data.length; i++) sum = (sum + data[i]!) & 0xff
  return sum
}

/** Lowercase hex, no separators. */
export function toHex(data: Uint8Array): string {
  let s = ''
  for (let i = 0; i < data.length; i++) s += data[i]!.toString(16).padStart(2, '0')
  return s
}

/** Parse hex, tolerating whitespace, `0x` prefixes, colons and dashes. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/0x/gi, '').replace(/[\s:_-]/g, '')
  if (clean.length % 2 !== 0) throw new RangeError(`fromHex: odd number of hex digits (${clean.length})`)
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new RangeError('fromHex: contains non-hex characters')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.substr(i * 2, 2), 16)
  return out
}

/** Space-separated hex, for protocol log lines and error messages. */
export function hexDump(data: Uint8Array, max = data.length): string {
  const n = Math.min(max, data.length)
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(data[i]!.toString(16).padStart(2, '0'))
  return parts.join(' ') + (data.length > n ? ` ... (+${data.length - n} bytes)` : '')
}

/** SHA-256 as lowercase hex. Uses WebCrypto, available in browsers and Node 24. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return toHex(new Uint8Array(digest))
}
