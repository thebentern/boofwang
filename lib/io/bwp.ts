// SPDX-License-Identifier: GPL-3.0-or-later
import { fromHex, sha256Hex, toHex } from '../codec/checksum.js'
import type { RadioId } from '../model/codeplug.js'
import type { ImageRegion, RadioImage } from '../radio/image.js'

/**
 * `.bwp` — a radio image with its identity attached.
 *
 * A raw `.bin` dump is just bytes: nothing in it says which radio it came from,
 * which firmware, or whether it is complete. Uploading a UV-K5 image to a
 * DM-32UV, or an egzumer image to a stock radio, is a plausible mistake with an
 * expensive outcome, and a bare `.bin` gives the app no way to object.
 *
 * So a `.bwp` carries the radio id, the firmware string, the memory layout, and
 * a SHA-256 of the payload. Raw `.bin` import is still supported for CHIRP
 * interoperability, but it makes the user name the radio and confirm.
 *
 * Layout, all little-endian:
 *
 *   0x00  4   magic 'BWPK'
 *   0x04  2   format version (currently 1)
 *   0x06  2   header length in bytes, from 0x08 to the start of the payload
 *   0x08  N   header, UTF-8 JSON
 *   ...   M   payload: each region's bytes, concatenated in header order
 */

export const BWP_MAGIC = Uint8Array.from([0x42, 0x57, 0x50, 0x4b]) // 'BWPK'
export const BWP_VERSION = 1

export interface BwpRegionHeader {
  start: number
  length: number
  label: string
  readOnly: boolean
}

export interface BwpHeader {
  version: number
  radioId: RadioId
  variant: string
  layout: string
  createdAt: string
  /** SHA-256 of the payload, as lowercase hex. */
  sha256: string
  regions: BwpRegionHeader[]
  meta: Record<string, unknown>
  /** What produced the file, for bug reports. */
  producer: string
}

export class BwpFormatError extends Error {
  override readonly name = 'BwpFormatError'
}

function concatRegions(regions: readonly ImageRegion[]): Uint8Array {
  const total = regions.reduce((n, r) => n + r.data.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const r of regions) {
    out.set(r.data, off)
    off += r.data.length
  }
  return out
}

export async function encodeBwp(image: RadioImage, producer = 'boofwang'): Promise<Uint8Array> {
  const payload = concatRegions(image.regions)
  const header: BwpHeader = {
    version: BWP_VERSION,
    radioId: image.radioId,
    variant: image.variant,
    layout: image.layout,
    createdAt: image.createdAt,
    sha256: await sha256Hex(payload),
    regions: image.regions.map((r) => ({
      start: r.start,
      length: r.data.length,
      label: r.label,
      readOnly: r.readOnly === true,
    })),
    meta: { ...image.meta },
    producer,
  }

  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  if (headerBytes.length > 0xffff) throw new BwpFormatError('Header is too large to encode')

  const out = new Uint8Array(8 + headerBytes.length + payload.length)
  out.set(BWP_MAGIC, 0)
  out[4] = BWP_VERSION & 0xff
  out[5] = (BWP_VERSION >> 8) & 0xff
  out[6] = headerBytes.length & 0xff
  out[7] = (headerBytes.length >> 8) & 0xff
  out.set(headerBytes, 8)
  out.set(payload, 8 + headerBytes.length)
  return out
}

export function looksLikeBwp(data: Uint8Array): boolean {
  return data.length >= 8 && BWP_MAGIC.every((b, i) => data[i] === b)
}

