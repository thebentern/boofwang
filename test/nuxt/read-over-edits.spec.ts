// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createUv5rMiniDriver } from '#core/radios/uv5rmini/driver.js'
import { VARIANTS } from '#core/radios/uv5rmini/protocol.js'
import type { RadioImage } from '#core/radio/image.js'
import { useCodeplugStore } from '~/stores/codeplug'
import { useFleetStore } from '~/stores/fleet'

/**
 * Whether a read may replace the open codeplug, decided by the store.
 *
 * Reading replaced the open codeplug without looking at it, so unwritten
 * edits went with every read, and the write gate's remedy for a missing
 * backup was "read the radio first". `canReplace` is the question every read
 * asks now, the connect page before it raises a chooser and `connectAndRead`
 * twice more, and these are the answers it has to give.
 *
 * A real driver over a blank image, as the undo spec uses, so that "dirty"
 * means what the editor means by it rather than a flag set by hand.
 */
const variant = VARIANTS.find((v) => v.id === 'uv5rmini')!
const driver = createUv5rMiniDriver({ enableWrite: true })

function blankImage(): RadioImage {
  return {
    radioId: 'uv5rmini',
    variant: '5RMINI',
    layout: 'uv5rmini',
    createdAt: '2026-11-09T00:00:00.000Z',
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
  const store = useCodeplugStore()
  store.load(blankImage(), driver)
  return store
}

beforeEach(() => setActivePinia(createPinia()))

describe('replacing the open codeplug', () => {
  it('needs no agreement when nothing in it is unwritten', () => {
    expect(open().canReplace()).toBe(true)
  })

  it('needs no agreement when nothing is open at all', () => {
    expect(useCodeplugStore().canReplace()).toBe(true)
  })

  it('refuses to replace unwritten edits nobody agreed to lose', () => {
    const store = open()
    store.createChannel(1)

    expect(store.dirty).toBe(true)
    expect(store.canReplace()).toBe(false)
    expect(store.canReplace(null)).toBe(false)
  })

  it('counts an edit outside the channel list the same as one inside it', () => {
    // The channel diff is the only part of the loss the confirmation can
    // count. The refusal must not be built on that count, or a settings edit
    // would go unasked.
    const store = open()
    store.setSetting('squelch', 9)

    expect(store.channelCount).toBe(0)
    expect(store.canReplace()).toBe(false)
  })

  it('takes agreement given for the edits on screen', () => {
    const store = open()
    store.createChannel(1)

    expect(store.canReplace(store.revision)).toBe(true)
  })

  it('does not stretch an agreement to an edit made after it', () => {
    // The read this guards takes minutes on some radios, and nothing locks
    // the channel page meanwhile. What was agreed to is what was shown.
    const store = open()
    store.createChannel(1)
    const agreed = store.revision

    store.createChannel(2)

    expect(store.canReplace(agreed)).toBe(false)
  })

  it('has nothing to lose once undo is back where the read left it', () => {
    // Why the connect page drops its question rather than hiding it: the
    // answer can change under it without anyone touching the panel.
    const store = open()
    store.createChannel(1)
    store.undo()

    expect(store.canReplace()).toBe(true)
  })

  it('has nothing to lose after a fresh load', () => {
    const store = open()
    store.createChannel(1)

    store.load(blankImage(), driver)

    expect(store.canReplace()).toBe(true)
  })
})

describe('what a fleet run may replace without asking', () => {
  /*
   * The fleet page's `canRead` is `codeplug.canReplace(fleet.editorRevision)`.
   * It cannot be imported here, so the two stores are driven the way the run
   * drives them and the same question is asked of them.
   */
  const FACTS = { title: 'Club', variant: null, channels: 0, zones: 0, talkGroups: 0, keys: 0 }

  function underway() {
    const codeplug = open()
    const fleet = useFleetStore()
    fleet.setRadio('uv5rmini')
    return { codeplug, fleet }
  }

  it('lets the first read replace a master with edits, which the run has copied', () => {
    const { codeplug, fleet } = underway()
    codeplug.createChannel(1)

    fleet.startRun(codeplug.doc!, 'uv5rmini', FACTS)
    fleet.noteEditor(codeplug.revision)

    expect(codeplug.canReplace(fleet.editorRevision)).toBe(true)
  })

  it('asks about an edit made to the master after the run took its copy', () => {
    // The run sends the copy, so this edit reaches no radio, and the next read
    // would have taken it without a word.
    const { codeplug, fleet } = underway()
    fleet.startRun(codeplug.doc!, 'uv5rmini', FACTS)
    fleet.noteEditor(codeplug.revision)

    codeplug.createChannel(1)

    expect(codeplug.canReplace(fleet.editorRevision)).toBe(false)
  })

  it('lets the next read replace a plan the run made and nobody touched', () => {
    // A skipped radio leaves its plan in the editor, unwritten. Reading that
    // radio again makes the same plan, so it is not work anybody can lose.
    const { codeplug, fleet } = underway()
    codeplug.replaceDocument(structuredClone(codeplug.doc!))
    fleet.noteEditor(codeplug.revision)

    expect(codeplug.dirty).toBe(true)
    expect(codeplug.canReplace(fleet.editorRevision)).toBe(true)

    codeplug.createChannel(3)
    expect(codeplug.canReplace(fleet.editorRevision)).toBe(false)
  })

  it('forgets what the editor held when a run starts or ends', () => {
    const { codeplug, fleet } = underway()
    fleet.noteEditor(41)

    fleet.startRun(codeplug.doc!, 'uv5rmini', FACTS)
    expect(fleet.editorRevision).toBeNull()

    fleet.noteEditor(42)
    fleet.endRun()
    expect(fleet.editorRevision).toBeNull()
  })
})
