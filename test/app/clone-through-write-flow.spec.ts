// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Cloning a codeplug from someone else's radio must not grow a write path of
 * its own.
 *
 * It is the largest change the app can make - every channel, every zone, every
 * talk group at once - which makes it exactly the change that must go past the
 * backup check, the line-by-line diff and the typed word. A component that
 * merged and then sent would be a second way to reach the radio, and the second
 * way is always the one that skips something.
 *
 * A source check, deliberately: there is no Vue or Pinia harness in this suite,
 * and what is being guarded is which functions this component is allowed to
 * call at all.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../app/components/OpenCodeplugButton.vue', import.meta.url)),
  'utf8',
)

describe('applying a donor codeplug', () => {
  it('sends nothing itself', () => {
    expect(SOURCE).not.toMatch(/writeImage\(/)
    expect(SOURCE).not.toMatch(/writeToRadio\(/)
    expect(SOURCE).not.toMatch(/restoreToRadio\(/)
  })

  it('will not apply a merge the encoder has already refused', () => {
    // The merge always succeeds; rendering it onto your image can fail, and a
    // donor address book bigger than your radio's read brought back is the
    // ordinary way. Finding that out on the write page means the whole clone is
    // in the document, the history is gone and the gate is blocking, so the
    // same call the write page makes has to run before Apply is offered.
    const apply = SOURCE.slice(SOURCE.indexOf('async function applyToOpen'))
    const body = apply.slice(0, apply.indexOf('\n}') + 1)
    expect(body).toMatch(/cannotWrite\.value !== null/)
    expect(SOURCE).toMatch(/v-if="!cannotWrite"/)
  })

  it('hands the merge to the write page', () => {
    const apply = SOURCE.slice(SOURCE.indexOf('async function applyToOpen'))
    const body = apply.slice(0, apply.indexOf('\n}') + 1)
    expect(body).toMatch(/codeplug\.replaceDocument\(/)
    expect(body).toMatch(/navigateTo\('\/write'\)/)
  })

  it('offers the two opt-ins unticked every time', () => {
    // Not preferences. They are decisions about one file, and a tick remembered
    // from the last one is how somebody ends up transmitting a DMR ID that
    // belongs to another radio without ever choosing to.
    const pick = SOURCE.slice(SOURCE.indexOf('async function onPick'))
    const body = pick.slice(0, pick.indexOf('\n}') + 1)
    const setIds = body.indexOf('copyRadioIds.value = false')
    const setKeys = body.indexOf('copyKeys.value = false')
    const show = body.indexOf('donor.value = {')

    expect(setIds, 'the radio ID opt-in is no longer reset before the dialog opens').toBeGreaterThan(-1)
    expect(setKeys, 'the keys opt-in is no longer reset before the dialog opens').toBeGreaterThan(-1)
    expect(setIds).toBeLessThan(show)
    expect(setKeys).toBeLessThan(show)
  })
})
