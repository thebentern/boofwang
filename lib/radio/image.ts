// SPDX-License-Identifier: GPL-3.0-or-later
import { equalBytes } from '../codec/struct.js'
import type { RadioId } from '../model/index.js'

/**
 * A contiguous span of radio memory in *logical* address space.
 *
 * Logical, not physical, because the three radios disagree about what an
 * address means. The UV-K5 reads 0x2000 but may only write the first 0x1D00;
 * the UV-5R Mini's image is three disjoint ranges concatenated; the DM-32UV
 * assigns physical addresses through a flash translation layer that moves them
 * between reads, so its pages are addressed by logical block id instead. One
 * region list covers all three.
 */
export interface ImageRegion {
  readonly start: number
  readonly data: Uint8Array
  /**
   * Never included in a write. The UV-K5's calibration block is marked this
   * way, which makes excluding it a property of the data rather than a code
   * path someone can forget.
   */
  readonly readOnly?: boolean
  readonly label: string
}

export interface RadioImage {
  readonly radioId: RadioId
  /** Firmware or model string captured at read time; a write refuses on mismatch. */
  readonly variant: string
  /** Which memory layout applies - 'stock', 'egzumer', and so on. */
  readonly layout: string
  readonly createdAt: string
  readonly regions: readonly ImageRegion[]
  readonly meta: Readonly<Record<string, unknown>>
  /** SHA-256 over the regions, for backup identity and diffing. */
  readonly sha256: string
}

export function totalBytes(image: RadioImage): number {
  return image.regions.reduce((n, r) => n + r.data.length, 0)
}

export function regionAt(image: RadioImage, start: number): ImageRegion | null {
  return image.regions.find((r) => r.start === start) ?? null
}

/** The region containing `addr`, plus the offset within it. */
export function locate(image: RadioImage, addr: number): { region: ImageRegion; offset: number } | null {
  for (const region of image.regions) {
    if (addr >= region.start && addr < region.start + region.data.length) {
      return { region, offset: addr - region.start }
    }
  }
  return null
}

/** A deep copy, so an edit cannot reach back into the original. */
export function cloneImage(image: RadioImage): RadioImage {
  return {
    ...image,
    regions: image.regions.map((r) => ({ ...r, data: r.data.slice() })),
  }
}

export function imagesEqual(a: RadioImage, b: RadioImage): boolean {
  if (a.regions.length !== b.regions.length) return false
  for (let i = 0; i < a.regions.length; i++) {
    const ra = a.regions[i]!
    const rb = b.regions[i]!
    if (ra.start !== rb.start || !equalBytes(ra.data, rb.data)) return false
  }
  return true
}

/** Concatenation of every region, for a raw `.bin` export. */
export function flatten(image: RadioImage): Uint8Array {
  const out = new Uint8Array(totalBytes(image))
  let off = 0
  for (const r of image.regions) {
    out.set(r.data, off)
    off += r.data.length
  }
  return out
}
