// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import { useCodeplugStore } from '~/stores/codeplug'

/**
 * Bringing a directory's talk groups into a codeplug.
 *
 * Through the real store over the real hardware fixture, because the whole
 * point of the feature is the cap: BrandMeister publishes about 1,800 talk
 * groups and this radio holds 800. What is being protected is that the overflow
 * is *reported*, not silently trimmed - a list that stops at the cap without
 * saying so looks exactly like a list that fitted.
 */
const BLOB = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/images/dm32uv-DM32.01.01.040.blocks.bin', import.meta.url))),
)
const INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/images/dm32uv-DM32.01.01.040.index.json', import.meta.url)), 'utf8'),
) as { firmware: string; model: string; blocks: { id: number; offset: number }[] }

function fixtureImage(): RadioImage {
  return {
    radioId: 'dm32uv',
    variant: INDEX.firmware,
    layout: INDEX.model,
    createdAt: '2026-08-22T00:00:00.000Z',
    regions: INDEX.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: BLOB.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
    meta: {},
    sha256: '',
  }
}

let store: ReturnType<typeof useCodeplugStore>

beforeEach(() => {
  setActivePinia(createPinia())
  store = useCodeplugStore()
  store.load(fixtureImage(), createDm32uvDriver())
})

const entries = (n: number, from = 90_000) =>
  Array.from({ length: n }, (_, i) => ({ number: from + i, name: `TG ${from + i}` }))

describe('importTalkGroups', () => {
  it('adds what it is given', () => {
    const before = store.talkGroups.length
    const out = store.importTalkGroups([{ number: 91, name: 'World-wide' }])
    expect(out.added).toBe(1)
    expect(store.talkGroups.length).toBe(before + 1)
    expect(store.talkGroups.at(-1)!.number).toBe(91)
  })

  it('is not undoable, the same as every other talk group edit', () => {
    // Recorded rather than desired. The undo history covers channel slots and
    // list membership; talk groups, contacts, radio IDs and messages have never
    // been on it, so `addTalkGroup` is no more reversible than this is. Worth a
    // test because wrapping the import in `transact` looks obviously right and
    // would produce an entry with nothing in it - an import that appeared
    // undoable and was not.
    const before = store.talkGroups.length
    store.importTalkGroups(entries(20))
    expect(store.talkGroups.length).toBe(before + 20)
    store.undo()
    expect(store.talkGroups.length).toBe(before + 20)
  })

  it('leaves a number that is already there alone rather than overwriting it', () => {
    store.importTalkGroups([{ number: 91, name: 'World-wide' }])
    const out = store.importTalkGroups([{ number: 91, name: 'Something else' }])
    expect(out.added).toBe(0)
    expect(out.alreadyPresent).toBe(1)
    expect(store.talkGroups.filter((g) => g.number === 91)).toHaveLength(1)
    expect(store.talkGroups.find((g) => g.number === 91)!.name).toBe('World-wide')
  })

  it('reports what would not fit instead of trimming in silence', () => {
    // The number that matters. This radio holds 800; asked for more than that,
    // the caller must be able to say how many were left behind.
    const room = store.schema!.features.talkGroups !== false
      ? store.schema!.features.talkGroups.max - store.talkGroups.length
      : 0
    const out = store.importTalkGroups(entries(room + 25))
    expect(out.added).toBe(room)
    expect(out.noRoom).toBe(25)
    expect(store.talkGroups.length).toBe(store.schema!.features.talkGroups !== false
      ? store.schema!.features.talkGroups.max
      : 0)
  })

  it('cuts a name to what the radio can hold rather than letting the encoder truncate it', () => {
    const limit = store.schema!.features.talkGroups !== false
      ? store.schema!.features.talkGroups.nameLength
      : 16
    store.importTalkGroups([{ number: 99_001, name: 'A talk group name far longer than any radio field' }])
    const added = store.talkGroups.find((g) => g.number === 99_001)!
    expect(added.name.length).toBeLessThanOrEqual(limit)
  })

  it('marks the codeplug dirty so the write gate sees the change', () => {
    store.importTalkGroups([{ number: 91, name: 'World-wide' }])
    expect(store.dirty).toBe(true)
  })
})
