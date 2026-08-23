// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import { useCodeplugStore } from '~/stores/codeplug'

/**
 * Renumbering through the store, which is where it can go wrong quietly.
 *
 * `lib/radio/renumber.ts` is pure and has its own spec. What this covers is the
 * half that a pure function cannot: a renumber is one decision, so it has to be
 * one entry in the history, and taking it back has to move the channels *and*
 * the lists that name them by number back together. An undo that restored the
 * channel numbers while leaving the zones renumbered would leave a codeplug
 * nobody made - every entry a valid number, every one of them wrong, and
 * nothing on screen to say so.
 *
 * The DM-32UV, because it is the radio that has zones, scan lists and settings
 * holding channel numbers all at once.
 */
const driver = createDm32uvDriver({ enableWrite: true })

const F = (n: string) => readFileSync(fileURLToPath(new URL(`../fixtures/images/${n}`, import.meta.url)))

function dm32Image(): RadioImage {
  const blob = new Uint8Array(F('dm32uv-DM32.01.01.040.blocks.bin'))
  const index = JSON.parse(F('dm32uv-DM32.01.01.040.index.json').toString('utf8')) as {
    firmware: string
    model: string
    blocks: { id: number; offset: number }[]
  }
  return {
    radioId: 'dm32uv',
    variant: index.firmware,
    layout: index.model,
    createdAt: '2026-08-21T00:00:00.000Z',
    regions: index.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: blob.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
    meta: {},
    sha256: '',
  }
}

function open() {
  setActivePinia(createPinia())
  const store = useCodeplugStore()
  store.load(dm32Image(), driver)
  return store
}

type Store = ReturnType<typeof open>

/** The names each zone resolves to, which is what a person actually sees. */
const zoneNames = (store: Store) =>
  store.zones.map((z) => z.channels.map((n) => store.doc!.channels.get(n)?.name ?? `MISSING ${n}`))

describe('closing the gaps through the store', () => {
  let store: Store

  beforeEach(() => {
    store = open()
    // The fixture is packed 1-45, so make a codeplug that has something to
    // tidy. Deleting through the store is what the table does, and it takes
    // the memberships with it.
    store.transact('setup', () => {
      for (const slot of [5, 6, 24, 40]) store.deleteChannel(slot)
    })
  })

  it('moves the channels and leaves the zones naming the same ones', () => {
    const before = zoneNames(store)
    const plan = store.renumberPlan('slot')!

    expect(plan.moves.length).toBeGreaterThan(0)
    expect(store.renumberChannels(plan)).toBe(true)

    expect(zoneNames(store)).toEqual(before)
    expect([...store.doc!.channels.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: store.channelCount }, (_, i) => i + 1),
    )
  })

  it('empties the slot a channel left, so nothing shows up twice', () => {
    const last = Math.max(...store.doc!.channels.keys())
    store.renumberChannels(store.renumberPlan('slot')!)
    expect(store.doc!.channels.has(last), 'the channel is still in the slot it moved out of').toBe(false)
    expect(store.channels.length, 'the rendered list and the document disagree').toBe(store.channelCount)
  })

  it('costs the history one entry', () => {
    const label = store.undoLabel
    store.renumberChannels(store.renumberPlan('slot')!)
    expect(store.undoLabel).toBe('close the gaps')

    store.undo()

    expect(store.undoLabel, 'a renumber undid in more than one step').toBe(label)
  })
})

describe('taking a renumber back', () => {
  let store: Store

  beforeEach(() => {
    store = open()
    store.transact('setup', () => {
      for (const slot of [5, 6, 24, 40]) store.deleteChannel(slot)
    })
  })

  it('puts the channels and the zones back together', () => {
    const slots = [...store.doc!.channels.keys()].sort((a, b) => a - b)
    const zones = store.zones.map((z) => [...z.channels])
    const scans = store.scanLists.map((l) => [...l.channels])

    store.renumberChannels(store.renumberPlan('slot')!)
    store.undo()

    expect([...store.doc!.channels.keys()].sort((a, b) => a - b)).toEqual(slots)
    expect(store.zones.map((z) => [...z.channels]), 'the channels came back but the zones did not').toEqual(
      zones,
    )
    expect(store.scanLists.map((l) => [...l.channels])).toEqual(scans)
  })

  it('puts a setting that holds a channel number back with them', () => {
    // Eight of the DM-32UV's settings are channel numbers written to the radio.
    // An undo that moved the channel back and left this pointing at the new
    // number would report APRS positions on somebody else's frequency.
    const highest = Math.max(...store.doc!.channels.keys())
    store.doc!.settings.aprsReportChannel1 = highest

    const plan = store.renumberPlan('slot')!
    expect(plan.settings.some((s) => s.key === 'aprsReportChannel1')).toBe(true)

    store.renumberChannels(plan)
    expect(store.doc!.settings.aprsReportChannel1).not.toBe(highest)

    store.undo()
    expect(store.doc!.settings.aprsReportChannel1).toBe(highest)
  })

  it('redoes to exactly where the undo came from', () => {
    store.renumberChannels(store.renumberPlan('name')!)
    const after = {
      slots: [...store.doc!.channels.keys()].sort((a, b) => a - b),
      names: [...store.doc!.channels.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c.name),
      zones: store.zones.map((z) => [...z.channels]),
    }

    store.undo()
    store.redo()

    expect([...store.doc!.channels.keys()].sort((a, b) => a - b)).toEqual(after.slots)
    expect([...store.doc!.channels.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c.name)).toEqual(
      after.names,
    )
    expect(store.zones.map((z) => [...z.channels]), 'redo did not land where the renumber did').toEqual(
      after.zones,
    )
  })

  it('leaves the codeplug clean when everything it knows about is undone', () => {
    const clean = open()
    clean.renumberChannels(clean.renumberPlan('name')!)
    expect(clean.dirty).toBe(true)

    clean.undo()

    expect(clean.dirty, 'the undo left the write gate holding an edit that no longer exists').toBe(false)
  })
})

describe('what a renumber refuses to do', () => {
  it('does nothing when the bank is already in the order asked for', () => {
    const store = open()
    const plan = store.renumberPlan('slot')!
    expect(store.renumberChannels(plan), 'the fixture is packed 1-45 already').toBe(false)
    expect(store.dirty).toBe(false)
    expect(store.canUndo).toBe(false)
  })

  it('refuses a plan the channel bank has moved out from under', () => {
    const store = open()
    store.transact('setup', () => {
      for (const slot of [5, 6]) store.deleteChannel(slot)
    })
    const plan = store.renumberPlan('slot')!

    // Undo and redo keep working while a dialog is open, so the document really
    // can change between agreeing to a plan and it being applied.
    store.undo()

    expect(store.renumberChannels(plan)).toBe(false)
    expect(store.dirty, 'a refused renumber still marked the codeplug edited').toBe(false)
  })

  it('asks the driver which slots the radio has memory for', () => {
    const store = open()
    // This unit has bank blocks 0x12-0x14 and 0x18: nothing at all for 255-509.
    const plan = store.renumberPlan('slot')!
    expect([...plan.mapping.values()].some((s) => s >= 255 && s <= 509)).toBe(false)
  })
})
