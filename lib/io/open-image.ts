// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256Hex } from '../codec/checksum.js'
import type { RadioId } from '../model/codeplug.js'
import type { ImageRegion, RadioImage } from '../radio/image.js'
import { isImplemented } from '../radio/registry.js'
import { decodeBwp, looksLikeBwp, peekBwpHeader } from './bwp.js'
import { imgToImage, looksLikeChirpImg, splitChirpImg, type ChirpMetadata } from './chirp-img.js'
import { REGIONS as UVK5_REGIONS, regionsFor } from '../radios/uvk5/layout.js'
import { classifyFirmware } from '../radios/uvk5/variants.js'
import { REGIONS as UV82_REGIONS } from '../radios/uv82/layout.js'
import { VARIANTS as UV5R_VARIANTS } from '../radios/uv5rmini/protocol.js'
import { PAGE_SIZE, PAGE_TAIL } from '../radios/dm32uv/protocol.js'
import { logicalAddress } from '../radios/dm32uv/image.js'

export class OpenImageError extends Error {
  override readonly name = 'OpenImageError'
}

export interface RawLayout {
  radioId: RadioId
  layout: string
  regions: readonly { start: number; length: number; label: string; readOnly?: boolean }[]
}

/**
 * Every fixed-size raw layout boofwang can recognise from a file's length alone.
 *
 * A bare `.bin` carries no identity, so its size is the only clue. Every entry
 * here has a distinct total, which is what makes the guess safe; the DM-32UV is
 * handled separately because its pages say what they are.
 */
export const RAW_LAYOUTS: readonly RawLayout[] = [
  { radioId: 'uvk5', layout: 'stock', regions: UVK5_REGIONS },
  { radioId: 'uv82', layout: 'uv82', regions: UV82_REGIONS },
  ...UV5R_VARIANTS.map((v) => ({
    radioId: 'uv5rmini' as const,
    layout: v.id,
    regions: v.regions.map((r) => ({ start: r.start, length: r.size, label: r.label })),
  })),
]

const totalOf = (l: RawLayout) => l.regions.reduce((n, r) => n + r.length, 0)

/**
 * The UV-K5 layout a CHIRP `.img` is really in, when its metadata says.
 *
 * Stock and egzumer images are both 8,192 bytes, so the size lookup cannot
 * separate them - and reading one as the other puts the calibration boundary
 * 256 bytes out and decodes a third of the settings window as something else
 * entirely. CHIRP records the radio's hello string in `uvk5_firmware`, which is
 * the same string the handshake would have produced, so classifying it here
 * gives an imported file the same layout a direct read would have given it.
 *
 * Null for anything else, including a firmware string this build does not
 * recognise: guessing a layout from an unknown firmware is exactly what the
 * variant table exists to refuse.
 */
function uvk5LayoutFor(metadata: ChirpMetadata): RawLayout | null {
  const firmware = metadata.uvk5_firmware
  if (typeof firmware !== 'string' || firmware === '') return null
  const variant = classifyFirmware(firmware)
  if (variant.layout === 'unknown') return null
  return {
    radioId: 'uvk5',
    layout: variant.layout,
    regions: regionsFor(variant.calStart),
  }
}

/**
 * Whether a buffer looks like a flat dump of DM-32UV pages.
 *
 * This radio has no fixed region table - its pages are discovered by scanning -
 * so a size lookup cannot work. It does not need to: every 4 KiB page carries
 * its own logical block id in its last byte, which makes the file
 * self-describing. Requiring the ids to be unique is what stops an unrelated
 * file of the right length being read as one.
 */
export function looksLikeDm32Bin(data: Uint8Array): boolean {
  if (data.length === 0 || data.length % PAGE_SIZE !== 0) return false
  const pages = data.length / PAGE_SIZE
  if (pages < 2) return false
  const seen = new Set<number>()
  for (let i = 0; i < pages; i++) {
    const id = data[i * PAGE_SIZE + PAGE_TAIL]!
    if (id === 0xff || seen.has(id)) return false
    seen.add(id)
  }
  return true
}

