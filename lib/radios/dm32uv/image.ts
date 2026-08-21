// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImageRegion, RadioImage } from '../../radio/image.js'
import { PAGE_SIZE } from './protocol.js'

/**
 * Addressing a DM-32UV image.
 *
 * Physical addresses move between sessions, so a page is stored under its
 * **logical block id** and nothing else. A region's `start` is `id << 12`,
 * which gives every block a stable, sortable address that survives the
 * translation layer relocating the page underneath it.
 */

export const logicalAddress = (blockId: number) => blockId << 12
export const blockIdOf = (start: number) => start >>> 12

export function blockRegion(image: RadioImage, blockId: number): ImageRegion | null {
  return image.regions.find((r) => r.start === logicalAddress(blockId)) ?? null
}

export function blockData(image: RadioImage, blockId: number): Uint8Array | null {
  return blockRegion(image, blockId)?.data ?? null
}

/** Allocated block ids, ascending. */
export function blockIds(image: RadioImage): number[] {
  return image.regions.map((r) => blockIdOf(r.start)).sort((a, b) => a - b)
}

/** Where each block physically lived when it was read. Diagnostics only. */
export interface PhysicalPlacement {
  readonly blockId: number
  readonly physical: number
}

export function placements(image: RadioImage): PhysicalPlacement[] {
  const raw = (image.meta as { placements?: PhysicalPlacement[] }).placements
  return raw ?? []
}

export function totalPages(image: RadioImage): number {
  return image.regions.length
}

export function totalBytes(image: RadioImage): number {
  return image.regions.length * PAGE_SIZE
}

/**
 * The pages of the DMR address book, ascending.
 *
 * Found from the regions themselves rather than from `image.meta`, which is not
 * carried by a stored backup and not carried by a `.bwp`. A config page is
 * addressed as `blockId << 12` and so always sits below 0x100000; the address
 * book is at a real physical address an order of magnitude higher. Nothing else
 * in a DM-32UV image is up there.
 *
 * Doing it this way means an image that has been round-tripped through a backup
 * still knows where its contacts are, which the meta-based version did not.
 */
export function contactPages(image: RadioImage): ImageRegion[] {
  return image.regions.filter((r) => blockIdOf(r.start) > 0xff).sort((a, b) => a.start - b.start)
}

/** Where the address book starts, or null if this image carries none. */
export function contactsBase(image: RadioImage): number | null {
  return contactPages(image)[0]?.start ?? null
}
