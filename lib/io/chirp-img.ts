// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256Hex } from '../codec/checksum.js'
import type { RadioId } from '../model/codeplug.js'
import type { ImageRegion, RadioImage } from '../radio/image.js'

/**
 * CHIRP's `.img` container.
 *
 * The whole format is `raw memory` + a 13-byte magic + base64 of a JSON blob.
 * No length prefix, no checksum, no terminator - which is why the magic has to
 * be found rather than seeked to.
 *
 * Transcribed from `chirp_common.CloneModeRadio` (GPL-3.0).
 */

/** `chirp_common.MAGIC`. */
export const CHIRP_MAGIC = Uint8Array.from([
  0x00, 0xff, 0x63, 0x68, 0x69, 0x72, 0x70, 0xee, 0x69, 0x6d, 0x67, 0x00, 0x01,
])

export class ChirpImgError extends Error {
  override readonly name = 'ChirpImgError'
}

export interface ChirpMetadata {
  rclass?: string
  vendor?: string
  model?: string
  variant?: string
  chirp_version?: string
  /** The UV-K5's hello string. CHIRP validates this and refuses unknown ones. */
  uvk5_firmware?: string
  [key: string]: unknown
}

function indexOfMagicFromEnd(data: Uint8Array): number {
  // CHIRP uses the *first* occurrence, which is a latent bug: those 13 bytes can
  // legitimately appear inside radio memory, and a codeplug that happens to
  // contain them would be truncated there. Searching backwards finds the real
  // trailer, and the caller checks that what is left is a plausible image.
  outer: for (let i = data.length - CHIRP_MAGIC.length; i >= 0; i--) {
    for (let j = 0; j < CHIRP_MAGIC.length; j++) {
      if (data[i + j] !== CHIRP_MAGIC[j]) continue outer
    }
    return i
  }
  return -1
}

export function looksLikeChirpImg(data: Uint8Array): boolean {
  return indexOfMagicFromEnd(data) >= 0
}

export interface ChirpImgParts {
  /** The memory map, with the trailer removed. */
  readonly memory: Uint8Array
  readonly metadata: ChirpMetadata
}

/**
 * Split an `.img` into its memory and its metadata.
 *
 * A blob that will not decode is reported as empty metadata rather than an
 * error, matching CHIRP: the memory is still perfectly good, and refusing the
 * whole file over a damaged trailer would lose a codeplug for no reason.
 */
export function splitChirpImg(data: Uint8Array): ChirpImgParts {
  const at = indexOfMagicFromEnd(data)
  if (at < 0) throw new ChirpImgError('This file has no CHIRP metadata trailer.')

  const memory = data.slice(0, at)
  const tail = data.subarray(at + CHIRP_MAGIC.length)

  let metadata: ChirpMetadata
  try {
    let b64 = ''
    for (const b of tail) b64 += String.fromCharCode(b)
    const json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
    metadata = JSON.parse(json) as ChirpMetadata
  } catch {
    metadata = {}
  }
  return { memory, metadata }
}

/**
 * The vendor/model pair CHIRP records for each radio boofwang supports.
 *
 * `variant` is deliberately the empty string rather than the firmware: CHIRP
 * matches a file by vendor, model and the driver class's own VARIANT, which is
 * empty for all of these. Writing a firmware string there makes CHIRP reject
 * the file as an unsupported model. The firmware travels in `uvk5_firmware`
 * instead, which is where CHIRP's UV-K5 driver looks for it.
 */
export const CHIRP_IDENTITY: Partial<Record<RadioId, { vendor: string; model: string; rclass: string }>> = {
  uvk5: { vendor: 'Quansheng', model: 'UV-K5', rclass: 'UVK5Radio' },
  uv82: { vendor: 'Baofeng', model: 'UV-82', rclass: 'BaofengUV82Radio' },
  uv5rmini: { vendor: 'Baofeng', model: '5RM', rclass: 'BF5RM' },
}

function concat(regions: readonly ImageRegion[]): Uint8Array {
  const total = regions.reduce((n, r) => n + r.data.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const r of regions) {
    out.set(r.data, off)
    off += r.data.length
  }
  return out
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64')
}

/**
 * Write a CHIRP-compatible `.img`.
 *
 * Refuses radios CHIRP has no driver for rather than producing a file that
 * looks importable and is not. The DM-32UV is the case that matters: CHIRP has
 * never supported it, so an `.img` for it would be a promise nothing can keep.
 */
export async function encodeChirpImg(
  image: RadioImage,
  opts: { chirpVersion?: string } = {},
): Promise<Uint8Array> {
  const identity = CHIRP_IDENTITY[image.radioId]
  if (!identity) {
    throw new ChirpImgError(
      `CHIRP has no driver for the ${image.radioId}, so a .img file would not open in it. ` +
        'Save a boofwang codeplug (.bwp) instead.',
    )
  }

  const metadata: ChirpMetadata = {
    rclass: identity.rclass,
    vendor: identity.vendor,
    model: identity.model,
    variant: '',
    chirp_version: opts.chirpVersion ?? 'boofwang',
    ...(image.radioId === 'uvk5' ? { uvk5_firmware: image.variant } : {}),
  }

  const memory = concat(image.regions)
  const blob = new TextEncoder().encode(JSON.stringify(metadata))
  const b64 = new TextEncoder().encode(toBase64(blob))

  const out = new Uint8Array(memory.length + CHIRP_MAGIC.length + b64.length)
  out.set(memory, 0)
  out.set(CHIRP_MAGIC, memory.length)
  out.set(b64, memory.length + CHIRP_MAGIC.length)
  return out
}

export interface ImgLayout {
  radioId: RadioId
  layout: string
  regions: readonly { start: number; length: number; label: string; readOnly?: boolean }[]
}

/**
 * Turn the memory half of an `.img` into an image.
 *
 * The hash covers the memory only. Hashing the whole file would fold the
 * metadata into it, so the same radio's `.img`, `.bwp` and a fresh read would
 * all disagree - and backup identity is built on that hash.
 */
export async function imgToImage(
  memory: Uint8Array,
  metadata: ChirpMetadata,
  expect: ImgLayout,
): Promise<RadioImage> {
  const total = expect.regions.reduce((n, r) => n + r.length, 0)
  if (memory.length !== total) {
    throw new ChirpImgError(
      `The memory in this file is ${memory.length} bytes; a ${expect.radioId} image is ${total}.`,
    )
  }

  let off = 0
  const regions: ImageRegion[] = expect.regions.map((r) => {
    const slice = memory.slice(off, off + r.length)
    off += r.length
    return { start: r.start, data: slice, label: r.label, readOnly: r.readOnly === true }
  })

  return {
    radioId: expect.radioId,
    // CHIRP's own `variant` is the driver class's, not the firmware, so it is
    // no use here. The UV-K5's real firmware travels separately.
    variant: typeof metadata.uvk5_firmware === 'string' ? metadata.uvk5_firmware : '',
    layout: expect.layout,
    createdAt: new Date().toISOString(),
    regions,
    meta: { importedFrom: 'chirp-img', chirp: metadata },
    sha256: await sha256Hex(memory),
  }
}
