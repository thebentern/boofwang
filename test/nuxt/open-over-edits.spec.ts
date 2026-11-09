// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createUv5rMiniDriver } from '#core/radios/uv5rmini/driver.js'
import { VARIANTS } from '#core/radios/uv5rmini/protocol.js'
import type { RadioImage } from '#core/radio/image.js'
import { useCodeplugStore } from '~/stores/codeplug'
import { useFleetStore } from '~/stores/fleet'

/**
 * What the stores have to answer for the paths that open something over the
 * codeplug in the editor, besides a read: a file, a backup, a restore, and
 * the end of a fleet run.
 *
 * The first three ask `canReplace`, which test/nuxt/read-over-edits covers.
 * The fourth needs one more fact, which document the editor holds rather
 * than which edit of it, because a fleet run's master becomes the only copy
 * of its edits once the editor has moved on to a radio's codeplug.
 *
 * A real driver over a blank image, so "dirty" and "encoded" mean what the
 * editor means by them.
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

describe('which document is open', () => {
  it('does not move for an edit, however many', () => {
    const store = open()
    const opened = store.generation
    store.createChannel(1)
    store.setSetting('squelch', 9)
    store.undo()

    expect(store.revision).not.toBe(opened)
    expect(store.generation).toBe(opened)
  })

  it('moves whenever a different document is put in place', () => {
    const store = open()
    const seen = [store.generation]

    store.load(blankImage(), driver)
    seen.push(store.generation)
    store.replaceDocument(structuredClone(store.doc!))
    seen.push(store.generation)
    store.close()
    seen.push(store.generation)

    expect(new Set(seen).size).toBe(seen.length)
  })
})

describe('a fleet run’s master', () => {
  /*
   * `masterOnlyHere` in useFleetSession is
   * `edits !== null && codeplug.generation !== edits.generation`, and the run
   * records `edits` only for a dirty master. It cannot be imported here, so
   * the two stores are driven the way the run drives them.
   */
  const FACTS = { title: 'Club', variant: null, channels: 0, zones: 0, talkGroups: 0, keys: 0 }

  function start(codeplug: ReturnType<typeof useCodeplugStore>) {
    const fleet = useFleetStore()
    fleet.setRadio('uv5rmini')
    fleet.startRun(
      codeplug.doc!,
      'uv5rmini',
      FACTS,
      codeplug.dirty ? { image: codeplug.encoded, generation: codeplug.generation } : null,
    )
    return fleet
  }

  const onlyHere = (codeplug: ReturnType<typeof useCodeplugStore>, fleet: ReturnType<typeof useFleetStore>) =>
    fleet.masterEdits !== null && codeplug.generation !== fleet.masterEdits.generation

  it('records nothing for a master with nothing unwritten', () => {
    // It came off a radio, out of a backup or from a file, and is still
    // there, so ending the run loses none of it.
    const codeplug = open()
    const fleet = start(codeplug)

    expect(fleet.masterEdits).toBeNull()
    codeplug.load(blankImage(), driver)
    expect(onlyHere(codeplug, fleet)).toBe(false)
  })

  it('keeps what saving an edited master needs', () => {
    const codeplug = open()
    codeplug.createChannel(1)
    const fleet = start(codeplug)

    expect(fleet.masterEdits?.image).toBe(codeplug.encoded)
    expect(fleet.masterEdits?.image).not.toBeNull()
  })

  it('is safe to drop while the editor still holds it, edited further or not', () => {
    const codeplug = open()
    codeplug.createChannel(1)
    const fleet = start(codeplug)

    expect(onlyHere(codeplug, fleet)).toBe(false)
    codeplug.createChannel(2)
    expect(onlyHere(codeplug, fleet)).toBe(false)
  })

  it('is the only copy once a read has replaced the editor', () => {
    // The first read of a run replaces the editor's document by design. From
    // then on the edits are on no radio, in no backup, and only in the run.
    const codeplug = open()
    codeplug.createChannel(1)
    const fleet = start(codeplug)

    codeplug.load(blankImage(), driver)

    expect(onlyHere(codeplug, fleet)).toBe(true)
  })

  it('is forgotten when the run ends, so the next run asks afresh', () => {
    const codeplug = open()
    codeplug.createChannel(1)
    const fleet = start(codeplug)

    fleet.endRun()

    expect(fleet.masterEdits).toBeNull()
  })
})
