// SPDX-License-Identifier: GPL-3.0-or-later
import type { RadioImage } from './image.js'
import { diffRanges, rangesContain } from '../codec/struct.js'

/**
 * What a write would change, and how much of it goes down the wire.
 *
 * Kept out of the store so it can be tested without a browser, and so the
 * numbers the confirmation dialog shows are the same numbers the write gate
 * decides on.
 */
export interface ImageDiff {
  /** Every changed byte range, as `[start, end)` offsets within a region. */
  readonly ranges: readonly (readonly [number, number])[]
  /**
   * Changed ranges the driver does not claim to understand.
   *
   * Never a warning. A byte changing outside `ownedRanges()` means the encoder
   * wrote somewhere it has no model for, which is a defect in boofwang, and the
   * write gate blocks on it.
   */
  readonly unowned: readonly (readonly [number, number])[]
  readonly changedBytes: number
  /** Absolute addresses of the write-sized blocks that contain a change. */
  readonly changedBlocks: readonly number[]
}

export interface DiffDriver {
  ownedRanges(regionStart: number): ReadonlyArray<readonly [number, number]>
  readonly writeBlockBytes: number
}

/**
 * Compare an encoded image against the one that was read.
 *
 * Walks every region rather than the first writable one. A UV-K5 image has a
 * single region so either approach works; a DM-32UV image has 59, and looking
 * only at the first diffs a block the encoder never touches - reporting no
 * change for an edit that is real, and leaving the unowned-bytes safeguard
 * unreachable.
 */
export function diffImages(base: RadioImage, next: RadioImage, driver: DiffDriver): ImageDiff {
  const ranges: (readonly [number, number])[] = []
  const unowned: (readonly [number, number])[] = []
  const blocks = new Set<number>()
  let changedBytes = 0

  for (const region of next.regions) {
    const before = base.regions.find((r) => r.start === region.start)
    // A region with no counterpart, or one that changed size, cannot be diffed
    // byte against byte. The image-identity checks upstream reject that case;
    // there is nothing useful to report here.
    if (!before || before.data.length !== region.data.length) continue

    const changed = diffRanges(before.data, region.data)
    if (changed.length === 0) continue

    // A read-only region is never sent, so a difference in one is not a pending
    // write - it is the encoder having written somewhere it promised not to.
    // Report it as unowned so the gate blocks, and keep it out of the counts,
    // which describe what would go down the wire.
    if (region.readOnly) {
      for (const r of changed) {
        ranges.push(r)
        unowned.push(r)
      }
      continue
    }

    const owned = driver.ownedRanges(region.start)
    for (const r of changed) {
      ranges.push(r)
      if (!rangesContain(owned, r)) unowned.push(r)
      changedBytes += r[1] - r[0]
    }

    // Count the units this radio is actually written in. One changed byte is a
    // 128-byte block on a UV-K5 and a whole 4 KiB page on a DM-32UV, and a
    // count of "blocks" means nothing without that.
    const unit = driver.writeBlockBytes
    for (const [from, to] of changed) {
      for (let a = Math.floor(from / unit) * unit; a < to; a += unit) blocks.add(region.start + a)
    }
  }

  return {
    ranges,
    unowned,
    changedBytes,
    changedBlocks: [...blocks].sort((a, b) => a - b),
  }
}
