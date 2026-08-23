// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ctcss } from '#core/model/tones.js'
import { hz, mW } from '#core/model/units.js'
import { bulkPatch, type BulkChange } from '#core/radio/bulk-edit.js'
import { createUv5rMiniDriver } from '#core/radios/uv5rmini/driver.js'
import { VARIANTS } from '#core/radios/uv5rmini/protocol.js'
import type { RadioImage } from '#core/radio/image.js'
import { useCodeplugStore } from '~/stores/codeplug'

/**
 * A bulk edit as the table actually performs it: through the store.
 *
 * `bulk-edit.spec.ts` in the core proves the patch is right for one channel.
 * What it cannot see is the part that only exists once the patches are applied
 * together - that forty of them are one thing in the history, and that the
 * slots nobody ticked come out the other side untouched. Both of those were the
 * point of doing this in a transaction, and both fail silently: an edit that
 * costs forty undo steps still looks correct in the table, and a slot that was
 * changed by accident looks correct too, until it is written to a radio.
 *
 * A real driver over a blank image, the same as the undo tests, so a patch that
 * produces a channel the decoder would never emit cannot pass unnoticed.
 */
const variant = VARIANTS.find((v) => v.id === 'uv5rmini')!
const driver = createUv5rMiniDriver({ enableWrite: true })

function blankImage(): RadioImage {
  return {
    radioId: 'uv5rmini',
    variant: '5RMINI',
    layout: 'uv5rmini',
    createdAt: '2026-08-21T00:00:00.000Z',
    regions: variant.regions.map((r) => ({ start: r.start, data: new Uint8Array(r.size).fill(0xff), label: r.label })),
    meta: {},
    sha256: '',
  }
}

function open() {
  setActivePinia(createPinia())
  const store = useCodeplugStore()
  store.load(blankImage(), driver)
  return store
}

type Store = ReturnType<typeof open>

function withChannels(store: Store, count: number) {
  store.transact('setup', () => {
    for (let i = 1; i <= count; i++) store.createChannel(i)
  })
}

/** The table's apply, written the one way that makes it a single history entry. */
function applyTo(store: Store, slots: readonly number[], change: BulkChange) {
  store.transact(`edit ${slots.length} channels`, () => {
    for (const slot of slots) {
      const ch = store.doc?.channels.get(slot)
      if (ch) store.updateChannel(slot, bulkPatch(ch, change))
    }
  })
}

const at = (store: Store, slot: number) => store.channels.find((c) => c.index === slot)!

describe('applying one change to a selection', () => {
  let store: Store

  beforeEach(() => {
    store = open()
    withChannels(store, 12)
  })

  it('is one step in the history, not one per channel', () => {
    // `skip` rather than power: a fresh channel already carries the schema's
    // default power level, so counting those would count the ten this edit
    // never touched.
    const skipped = () => store.channels.filter((c) => c.skip === 'skip').length
    expect(skipped()).toBe(0)

    applyTo(store, [1, 2, 3, 4, 5, 6, 7, 8], { skip: 'skip' })
    expect(skipped()).toBe(8)

    store.undo()

    expect(skipped(), 'eight edits undid as eight steps').toBe(0)
  })

  it('leaves every slot outside the selection exactly as it was', () => {
    const before = at(store, 12)
    applyTo(store, [1, 2, 3], { bandwidthHz: 12_500, skip: 'skip' })

    expect(at(store, 12)).toEqual(before)
    expect(at(store, 1).bandwidthHz).toBe(12_500)
  })

  it('leaves the document dirty, and clean again once the history is taken back', () => {
    applyTo(store, [1, 2, 3], { skip: 'skip' })
    expect(store.dirty).toBe(true)

    while (store.canUndo) store.undo()

    // Not cosmetic: `dirty` is what the write gate reads to decide whether there
    // is anything to send, and a bulk edit that could not be walked back out of
    // it would offer a write that changes no bytes.
    expect(store.dirty, 'undoing everything the history knows about left it dirty').toBe(false)
  })

  /*
   * The claim the whole form is arranged around, checked where it would
   * actually fail. `bulkPatch` omitting `txAllowed` is only half of it - the
   * other half is that `updateChannel` spreads the patch over the record, and a
   * key present with the value `undefined` would win over the record's own.
   */
  it('cannot turn a receive-only channel transmit-capable without being asked', () => {
    store.updateChannel(4, { txAllowed: false, txInhibitReason: 'Weather' })
    expect(at(store, 4).txAllowed).toBe(false)

    applyTo(store, [1, 2, 3, 4, 5], {
      power: { mW: mW(1000), label: 'Low' },
      bandwidthHz: 12_500,
      rxTone: ctcss(1000),
      skip: 'skip',
      tuningStep: hz(25_000),
    })

    expect(at(store, 4).txAllowed).toBe(false)
    expect(at(store, 4).txInhibitReason).toBe('Weather')
    expect(at(store, 4).power.mW, 'the edit that was asked for did not land').toBe(1000)
  })

  it('does turn it transmit-capable when that is the instruction', () => {
    store.updateChannel(4, { txAllowed: false, txInhibitReason: 'Weather' })
    applyTo(store, [4], { transmit: 'allow' })

    expect(at(store, 4).txAllowed).toBe(true)
  })

  it('takes a whole transmit lockout back in one undo', () => {
    applyTo(store, [1, 2, 3, 4, 5], { transmit: 'rx-only' })
    expect(store.rxOnlyCount).toBe(5)

    store.undo()

    expect(store.rxOnlyCount).toBe(0)
  })

  it('re-runs the diagnostics, so a bulk edit cannot hide behind a stale count', () => {
    // A bandwidth the radio does not offer is a `radio.bandwidth.unsupported`
    // warning. It has to appear from the bulk path as readily as from the
    // single editor, or the write gate is reading a codeplug that no longer
    // exists.
    const unsupported = 6_250
    expect(driver.schema.rf.bandwidths).not.toContain(unsupported)

    applyTo(store, [1, 2, 3], { bandwidthHz: unsupported })

    const found = store.diagnostics.filter((d) => d.ruleId === 'radio.bandwidth.unsupported')
    expect(found.map((d) => d.channel)).toEqual([1, 2, 3])
  })
})
