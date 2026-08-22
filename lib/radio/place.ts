// SPDX-License-Identifier: GPL-3.0-or-later
import type { Channel } from '../model/channel.js'
import type { RadioSchema } from './schema.js'

/**
 * Where incoming channels go in a radio's memory.
 *
 * This was four lines inside a Vue component and it was wrong in a way nothing
 * could see. `firstFreeSlot` was `Math.max(...usedSlots) + 1` over every key in
 * the decoded document - and a UV-K5 document always carries the radio's own
 * fourteen VFO band presets at slots 201-214, well past the 200 the schema says
 * a user can program. So the first free slot came out as 215, the placement
 * loop's `slot > channelCount` guard fired on its first iteration, and copying
 * a bank onto a UV-K5 placed nothing at all while reporting success.
 *
 * The two lessons are in the shape of this module. Placement is arithmetic over
 * a schema, so it belongs somewhere a test can reach without mounting a
 * component. And "every slot in the document" is never the same set as "slots a
 * person may write to" on a radio that keeps pseudo-channels in the same map.
 */

/** The slots a person may program, as opposed to the ones the radio owns. */
export interface SlotRange {
  /** Lowest programmable slot. */
  readonly first: number
  /** Highest programmable slot, inclusive. */
  readonly last: number
  /** Slots inside the range the radio reserves for itself. */
  readonly reserved: ReadonlySet<number>
}

export function slotRange(schema: RadioSchema): SlotRange {
  const first = schema.memory.firstIndex
  return {
    first,
    // Inclusive, and derived rather than assumed equal to `channelCount`: that
    // identity only holds while `firstIndex` is 1, which is true of all four
    // radios today and is not a thing to build on.
    last: first + schema.memory.channelCount - 1,
    reserved: new Set(schema.memory.specialChannels.map((s) => s.index)),
  }
}

/** Whether a slot is one the radio keeps for itself. */
export function isReservedSlot(schema: RadioSchema, slot: number): boolean {
  return slotRange(schema).reserved.has(slot)
}

/**
 * The channels a person actually programmed, with the radio's own out.
 *
 * Needed on both sides of a copy. As a destination, a reserved slot must never
 * be written. As a *source* it is worse than useless: a UV-K5's fourteen band
 * presets would arrive as if they were real channels, and the ones that happen
 * to sit in a band the target covers copy silently as duplicate A/B pairs while
 * the out-of-band ones are refused - which reads like the clamp pipeline
 * working rather than like junk going in.
 */
export function programmedOnly<T extends { readonly index: number }>(
  schema: RadioSchema,
  channels: Iterable<T>,
): T[] {
  const { first, last, reserved } = slotRange(schema)
  return [...channels].filter((c) => c.index >= first && c.index <= last && !reserved.has(c.index))
}

export interface Placement {
  readonly slot: number
  readonly channel: Channel
}

export interface PlacementPlan {
  /** What fits, in slot order. */
  readonly placed: readonly Placement[]
  /** What did not, in the order it was offered. */
  readonly unplaced: readonly Channel[]
}

/**
 * Plan where a run of channels lands, without writing anything.
 *
 * Placement appends after the highest slot already programmed and never writes
 * over an occupied one - the behaviour the original comment promised. It does
 * not fill earlier gaps, which is a choice rather than an oversight: someone
 * who has channels at 1-10 and 190-200 is describing a layout, and quietly
 * threading new channels through the holes in it is not what "copy these
 * across" asks for. Occupied slots encountered on the way up are still stepped
 * over, so a plan is safe even if the caller passes a sparse set.
 *
 * `occupied` should be every key in the destination document, reserved slots
 * included. Filtering them out here rather than at the call site is the whole
 * point: the caller cannot forget.
 */
export function planPlacement(
  schema: RadioSchema,
  occupied: Iterable<number>,
  rows: readonly Channel[],
): PlacementPlan {
  const { first, last, reserved } = slotRange(schema)
  const taken = new Set(occupied)

  // Start after the highest *programmable* slot in use. Reserved slots are not
  // considered, which is the fix: they sit above the programmable range on the
  // UV-K5 and dragged the start past the end of memory.
  let slot = first
  for (const s of taken) {
    if (s >= first && s <= last && !reserved.has(s)) slot = Math.max(slot, s + 1)
  }

  const placed: Placement[] = []
  const unplaced: Channel[] = []

  for (const channel of rows) {
    while (slot <= last && (taken.has(slot) || reserved.has(slot))) slot++
    if (slot > last) {
      unplaced.push(channel)
      continue
    }
    placed.push({ slot, channel: { ...channel, index: slot } })
    taken.add(slot)
    slot++
  }

  return { placed, unplaced }
}

/**
 * The first slot `planPlacement` would use, for a dialog that wants to say so
 * before anyone commits. Null when the radio is full.
 */
export function firstFreeSlot(schema: RadioSchema, occupied: Iterable<number>): number | null {
  const { last } = slotRange(schema)
  const plan = planPlacement(schema, occupied, [PROBE])
  const at = plan.placed[0]?.slot ?? null
  return at !== null && at <= last ? at : null
}

/** A stand-in row for `firstFreeSlot`, which only ever reads the slot back. */
const PROBE = { index: 0 } as unknown as Channel
