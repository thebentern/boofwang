// SPDX-License-Identifier: GPL-3.0-or-later
import type { Field } from './fields.js'

/**
 * A declarative binary record with **explicit** offsets.
 *
 * Offsets are written out rather than inferred from declaration order, for two
 * reasons. Protocol specs are written that way, so transcription stays a
 * one-to-one copy; and gaps stay visible instead of being silently absorbed by
 * implicit packing. `coverage()` then reports exactly which bytes of a record we
 * claim to understand - the number that matters most for the DM-32UV, where
 * roughly 31 of 71 memory pages are undocumented.
 *
 * The central guarantee: `write()` applies a *partial* patch and touches only
 * the bytes its fields own, so a record can be edited without disturbing bytes
 * this codebase has never decoded. Combined with `driver.encode(doc, base)`
 * always starting from the bytes read off the radio, unknown data survives a
 * read/edit/write cycle untouched.
 */

export interface Slot<T, TSet = T> {
  readonly offset: number
  readonly field: Field<T, TSet>
}

/** Place a field at an absolute offset within the record. */
export function at<T, TSet>(offset: number, field: Field<T, TSet>): Slot<T, TSet> {
  return { offset, field }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Layout = Record<string, Slot<any, any>>

/** What `read` gives back: every field, fully decoded. */
export type Plain<S extends Layout> = {
  -readonly [K in keyof S]: S[K] extends Slot<infer T, unknown> ? T : never
}

/**
 * What `write` accepts: every field optional, and bit fields narrowed to their
 * partial form. `Plain<S>` is assignable to this, so `write(buf, 0, read(buf))`
 * typechecks - which is exactly the round-trip the invariant test exercises.
 */
export type Patch<S extends Layout> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  -readonly [K in keyof S]?: (S[K] extends Slot<any, infer TSet> ? TSet : never) | undefined
}

export interface Gap {
  readonly start: number
  readonly end: number
}

export interface Coverage {
  /** Bytes claimed by at least one field. */
  readonly named: number
  readonly total: number
  /** Byte ranges no field claims, as `[start, end)`. */
  readonly gaps: readonly Gap[]
  /** `named / total`, 0..1. */
  readonly ratio: number
}

export interface StructDef<S extends Layout> {
  readonly size: number
  readonly layout: S
  /** Decode the whole record. */
  read(buf: Uint8Array, off?: number): Plain<S>
  /** Apply only the keys present in `patch`. Bytes outside those fields are untouched. */
  write(buf: Uint8Array, off: number, patch: Patch<S>): void
  /** A live accessor: property reads and writes hit the buffer directly. */
  view(buf: Uint8Array, off?: number): Plain<S>
  /** Merged, sorted `[start, end)` ranges this record owns, relative to its start. */
  ranges(): readonly (readonly [number, number])[]
  coverage(): Coverage
  /** A fresh record filled with `fill` (an erased slot), not an implicit zero buffer. */
  blank(fill: number): Uint8Array
}

function mergeRanges(input: (readonly [number, number])[]): (readonly [number, number])[] {
  if (input.length === 0) return []
  const sorted = [...input].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: [number, number][] = [[sorted[0]![0], sorted[0]![1]]]
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!
    const last = out[out.length - 1]!
    if (s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/**
 * Define a record. Overlapping or out-of-bounds fields throw here, at module
 * load, so a bad offset table fails on the first test that imports it rather
 * than halfway through writing to a radio.
 */
export function defineStruct<const S extends Layout>(size: number, layout: S): StructDef<S> {
  const entries = Object.entries(layout) as [keyof S & string, Slot<unknown, unknown>][]

  const owner = new Array<string | undefined>(size)
  for (const [name, slot] of entries) {
    const { offset, field } = slot
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(`defineStruct: ${name} has a non-integer or negative offset ${offset}`)
    }
    if (offset + field.size > size) {
      throw new RangeError(
        `defineStruct: ${name} spans [${offset}, ${offset + field.size}) which exceeds the record size ${size}`,
      )
    }
    for (let b = offset; b < offset + field.size; b++) {
      if (owner[b] !== undefined) {
        throw new RangeError(`defineStruct: ${name} overlaps ${owner[b]} at byte 0x${b.toString(16)}`)
      }
      owner[b] = name
    }
  }

  const rangeList = mergeRanges(entries.map(([, s]) => [s.offset, s.offset + s.field.size] as const))

  const gaps: Gap[] = []
  let cursor = 0
  for (const [s, e] of rangeList) {
    if (s > cursor) gaps.push({ start: cursor, end: s })
    cursor = e
  }
  if (cursor < size) gaps.push({ start: cursor, end: size })

  const named = rangeList.reduce((n, [s, e]) => n + (e - s), 0)

  return {
    size,
    layout,

    read(buf, off = 0) {
      const out = {} as Plain<S>
      for (const [name, slot] of entries) {
        ;(out as Record<string, unknown>)[name] = slot.field.get(buf, off + slot.offset)
      }
      return out
    },

    write(buf, off, patch) {
      for (const [name, slot] of entries) {
        if (!Object.hasOwn(patch, name)) continue
        const v = (patch as Record<string, unknown>)[name]
        if (v === undefined) continue
        slot.field.set(buf, off + slot.offset, v)
      }
    },

    view(buf, off = 0) {
      const target = {} as Plain<S>
      for (const [name, slot] of entries) {
        Object.defineProperty(target, name, {
          enumerable: true,
          configurable: false,
          get: () => slot.field.get(buf, off + slot.offset),
          set: (v: unknown) => slot.field.set(buf, off + slot.offset, v),
        })
      }
      return target
    },

    ranges: () => rangeList,

    coverage: () => ({ named, total: size, gaps, ratio: size === 0 ? 1 : named / size }),

    blank(fill) {
      const b = new Uint8Array(size)
      b.fill(fill)
      return b
    },
  }
}

/**
 * Copy only `ranges` from `src` onto `dst`, both taken from `base`.
 *
 * This is the read-modify-write primitive behind every upload: the live bytes
 * from the radio are the base, and only the ranges a driver declares it
 * understands are overwritten. Even if our in-memory image is stale in bytes we
 * never modelled, those bytes are carried through from the device.
 */
export function applyRanges(
  dst: Uint8Array,
  src: Uint8Array,
  ranges: readonly (readonly [number, number])[],
  offset = 0,
): void {
  for (const [s, e] of ranges) {
    const start = offset + s
    const end = offset + e
    if (start < 0 || end > dst.length || end > src.length) {
      throw new RangeError(`applyRanges: [${start}, ${end}) out of bounds`)
    }
    dst.set(src.subarray(start, end), start)
  }
}

/** Byte ranges where two equal-length buffers differ, as `[start, end)`. */
export function diffRanges(a: Uint8Array, b: Uint8Array): (readonly [number, number])[] {
  if (a.length !== b.length) throw new RangeError(`diffRanges: length ${a.length} vs ${b.length}`)
  const out: (readonly [number, number])[] = []
  let start = -1
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (start < 0) start = i
    } else if (start >= 0) {
      out.push([start, i])
      start = -1
    }
  }
  if (start >= 0) out.push([start, a.length])
  return out
}

/** True when every byte of `probe` lies inside one of `ranges`. */
export function rangesContain(ranges: readonly (readonly [number, number])[], probe: readonly [number, number]): boolean {
  for (const [s, e] of ranges) {
    if (probe[0] >= s && probe[1] <= e) return true
  }
  return false
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
