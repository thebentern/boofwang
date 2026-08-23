// SPDX-License-Identifier: GPL-3.0-or-later
import type { Channel } from '../model/channel.js'
import type { Codeplug, ScanList, Zone } from '../model/codeplug.js'
import type { RadioSchema } from './schema.js'
import { programmedOnly, slotRange } from './place.js'

/**
 * Moving channels between memory slots, and everything that points at them.
 *
 * Sorting, compacting and renumbering are one operation with three orderings,
 * and they are in `lib/` rather than in a component because the hard part is
 * not the sort. A channel number is a name that other structures use: zones and
 * scan lists hold absolute channel numbers, and on the DM-32UV so do eight APRS
 * report settings. Moving a channel without rewriting every one of those turns
 * a zone into a list of the wrong frequencies - silently, because the entries
 * are still valid numbers and the radio will happily show them.
 *
 * The rule this module exists to enforce: a renumber rewrites every reference
 * it is able to rewrite, and *reports* every reference it is not. Nothing is
 * left to be discovered on the radio.
 *
 * Three kinds of reference, and they are handled differently:
 *
 * - **Membership** - zone and scan list entries. Rewritten, order preserved.
 * - **Settings** a schema declares with `channelRef`. Rewritten, because those
 *   are encoded and sent.
 * - **Carried values** - a scan list's priority channels, an emergency system's
 *   revert channel, and any of the above pointing at a slot that holds nothing.
 *   These are decoded and never written back, so the number the radio holds is
 *   the number it keeps. Rewriting the document's copy would make it disagree
 *   with the radio it mirrors, which is worse than the problem: it would show a
 *   value that was never sent. They are reported instead, naming the channel
 *   that number will mean afterwards.
 *
 * And one thing that is deliberately dropped rather than moved: a membership
 * entry pointing at a slot that holds no channel. A decoded codeplug can carry
 * one - what the radio does with an in-count entry pointing at a blank record
 * is the question `docs/protocols/dm32uv.md` still has open - and a renumber is
 * exactly the operation that would turn it from a dangling number into a
 * pointer at somebody else's channel. Dropping it is what the encoder already
 * does with it, so this only makes the document say so.
 */

/** How channels are laid out. `slot` keeps the order they are in, closing gaps. */
export type ChannelOrder = 'slot' | 'name' | 'frequency'

export interface RenumberRequest {
  readonly order: ChannelOrder
  /**
   * Whether the radio this document came from can store channel `slot`.
   *
   * Defaults to "every slot in range". It exists for the DM-32UV, whose
   * channel bank is a set of 4 KiB blocks the radio allocates as it needs them:
   * a unit with blocks 0x12-0x14 and 0x18 has no memory at all for channels
   * 255-509, and packing channels into them produces a codeplug the encoder
   * then refuses by name. Skipping those slots leaves a gap where the radio has
   * no memory, which is the honest layout rather than a tidy-looking one.
   */
  readonly usable?: ((slot: number) => boolean) | undefined
}

export interface ChannelMove {
  readonly from: number
  readonly to: number
  readonly name: string
}

/** A channel with nowhere to go, and why. */
export interface UnplacedChannel {
  readonly channel: number
  readonly name: string
  readonly reason: string
}

export interface ListRewrite {
  readonly kind: 'zone' | 'scanList'
  readonly id: string
  readonly name: string
  /** How many of its entries change number. */
  readonly entries: number
}

/** A membership entry pointing at a slot that holds no channel. */
export interface DroppedMember {
  readonly kind: 'zone' | 'scanList'
  readonly id: string
  readonly name: string
  readonly channel: number
}

/**
 * A channel number whose meaning changes and which this build cannot rewrite.
 *
 * Either because the field is carried through from the radio rather than
 * written - scan list priorities, emergency revert channels - or because it
 * points at an empty slot, so there is no channel to follow and no new number
 * to give it.
 */
export interface CarriedReference {
  readonly kind: 'scanList' | 'emergency' | 'setting'
  readonly id: string
  readonly name: string
  /** Which field of it, phrased for a person: "priority channel 1". */
  readonly field: string
  /** The number that stays as it is. */
  readonly channel: number
  /** The channel that number means now, or null when the slot is empty. */
  readonly was: number | null
  /** The channel it will mean afterwards, or null when the slot will be empty. */
  readonly becomes: number | null
}

export interface SettingRewrite {
  readonly key: string
  readonly from: number
  readonly to: number
}

