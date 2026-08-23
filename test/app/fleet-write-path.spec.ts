// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Programming twenty radios must not grow a write path of its own.
 *
 * This is the largest thing the app can be asked to do, and it is exactly the
 * shape of feature that acquires a shortcut: a loop that sends without asking,
 * a port held open across a read and a write, a confirmation dropped because
 * typing it twenty times is tedious. Every one of those would be a second way
 * to reach a radio, and the second way is always the one that skips something.
 *
 * So the fleet run is twenty ordinary writes. It calls the same two functions
 * the connect page and the write page call, and adds a record. These tests
 * guard that arrangement rather than the behaviour, because the behaviour they
 * protect only shows itself on somebody's bricked handset.
 *
 * A source check, deliberately: there is no Vue or Pinia harness in this suite,
 * and what is being guarded is which functions this code is allowed to call.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const SESSION = read('../../app/composables/useFleetSession.ts')
const PAGE = read('../../app/pages/fleet.vue')
const STORE = read('../../app/stores/fleet.ts')

describe('the fleet run sends nothing of its own', () => {
  it('never reaches a driver’s transfer methods', () => {
    for (const source of [SESSION, PAGE, STORE]) {
      expect(source).not.toMatch(/\bwriteImage\(/)
      expect(source).not.toMatch(/\breadImage\(/)
      expect(source).not.toMatch(/\bidentify\(/)
    }
  })

  it('never opens a port itself', () => {
    // `device.connect` is what a second transport path would have to call. Not
    // calling it is what keeps the read and the write on the same two
    // connections every other screen uses.
    for (const source of [SESSION, PAGE, STORE]) {
      expect(source).not.toMatch(/device\.connect\(/)
      expect(source).not.toMatch(/acquirePort\(/)
      expect(source).not.toMatch(/requestPort\(/)
    }
  })

  it('reads and writes through the two functions every other screen uses', () => {
    expect(SESSION).toMatch(/session\.connectAndRead\(/)
    expect(SESSION).toMatch(/session\.writeToRadio\(/)
  })

  it('hands the plan over as an unsaved edit, as a one-radio clone does', () => {
    // `replaceDocument` marks the document dirty and leaves the diff, the gate
    // and the typed word to happen afterwards, against the image just read off
    // this handset.
    expect(SESSION).toMatch(/codeplug\.replaceDocument\(/)
  })
})

describe('every radio in the run is confirmed on its own diff', () => {
  it('asks for the typed word before each write', () => {
    const confirm = PAGE.slice(PAGE.indexOf('<ConfirmTyped'))
    expect(confirm).toMatch(/token="WRITE"/)
    // The send handler is reachable only from that confirmation.
    expect(PAGE).toMatch(/@confirm="send"/)
    expect(PAGE).not.toMatch(/@click="send"/)
  })

  it('shows the diff of the radio in front of the user, not of the master', () => {
    // `diffChannels` against `driver.decode(codeplug.image)` is what makes the
    // account per handset: the second-hand radio's diff is a hundred rows and
    // the one done last week is three. Diffing the master against itself would
    // show the same list every time and mean nothing.
    const diff = PAGE.slice(PAGE.indexOf('const diff = computed'))
    expect(diff.slice(0, diff.indexOf('\n})'))).toMatch(/driver\.decode\(image\)/)
  })

  it('evaluates the same gate the driver enforces', () => {
    expect(PAGE).toMatch(/evaluateWriteGate\(/)
    // A blocked write is not offered at lower confidence; the confirmation is
    // in the `v-else` of the blocker branch.
    expect(PAGE).toMatch(/v-if="blockers\.length"/)
  })
})

describe('the roster is schema-driven', () => {
  it('offers the per-unit columns only where the radio has a DMR identity', () => {
    expect(PAGE).toMatch(/features\.radioIds/)
    const columns = PAGE.slice(PAGE.indexOf('<template v-if="varies'))
    expect(columns.slice(0, 400)).toMatch(/idFeature\.maxId/)
    expect(columns.slice(0, 900)).toMatch(/idFeature\.nameLength/)
  })
})

describe('the roster is checked before a radio is plugged in', () => {
  it('tells the store which radio the roster is for, without waiting for the run', () => {
    // This regressed once and was invisible: the store learned the radio in
    // `startRun`, so `validateFleetRoster` had no schema until the moment it
    // stopped mattering, and a roster with two radios on one DMR ID started the
    // run without a word. The store spec covers the rule; this covers the wire.
    expect(PAGE).toMatch(/fleet\.setRadio\(/)
    const sync = PAGE.slice(PAGE.indexOf('watch('))
    expect(sync.slice(0, 200)).toMatch(/codeplug\.doc\?\.radio/)
    expect(sync.slice(0, 200)).toMatch(/immediate: true/)
  })

  it('will not start a run the roster has errors in', () => {
    expect(PAGE).toMatch(/:disabled="fleet\.errors\.length > 0/)
  })
})

describe('somewhere to reach it from', () => {
  it('is in the navigation, which every page renders', () => {
    expect(read('../../app/layouts/default.vue')).toMatch(/to: '\/fleet'/)
  })
})