export async function decodeBwp(data: Uint8Array): Promise<RadioImage> {
  if (!looksLikeBwp(data)) {
    throw new BwpFormatError('Not a boofwang codeplug file (the BWPK signature is missing).')
  }

  const version = data[4]! | (data[5]! << 8)
  if (version > BWP_VERSION) {
    throw new BwpFormatError(
      `This file was written by a newer version of boofwang (format ${version}, this build understands ${BWP_VERSION}).`,
    )
  }

  const headerLen = data[6]! | (data[7]! << 8)
  if (8 + headerLen > data.length) throw new BwpFormatError('The file is truncated: the header runs past the end.')

  let header: BwpHeader
  try {
    header = JSON.parse(new TextDecoder().decode(data.subarray(8, 8 + headerLen))) as BwpHeader
  } catch {
    throw new BwpFormatError('The file header is not valid JSON; the file is probably corrupt.')
  }
  if (!Array.isArray(header.regions) || header.regions.length === 0) {
    throw new BwpFormatError('The file header declares no memory regions.')
  }

  const payload = data.subarray(8 + headerLen)
  const declared = header.regions.reduce((n, r) => n + r.length, 0)
  if (payload.length !== declared) {
    throw new BwpFormatError(
      `The file is truncated or padded: the header declares ${declared} bytes of memory but ${payload.length} are present.`,
    )
  }

  // Checked rather than trusted: a codeplug that gets written back to a radio
  // is exactly the wrong place to discover silent corruption.
  const actual = await sha256Hex(payload)
  if (header.sha256 && actual !== header.sha256) {
    throw new BwpFormatError(
      `This file failed its checksum, so its contents have changed since it was saved. Do not write it to a radio.`,
    )
  }

  let off = 0
  const regions: ImageRegion[] = header.regions.map((r) => {
    const slice = payload.slice(off, off + r.length)
    off += r.length
    return { start: r.start, data: slice, label: r.label, readOnly: r.readOnly }
  })

  return {
    radioId: header.radioId,
    variant: header.variant,
    layout: header.layout,
    createdAt: header.createdAt,
    regions,
    meta: header.meta ?? {},
    sha256: actual,
  }
}

/** Read a `.bwp` header without materialising the payload, for a file listing. */
export function peekBwpHeader(data: Uint8Array): BwpHeader | null {
  if (!looksLikeBwp(data)) return null
  const headerLen = data[6]! | (data[7]! << 8)
  if (8 + headerLen > data.length) return null
  try {
    return JSON.parse(new TextDecoder().decode(data.subarray(8, 8 + headerLen))) as BwpHeader
  } catch {
    return null
  }
}

/**
 * A raw `.bin` dump: every region concatenated, no metadata.
 *
 * This is what CHIRP and k5prog produce, so it is what other tools accept.
 * Importing one requires the user to say which radio it is, because the bytes
 * cannot say so themselves.
 */
export function encodeRawBin(image: RadioImage): Uint8Array {
  return concatRegions(image.regions.filter((r) => !isSidecarRegion(r.start)))
}

/**
 * A region that a raw `.bin` has nowhere to record.
 *
 * The DM-32UV addresses its config pages by logical block id, `id << 12`, so
 * every one of them starts below 0x100000. Its DMR address book is a different
 * animal: a raw region at a real physical address around 0x278000, with no
 * block id in the page and nothing in a flat `.bin` that could say where it
 * came from. Re-importing such a file reads the address book's bytes as though
 * they were config pages.
 *
 * A `.bwp` carries each region's declared start, so it keeps them. The `.bin`
 * drops them rather than pretending.
 */
export function isSidecarRegion(start: number): boolean {
  return start >>> 12 > 0xff
}

export interface RawBinLayout {
  radioId: RadioId
  variant: string
  layout: string
  regions: readonly { start: number; length: number; label: string; readOnly?: boolean }[]
}

export async function decodeRawBin(data: Uint8Array, expect: RawBinLayout): Promise<RadioImage> {
  const total = expect.regions.reduce((n, r) => n + r.length, 0)
  if (data.length !== total) {
    throw new BwpFormatError(
      `This file is ${data.length} bytes; a ${expect.radioId} image is ${total}. It is probably from a different radio.`,
    )
  }
  let off = 0
  const regions: ImageRegion[] = expect.regions.map((r) => {
    const slice = data.slice(off, off + r.length)
    off += r.length
    return { start: r.start, data: slice, label: r.label, readOnly: r.readOnly === true }
  })
  return {
    radioId: expect.radioId,
    variant: expect.variant,
    layout: expect.layout,
    createdAt: new Date().toISOString(),
    regions,
    meta: { importedFrom: 'raw-bin' },
    sha256: await sha256Hex(data),
  }
}

export { fromHex, toHex }