export interface RenumberPlan {
  readonly order: ChannelOrder
  /**
   * Every programmable channel's new number, identities included.
   *
   * Identities matter: a membership entry absent from this map is one pointing
   * at a slot that holds nothing, and telling those two cases apart is the
   * whole reason it is not just the moves.
   */
  readonly mapping: ReadonlyMap<number, number>
  readonly moves: readonly ChannelMove[]
  readonly unplaced: readonly UnplacedChannel[]
  readonly rewritten: readonly ListRewrite[]
  readonly dropped: readonly DroppedMember[]
  readonly carried: readonly CarriedReference[]
  readonly settings: readonly SettingRewrite[]
}

/** Whether applying this plan would change anything at all. */
export function planChangesSomething(plan: RenumberPlan): boolean {
  return plan.moves.length > 0 || plan.dropped.length > 0 || plan.settings.length > 0
}

/**
 * "GMRS 10" after "GMRS 2", and no dependence on ICU.
 *
 * `localeCompare` and `Intl.Collator` both order these the way a person expects
 * and both vary with the ICU build the runtime was compiled against - so the
 * order someone sees could differ between their browser and the test that pins
 * it. Digit runs are compared as numbers and everything else by code unit,
 * which is stable everywhere and is the only property being promised.
 */
export function naturalCompare(a: string, b: string): number {
  const parts = /(\d+)|(\D+)/g
  const left = a.match(parts) ?? []
  const right = b.match(parts) ?? []
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!
    const y = right[i]!
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
      continue
    }
    if (x !== y) return x < y ? -1 : 1
  }
  return left.length - right.length
}

/** The comparator for an ordering. Ties always fall back to the slot a channel is in. */
function comparator(order: ChannelOrder): (a: Channel, b: Channel) => number {
  if (order === 'frequency') {
    return (a, b) => a.rxFreq - b.rxFreq || a.index - b.index
  }
  if (order === 'name') {
    return (a, b) => {
      // An unnamed channel goes last rather than first. Sorting by name puts the
      // named ones in the order somebody asked for; leading the list with a run
      // of blanks is not it.
      const an = a.name.trim()
      const bn = b.name.trim()
      if (!an !== !bn) return an ? -1 : 1
      return naturalCompare(an.toUpperCase(), bn.toUpperCase()) || a.index - b.index
    }
  }
  return (a, b) => a.index - b.index
}

/** The slots a renumber may put a channel in, lowest first. */
function* destinations(schema: RadioSchema, req: RenumberRequest): Generator<number, void> {
  const { first, last, reserved } = slotRange(schema)
  const usable = req.usable
  for (let slot = first; slot <= last; slot++) {
    if (reserved.has(slot)) continue
    if (usable && !usable(slot)) continue
    yield slot
  }
}

/** The setting keys a schema declares as holding a channel number. */
export function channelRefKeys(schema: RadioSchema): string[] {
  const out: string[] = []
  for (const group of schema.settings) {
    for (const field of group.fields) {
      if (field.channelRef) out.push(field.key)
    }
  }
  return out
}

/**
 * Work out where every channel goes, without changing anything.
 *
 * Only channels a person may program are moved. The radio's own pseudo-channels
 * - a UV-K5 carries fourteen band presets at slots 201-214, past the 200 the
 * schema offers - are left exactly where they are and their numbers are never
 * used as destinations, which is `programmedOnly` and `slotRange` doing the
 * same job here that they do for placement.
 */
