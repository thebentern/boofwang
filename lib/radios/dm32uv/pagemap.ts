// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReadOpts, Transport } from '../../transport/transport.js'
import { PAGE_SIZE, PAGE_TAIL, readMemory } from './protocol.js'

/**
 * The flash translation layer.
 *
 * This radio does not put a given piece of its codeplug at a fixed address. The
 * last byte of each 4 KiB page holds a **logical block id**, and the mapping
 * from id to physical address differs between radios and moves as the codeplug
 * is edited. Verified on hardware: on the test unit logical block 0x07 sits at
 * 0x001000 while 0x02 is away at 0x0AA000, in no order at all.
 *
 * So the map is discovered by probing all 200 page tails, every session, and
 * nothing addresses memory any other way.
 */

/** A page that has been superseded; its content is stale. */
export const TAIL_SUPERSEDED = 0x00
/** A page that has never been allocated. */
export const TAIL_FREE = 0xff

export interface PageMap {
  /** logical block id -> physical page base. */
  readonly physOf: ReadonlyMap<number, number>
  /** physical page base -> logical block id. */
  readonly logicalOf: ReadonlyMap<number, number>
  /** Every tail byte read, kept for diagnostics. */
  readonly tails: ReadonlyMap<number, number>
  readonly free: readonly number[]
  readonly superseded: readonly number[]
  readonly regionStart: number
  readonly regionEnd: number
}

export function isAllocated(tail: number): boolean {
  return tail !== TAIL_FREE && tail !== TAIL_SUPERSEDED
}

/**
 * Probe every page tail in the configuration region.
 *
 * 200 single-byte reads. Slower than assuming, and the only correct option:
 * a hardcoded address table would be wrong on the next radio, and silently
 * wrong on this one after the user edits anything from the keypad.
 */
export async function scanPageMap(
  t: Transport,
  regionStart: number,
  regionEnd: number,
  opts?: ReadOpts & { progress?: (done: number, total: number) => void },
): Promise<PageMap> {
  const pages = Math.floor((regionEnd - regionStart + 1) / PAGE_SIZE)
  const tails = new Map<number, number>()
  const physOf = new Map<number, number>()
  const logicalOf = new Map<number, number>()
  const free: number[] = []
  const superseded: number[] = []

  for (let i = 0; i < pages; i++) {
    opts?.signal?.throwIfAborted()
    const base = regionStart + i * PAGE_SIZE
    const byte = (await readMemory(t, base + PAGE_TAIL, 1, opts))[0]!
    tails.set(base, byte)

    if (byte === TAIL_FREE) free.push(base)
    else if (byte === TAIL_SUPERSEDED) superseded.push(base)
    else {
      // Every allocated id occurs exactly once across the region. Two pages
      // claiming the same id means the map was read mid-move, and picking
      // either would be a guess.
      const existing = physOf.get(byte)
      if (existing !== undefined) {
        throw new Error(
          `The radio reports logical block 0x${byte.toString(16)} at two addresses ` +
            `(0x${existing.toString(16)} and 0x${base.toString(16)}). Read it again.`,
        )
      }
      physOf.set(byte, base)
      logicalOf.set(base, byte)
    }
    opts?.progress?.(i + 1, pages)
  }

  return { physOf, logicalOf, tails, free, superseded, regionStart, regionEnd }
}

/**
 * Logical block ids whose meaning the specification documents.
 *
 * Everything absent from this table is read, stored and preserved byte for byte
 * but never interpreted - 22 of the 59 allocated blocks on the test radio.
 */
function buildBlockMeanings(): Record<number, string> {
  const m: Record<number, string> = {
    0x02: 'calibration',
    0x04: 'radio settings',
    0x06: 'analog and DTMF configuration',
    0x0a: 'quick text messages',
    0x0b: 'talk-group index tables',
    0x0f: 'RX group lists',
    0x10: 'emergency settings and encryption keys',
    0x11: 'scan lists',
    0x67: 'DMR radio ID list',
  }
  for (let id = 0x12; id <= 0x41; id++) m[id] ??= 'channel bank'
  for (let id = 0x42; id <= 0x43; id++) m[id] ??= 'per-channel transmit contact index'
  for (let id = 0x44; id <= 0x48; id++) m[id] ??= 'talk groups'
  for (let id = 0x5c; id <= 0x64; id++) m[id] ??= 'zones'
  for (let id = 0x65; id <= 0x66; id++) m[id] ??= 'roaming'
  return m
}

export const BLOCK_MEANING: Readonly<Record<number, string>> = buildBlockMeanings()

export function describeBlock(id: number): string {
  return BLOCK_MEANING[id] ?? 'not documented'
}

/** Blocks that must never be written, whatever else is unlocked. */
export const NEVER_WRITE: ReadonlySet<number> = new Set([0x02])
