// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The channel editor's transmit side goes through `shift-form.ts`, both ways.
 *
 * The round trip is proved in `test/lib/model/shift-form.spec.ts`. What that
 * cannot see is whether the editor still uses it, and the defect it exists for
 * - a split opened as simplex and written back that way - was the editor
 * building the transmit side by hand. A source check, for the reason
 * `ui-features.spec.ts` gives: there is no Vue harness in this suite.
 */
const EDITOR = readFileSync(fileURLToPath(new URL('../../app/components/ChannelEditor.vue', import.meta.url)), 'utf8')

describe('the channel editor', () => {
  it('opens the transmit side through shiftFormOf', () => {
    expect(EDITOR).toMatch(/shiftFormOf\(props\.channel\.tx, props\.channel\.rxFreq\)/)
  })

  it('builds it back only through txSpecOf', () => {
    // Every transmit side built by hand is a kind the editor can forget again.
    expect(EDITOR).toMatch(/txSpecOf\(shiftForm\.value\)/)
    expect(EDITOR).not.toMatch(/kind: 'offset'|kind: 'split'/)
  })

  it('offers split where the schema says the radio can store one', () => {
    expect(EDITOR).toMatch(/duplexes\.includes\('split'\)/)
  })
})
