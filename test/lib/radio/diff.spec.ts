// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { diffImages, type DiffDriver } from '#core/radio/diff.js'
import type { ImageRegion, RadioImage } from '#core/radio/image.js'

function image(regions: ImageRegion[]): RadioImage {
  return {
    radioId: 'uvk5',
    variant: 'test',
    layout: 'stock',
    createdAt: '2026-08-20T00:00:00.000Z',
    regions,
    meta: {},
    sha256: '',
  }
}

function region(start: number, data: number[], readOnly?: boolean): ImageRegion {
  return { start, data: Uint8Array.from(data), label: `r${start}`, ...(readOnly ? { readOnly } : {}) }
}

/** Owns everything, writes in 16-byte blocks. */
const driver: DiffDriver = { ownedRanges: () => [[0, 0x10000]], writeBlockBytes: 16 }

describe('diffImages', () => {
  it('reports nothing when the images match', () => {
    const a = image([region(0, [1, 2, 3, 4])])
    const b = image([region(0, [1, 2, 3, 4])])
    expect(diffImages(a, b, driver)).toEqual({ ranges: [], unowned: [], changedBytes: 0, changedBlocks: [] })
  })

  it('counts the write-sized block a change falls in, not the byte', () => {
    // One byte at offset 17 is inside the second 16-byte block.
    const base = image([region(0, new Array(48).fill(0))])
    const next = image([region(0, new Array(48).fill(0).map((v, i) => (i === 17 ? 9 : v)))])
    const d = diffImages(base, next, driver)
    expect(d.changedBytes).toBe(1)
    expect(d.changedBlocks).toEqual([16])
  })

  it('counts every block a change spans', () => {
    const base = image([region(0, new Array(64).fill(0))])
    const next = image([region(0, new Array(64).fill(0).map((v, i) => (i >= 14 && i < 34 ? 9 : v)))])
    const d = diffImages(base, next, driver)
    expect(d.changedBytes).toBe(20)
    expect(d.changedBlocks).toEqual([0, 16, 32])
  })

  it('offsets block addresses by the region start', () => {
    const base = image([region(0x1000, new Array(32).fill(0))])
    const next = image([region(0x1000, new Array(32).fill(0).map((v, i) => (i === 20 ? 9 : v)))])
    expect(diffImages(base, next, driver).changedBlocks).toEqual([0x1010])
  })

  it('walks every region, not just the first', () => {
    // The regression this guards: a DM-32UV image has 59 regions and the edit
    // is rarely in the first one.
    const base = image([region(0, [0, 0]), region(0x100, [0, 0]), region(0x200, [0, 0])])
    const next = image([region(0, [0, 0]), region(0x100, [0, 0]), region(0x200, [0, 7])])
    const d = diffImages(base, next, driver)
    expect(d.changedBytes).toBe(1)
    expect(d.changedBlocks).toEqual([0x200])
  })

  it('flags a change the driver does not claim to own', () => {
    const narrow: DiffDriver = { ownedRanges: () => [[0, 4]], writeBlockBytes: 16 }
    const base = image([region(0, new Array(16).fill(0))])
    const next = image([region(0, new Array(16).fill(0).map((v, i) => (i === 8 ? 1 : v)))])
    const d = diffImages(base, next, narrow)
    expect(d.unowned).toEqual([[8, 9]])
  })

  it('treats a change in a read-only region as a defect, and never as bytes to send', () => {
    // Calibration is read-only. If the encoder touched it, the gate must block
    // rather than the dialog offering to send it.
    const base = image([region(0, new Array(16).fill(0), true)])
    const next = image([region(0, new Array(16).fill(0).map((v, i) => (i === 2 ? 5 : v)), true)])
    const d = diffImages(base, next, driver)
    expect(d.unowned).toEqual([[2, 3]])
    expect(d.changedBytes).toBe(0)
    expect(d.changedBlocks).toEqual([])
  })

  it('ignores a region that has no counterpart or changed size', () => {
    const base = image([region(0, [0, 0])])
    const next = image([region(0, [0, 0, 0]), region(0x50, [1])])
    expect(diffImages(base, next, driver).changedBytes).toBe(0)
  })
})