export async function dm32BinToImage(data: Uint8Array): Promise<RadioImage> {
  const pages = data.length / PAGE_SIZE
  const regions: ImageRegion[] = []
  for (let i = 0; i < pages; i++) {
    const page = data.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE)
    const id = page[PAGE_TAIL]!
    regions.push({
      start: logicalAddress(id),
      data: page,
      readOnly: id === 0x02,
      label: `block 0x${id.toString(16)}`,
    })
  }
  // Ascending logical block id, which is the order a read produces and
  // therefore the order that flattens back to the same file.
  regions.sort((a, b) => a.start - b.start)
  return {
    radioId: 'dm32uv',
    variant: '',
    layout: 'DP570UV',
    createdAt: new Date().toISOString(),
    regions,
    meta: { importedFrom: 'raw-bin' },
    sha256: await sha256Hex(data),
  }
}

export interface OpenedImage {
  readonly image: RadioImage
  /** What the user should be told about how this file was interpreted. */
  readonly note:
    | { kind: 'bwp' }
    | { kind: 'chirp-img'; metadata: ChirpMetadata }
    | { kind: 'raw'; guessedFrom: 'size' | 'page-ids' }
}

/**
 * Open any codeplug file boofwang understands.
 *
 * Order matters: the containers that say what they are come first, and the
 * size guess is the last resort. Kept out of the component so the format
 * handling can be tested without a browser.
 */
export async function openImageFile(bytes: Uint8Array): Promise<OpenedImage> {
  if (looksLikeBwp(bytes)) {
    const header = peekBwpHeader(bytes)
    if (!header) throw new OpenImageError('This .bwp file is damaged: its header will not parse.')
    if (!isImplemented(header.radioId)) {
      throw new OpenImageError(
        `This codeplug is for a ${header.radioId}, which boofwang cannot decode yet.`,
      )
    }
    return { image: await decodeBwp(bytes), note: { kind: 'bwp' } }
  }

  if (looksLikeChirpImg(bytes)) {
    const { memory, metadata } = splitChirpImg(bytes)
    const layout = uvk5LayoutFor(metadata) ?? RAW_LAYOUTS.find((l) => totalOf(l) === memory.length)
    if (!layout) {
      const model = [metadata.vendor, metadata.model].filter(Boolean).join(' ')
      throw new OpenImageError(
        `This is a CHIRP image${model ? ` for a ${model}` : ''}, but its ${memory.length.toLocaleString()} ` +
          'bytes of memory do not match any radio boofwang supports.',
      )
    }
    if (!isImplemented(layout.radioId)) {
      throw new OpenImageError(
        `This is a CHIRP image for a ${layout.radioId}, which boofwang cannot decode yet.`,
      )
    }
    return {
      image: await imgToImage(memory, metadata, layout),
      note: { kind: 'chirp-img', metadata },
    }
  }

  if (looksLikeDm32Bin(bytes)) {
    return { image: await dm32BinToImage(bytes), note: { kind: 'raw', guessedFrom: 'page-ids' } }
  }

  const layout = RAW_LAYOUTS.find((l) => totalOf(l) === bytes.length)
  if (!layout) {
    throw new OpenImageError(
      `This file is ${bytes.length.toLocaleString()} bytes, which does not match any radio boofwang ` +
        'supports. If it is a codeplug, open the .bwp or CHIRP .img instead: a bare .bin cannot say ' +
        'which radio it came from.',
    )
  }
  if (!isImplemented(layout.radioId)) {
    throw new OpenImageError(`This looks like a ${layout.radioId} image, which boofwang cannot decode yet.`)
  }

  let off = 0
  const regions: ImageRegion[] = layout.regions.map((r) => {
    const slice = bytes.slice(off, off + r.length)
    off += r.length
    return { start: r.start, data: slice, label: r.label, readOnly: r.readOnly === true }
  })

  return {
    image: {
      radioId: layout.radioId,
      variant: '',
      layout: layout.layout,
      createdAt: new Date().toISOString(),
      regions,
      meta: { importedFrom: 'raw-bin' },
      sha256: await sha256Hex(bytes),
    },
    note: { kind: 'raw', guessedFrom: 'size' },
  }
}
