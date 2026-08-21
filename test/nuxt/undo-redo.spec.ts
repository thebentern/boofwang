// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { transplantCodeplug } from '#core/radio/transplant.js'
import { createUv5rMiniDriver } from '#core/radios/uv5rmini/driver.js'
import { VARIANTS } from '#core/radios/uv5rmini/protocol.js'
import type { EncryptionKey } from '#core/model/codeplug.js'
import type { RadioImage } from '#core/radio/image.js'
import { useCodeplugStore } from '~/stores/codeplug'

/**
 * The undo history, exercised through the store rather than around it.
 *
 * What is being protected here is not the stack - a bounded stack is easy - but
 * the four things that break quietly when it is wrong: an action that undoes in
 * pieces instead of whole, `dirty` disagreeing with what the encoder would
 * produce, a history that survives a different radio being read, and the frozen
 * copy-on-write list being rebuilt when one row changed.
 *
 * A real driver over a blank image, because a fake one would let a patch that
 * produces a channel the decoder would never emit pass unnoticed.
 */
const variant = VARIANTS.find((v) => v.id === 'uv5rmini')!
const driver = createUv5rMiniDriver({ enableWrite: true })

/** Erased flash: every slot empty, which is what the store's create path wants. */
function blankImage(): RadioImage {
  return {
    radioId: 'uv5rmini',
    variant: '5RMINI',
    layout: 'uv5rmini',
    createdAt: '2026-08-21T00:00:00.000Z',
    regions: variant.regions.map((r) => ({
      start: r.start,
      data: new Uint8Array(r.size).fill(0xff),
      label: r.label,
    })),
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

/** Programmed channels to work on, staged as one action so they cost the history one entry. */
function withChannels(store: Store, count: number) {
  store.transact('setup', () => {
    for (let i = 1; i <= count; i++) store.createChannel(i)
  })
}

describe('grouping', () => {
  let store: Store

  beforeEach(() => {
    store = open()
  })

  it('takes back a burst of edits as one step', () => {
    store.transact('bulk', () => {
      for (let i = 1; i <= 20; i++) store.createChannel(i)
    })
    expect(store.channelCount).toBe(20)

    store.undo()

    expect(store.channelCount, 'twenty placements undid as twenty steps').toBe(0)
    expect(store.canUndo).toBe(false)
  })

  it('takes back an ungrouped edit on its own', () => {
    for (let i = 1; i <= 3; i++) store.createChannel(i)
    store.undo()
    expect(store.channelCount).toBe(2)
    expect(store.canUndo).toBe(true)
  })

  it('undoes a slot to what it held before the action, not to a value it passed through', () => {
    withChannels(store, 2)
    store.updateChannel(1, { name: 'ORIGINAL' })

    // A preset shifting a channel out of a slot and putting another one in is
    // two writes to the same slot inside one action.
    store.transact('shuffle', () => {
      store.setChannelRecord(1, null)
      store.setChannelRecord(1, { ...store.channels[0]!, index: 1, name: 'STAGED' })
    })
    expect(store.channels.find((c) => c.index === 1)!.name).toBe('STAGED')

    store.undo()
    expect(store.channels.find((c) => c.index === 1)!.name).toBe('ORIGINAL')
  })

  it('records nothing for an action that changed nothing', () => {
    store.createChannel(1)
    const before = store.revision

    // Slot 99 holds nothing, so there is nothing to patch. A step that visibly
    // does nothing when taken back is worse than no step at all.
    store.updateChannel(99, { name: 'NOWHERE' })
    expect(store.revision, 'an action that touched no slot still bumped the revision').toBe(before)

    store.undo()
    expect(store.channelCount, 'the no-op took a turn of its own on the stack').toBe(0)
  })
})

describe('bounds', () => {
  it('remembers the last fifty actions and forgets the rest', () => {
    const store = open()
    withChannels(store, 1)

    for (let i = 1; i <= 60; i++) store.updateChannel(1, { name: `N${i}` })
    expect(store.channels[0]!.name).toBe('N60')

    for (let i = 0; i < 60; i++) store.undo()

    // Fifty steps back from N60 is N10, and the ten before it are gone for good.
    expect(store.channels[0]!.name).toBe('N10')
    expect(store.canUndo).toBe(false)
  })

  it('keeps the codeplug dirty once an action has fallen off the bottom', () => {
    const store = open()
    withChannels(store, 1)

    for (let i = 1; i <= 60; i++) store.updateChannel(1, { name: `N${i}` })
    for (let i = 0; i < 60; i++) store.undo()

    expect(store.dirty, 'ten edits are still applied and the write gate must say so').toBe(true)
  })
})

describe('dirty and revision', () => {
  let store: Store

  beforeEach(() => {
    store = open()
    withChannels(store, 2)
  })

  it('clears dirty when an undo arrives back at what the radio holds', () => {
    const clean = open()
    expect(clean.dirty).toBe(false)

    clean.createChannel(1)
    expect(clean.dirty).toBe(true)

    clean.undo()
    expect(clean.dirty, 'nothing is left to write, so nothing should be offered').toBe(false)

    clean.redo()
    expect(clean.dirty).toBe(true)
  })

  /*
   * Every edit the history does not record, not just the ones that go through
   * `republish`.
   *
   * The history is about channels; a settings change or a zone rename is
   * unwritten all the same, and undoing the channel edit must not re-lock the
   * write gate over it. The two renames publish their own list rather than
   * going through `republish`, and so are the mutations most easily left out of
   * the count - which is exactly what happened: the undo cleared `dirty` while
   * the rename stood, and the write gate answered a perfectly good write with
   * "nothing has changed, so there is nothing to write". Named one by one
   * rather than covered by a single representative, because the failure is
   * silent and the next mutation added would be silent too.
   *
   * Each starts from a freshly read codeplug and makes the channel edit first,
   * so that its own `dirtyBefore` is false. On a codeplug that was already
   * dirty the undo would leave `dirty` set whatever the count said, and the
   * test would pass without testing anything.
   */
  const key: EncryptionKey = { id: 'k1', slot: 1, name: 'K', type: 'arc4', keyHex: '00112233' }

  const unrecorded: [string, (s: Store) => void][] = [
    ['a setting', (s) => s.setSetting('squelch', 3)],
    ['a scan list', (s) => s.setScanListChannels('s1', [1])],
    ['a contact', (s) => s.addContact()],
    ['a zone rename', (s) => s.renameZone('z1', 'Renamed')],
    ['a talk group rename', (s) => s.renameTalkGroup('t1', 'Renamed')],
    ['an added encryption key', (s) => s.setEncryptionKey({ ...key, slot: 2 })],
    ['a removed encryption key', (s) => s.removeEncryptionKey(1)],
  ]

  for (const [what, change] of unrecorded) {
    it(`keeps dirty set when ${what} is still pending`, () => {
      // Seeded on the document rather than through the store, so that the
      // codeplug is still clean when the channel edit is made.
      const clean = open()
      clean.doc!.zones.push({ id: 'z1', name: 'Local', channels: [] })
      clean.doc!.scanLists.push({ id: 's1', name: 'Scan', channels: [] })
      clean.doc!.talkGroups.push({ id: 't1', name: 'TG', number: 1, callType: 'group' })
      clean.doc!.encryptionKeys.push({ ...key })
      expect(clean.dirty).toBe(false)

      clean.createChannel(1)
      change(clean)
      clean.undo()

      expect(clean.dirty, 'the undo cleared dirty over an edit that is still unwritten').toBe(true)
    })
  }

  it('moves the revision forward on every undo and redo', () => {
    const seen = [store.revision]
    store.updateChannel(1, { name: 'ONE' })
    seen.push(store.revision)
    store.undo()
    seen.push(store.revision)
    store.redo()
    seen.push(store.revision)

    // `encoded`, the diff and the write gate all key off this, so it has to
    // change in both directions - and never go backwards, or a stale value
    // could be mistaken for a fresh one.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!)
  })

  it('drops the redo stack when a new edit is made', () => {
    store.updateChannel(1, { name: 'ONE' })
    store.undo()
    expect(store.canRedo).toBe(true)

    store.updateChannel(2, { name: 'TWO' })
    expect(store.canRedo).toBe(false)
  })
})

describe('load', () => {
  it('forgets every recorded action', () => {
    const store = open()
    withChannels(store, 2)
    store.updateChannel(1, { name: 'ONE' })
    expect(store.canUndo).toBe(true)

    store.load(blankImage(), driver)

    expect(store.canUndo, 'a patch naming slots in the previous codeplug survived the read').toBe(false)
    expect(store.canRedo).toBe(false)
    expect(store.dirty).toBe(false)

    const before = store.revision
    store.undo()
    expect(store.revision).toBe(before)
  })

  it('forgets them on close too', () => {
    const store = open()
    withChannels(store, 1)
    store.updateChannel(1, { name: 'ONE' })

    store.close()

    expect(store.canUndo).toBe(false)
    expect(store.canRedo).toBe(false)
  })
})

/**
 * Cloning someone else's codeplug replaces the whole document at once, and it
 * is the same hazard as reading a different radio rather than a similar one.
 *
 * Every entry in this history names channel slots. Applying one of them to a
 * channel bank that has just been replaced wholesale does not fail - which is
 * exactly the problem, because what it does instead is put one of your own
 * channels back in among your friend's, and nothing says so.
 */
describe('applying a donor codeplug', () => {
  /** The merge the open-file dialog builds, with channels nothing like the recipient's. */
  function cloneOnto(store: Store, slot: number) {
    const donor = driver.decode(blankImage())
    donor.channels = new Map([[slot, { ...store.doc!.channels.values().next().value!, index: slot, name: 'CLUB' }]])
    const { codeplug } = transplantCodeplug({
      donor,
      recipient: store.doc!,
      schema: driver.schema,
      now: '2026-08-21T00:00:00.000Z',
    })
    store.replaceDocument(codeplug)
  }

  it('forgets every action recorded against the codeplug it replaced', () => {
    const store = open()
    withChannels(store, 3)
    store.updateChannel(1, { name: 'MINE' })
    expect(store.canUndo).toBe(true)

    cloneOnto(store, 7)

    expect(store.canUndo, 'a patch naming slots in the pre-clone codeplug survived the merge').toBe(false)
    expect(store.canRedo).toBe(false)
  })

  it('cannot have an undo put one of your channels back among the donor’s', () => {
    const store = open()
    withChannels(store, 3)
    store.updateChannel(1, { name: 'MINE' })

    cloneOnto(store, 7)
    store.undo()

    expect(
      [...store.doc!.channels.keys()].sort((a, b) => a - b),
      'undo resurrected a channel the clone had removed',
    ).toEqual([7])
  })

  it('stays unwritten, so the write gate still offers the clone', () => {
    // An entry carries `dirty` as it stood before its action. Undoing past the
    // merge would restore the flag from before it and re-lock the write gate
    // with a whole cloned codeplug sitting unsent.
    const store = open()
    withChannels(store, 3)
    store.updateChannel(1, { name: 'MINE' })

    cloneOnto(store, 7)
    while (store.canUndo) store.undo()

    expect(store.dirty, 'the write gate re-locked with an unwritten clone in the document').toBe(true)
  })
})

describe('what an undo costs the table', () => {
  it('leaves every untouched row the same object', () => {
    const store = open()
    withChannels(store, 30)
    const before = store.channels

    store.updateChannel(15, { name: 'EDITED' })
    store.undo()

    const after = store.channels
    expect(after.length).toBe(before.length)
    for (let i = 0; i < after.length; i++) {
      if (after[i]!.index === 15) continue
      // Identity, not equality. A rebuilt array re-renders four thousand rows
      // on a DM-32UV; a copy with one position replaced re-renders one.
      expect(after[i], `row ${after[i]!.index} changed identity for an edit to slot 15`).toBe(before[i])
    }
  })

  it('restores the record itself, not a reconstruction of it', () => {
    const store = open()
    withChannels(store, 3)
    const original = store.channels.find((c) => c.index === 2)!

    store.updateChannel(2, { name: 'CHANGED', rxFreq: 146_520_000 as never })
    store.undo()

    expect(store.channels.find((c) => c.index === 2)).toBe(original)
  })

  it('brings a deleted channel back into the zones that named it', () => {
    const store = open()
    withChannels(store, 3)
    store.doc!.zones.push({ id: 'z1', name: 'Local', channels: [1, 2, 3] })

    store.deleteChannel(2)
    expect(store.doc!.zones[0]!.channels).toEqual([1, 3])

    store.undo()

    expect(store.channels.some((c) => c.index === 2)).toBe(true)
    expect(store.doc!.zones[0]!.channels, 'the channel came back but its zone did not').toEqual([1, 2, 3])
  })
})