export function planRenumber(schema: RadioSchema, cp: Codeplug, req: RenumberRequest): RenumberPlan {
  const rows = programmedOnly(schema, cp.channels.values()).sort(comparator(req.order))

  const mapping = new Map<number, number>()
  const moves: ChannelMove[] = []
  const unplaced: UnplacedChannel[] = []

  const slots = destinations(schema, req)
  for (const channel of rows) {
    const next = slots.next()
    if (next.done) {
      unplaced.push({
        channel: channel.index,
        name: channel.name,
        reason: 'this radio has no slot left to put it in',
      })
      continue
    }
    mapping.set(channel.index, next.value)
    if (next.value !== channel.index) moves.push({ from: channel.index, to: next.value, name: channel.name })
  }

  /** Which channel ends up in a slot, so a warning can say what changed under a number. */
  const arriving = new Map<number, number>()
  for (const [from, to] of mapping) arriving.set(to, from)

  const rewritten: ListRewrite[] = []
  const dropped: DroppedMember[] = []
  const survey = (kind: 'zone' | 'scanList', lists: readonly (Zone | ScanList)[]) => {
    for (const list of lists) {
      let entries = 0
      for (const c of list.channels) {
        const to = mapping.get(c)
        if (to === undefined) {
          dropped.push({ kind, id: list.id, name: list.name, channel: c })
          continue
        }
        if (to !== c) entries++
      }
      if (entries > 0) rewritten.push({ kind, id: list.id, name: list.name, entries })
    }
  }
  survey('zone', cp.zones)
  survey('scanList', cp.scanLists)

  const carried: CarriedReference[] = []
  /**
   * Report a number only when what sits under it actually changes.
   *
   * A priority channel pointing at slot 12 is unchanged if channel 12 stays in
   * slot 12, and is equally unchanged if slot 12 is empty before and after -
   * a warning for either would be noise, and a warning nobody reads is worse
   * than none. Compared by channel rather than by name, because two channels
   * can share a name and the point is which record the radio will reach.
   */
  const note = (
    kind: CarriedReference['kind'],
    id: string,
    name: string,
    field: string,
    channel: number | null | undefined,
  ) => {
    if (channel === null || channel === undefined) return
    const was = cp.channels.has(channel) ? channel : null
    const becomes = arriving.get(channel) ?? null
    if (was === becomes) return
    carried.push({ kind, id, name, field, channel, was, becomes })
  }
  for (const list of cp.scanLists) {
    note('scanList', list.id, list.name, 'priority channel 1', list.priority1)
    note('scanList', list.id, list.name, 'priority channel 2', list.priority2)
  }
  for (const system of cp.emergency) {
    note('emergency', system.id, system.name, 'revert channel', system.revertChannel)
  }

  const settings: SettingRewrite[] = []
  for (const key of channelRefKeys(schema)) {
    const raw = cp.settings[key]
    if (typeof raw !== 'number') continue
    const to = mapping.get(raw)
    // A setting pointing at a live channel follows it. One pointing at an empty
    // slot has no channel to follow, so it stays where it is and is reported
    // if a renumbered channel is about to arrive underneath it.
    if (to === undefined) note('setting', key, key, key, raw)
    else if (to !== raw) settings.push({ key, from: raw, to })
  }

  return { order: req.order, mapping, moves, unplaced, rewritten, dropped, carried, settings }
}

/**
 * Whether this plan still describes this codeplug.
 *
 * A plan is made for a preview and applied after somebody agrees to it, and the
 * document can move in between - undo and redo keep working while a dialog is
 * open. The plan is deliberately not rebuilt on the way through, so that what
 * was agreed to is what happens; the cost of that is this check.
 *
 * The invariant is small: every slot a channel is moving *to* must be either
 * empty or the slot some other channel is moving *out of*. A channel that
 * appeared after the plan was made sits in a slot the plan believes is free,
 * and applying it would overwrite that channel with no trace of it anywhere -
 * not in the diff, which only sees the bytes that were written, and not in the
 * history, which would record the overwrite as the thing to undo to.
 */
export function planFitsDocument(cp: Codeplug, plan: RenumberPlan): boolean {
  for (const to of plan.mapping.values()) {
    if (cp.channels.has(to) && !plan.mapping.has(to)) return false
  }
  for (const from of plan.mapping.keys()) {
    if (!cp.channels.has(from)) return false
  }
  return true
}

/** One membership list with its entries renumbered and its dangling ones gone. */
function remap<T extends Zone | ScanList>(list: T, mapping: ReadonlyMap<number, number>): T {
  const channels: number[] = []
  for (const c of list.channels) {
    const to = mapping.get(c)
    if (to !== undefined) channels.push(to)
  }
  return { ...list, channels }
}

/**
 * The codeplug this plan describes. `cp` is not touched.
 *
 * A plan that could not place every channel is refused rather than applied:
 * dropping a channel is not a tidy-up, and leaving it where it is would put it
 * under a slot number something else has just been renumbered onto. The plan
 * carries `unplaced` so a caller can say why before offering the action at all.
 *
 * Channels the plan has no mapping for keep their slot, which is what leaves a
 * radio's own pseudo-channels alone.
 *
 * A plan that no longer fits the document is refused too - see
 * `planFitsDocument` for what that means and why it can happen.
 */
export function applyRenumber(cp: Codeplug, plan: RenumberPlan): Codeplug {
  if (plan.unplaced.length > 0) {
    const names = plan.unplaced.map((u) => u.channel).join(', ')
    throw new Error(`This ordering leaves ${plan.unplaced.length} channel(s) with no slot: ${names}.`)
  }
  if (!planFitsDocument(cp, plan)) {
    throw new Error('The channels changed after this ordering was worked out. Nothing has been moved.')
  }

  const channels = new Map<number, Channel>()
  for (const [slot, channel] of cp.channels) {
    if (!plan.mapping.has(slot)) channels.set(slot, channel)
  }
  for (const [from, to] of plan.mapping) {
    const channel = cp.channels.get(from)
    if (channel) channels.set(to, { ...channel, index: to })
  }

  const settings = { ...cp.settings }
  for (const s of plan.settings) settings[s.key] = s.to

  return {
    ...cp,
    channels,
    zones: cp.zones.map((z) => remap(z, plan.mapping)),
    scanLists: cp.scanLists.map((l) => remap(l, plan.mapping)),
    settings,
  }
}
