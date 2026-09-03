// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * That a running transfer is visible on the one screen that draws it.
 *
 * The connect page picks one card from a precedence list, and the cable's
 * support blockers sat above the live states. On an iPad `no-usb-host` is
 * permanently true, so it won every evaluation: a whole UV-5R Mini codeplug
 * came down over Bluetooth behind a card headed "Bluetooth is the way in on
 * this device", with no progress bar, no byte count and no cancel button, and
 * a Bluetooth read that failed showed nothing at all. The bug was reported as
 * "there was no visual feedback that the data was being pulled down".
 *
 * `support` describes the cable and only the cable. It must not outrank the
 * carrier that is working.
 *
 * A source check, in the manner of test/app/bluetooth-offer.spec.ts: there is
 * no Vue harness in this suite, and the defect is one computed property.
 */
const PAGE = readFileSync(fileURLToPath(new URL('../../app/pages/index.vue', import.meta.url)), 'utf8')

const link = /const link = computed<FaultState \| 'ready'>\(\(\) => \{([\s\S]*?)\n\}\)/.exec(PAGE)?.[1] ?? ''

/** Where a line first appears in the card precedence list, or -1. */
const at = (re: RegExp) => {
  const m = re.exec(link)
  return m ? m.index : -1
}

describe('which card the connect page draws', () => {
  it('finds the precedence list it is meant to check', () => {
    expect(link, 'the page no longer declares link as a computed').not.toBe('')
    // The blockers are still consulted somewhere in it, or the assertions
    // below would pass on a list that had simply stopped mentioning them.
    expect(at(/support\.value\.blocker/)).toBeGreaterThan(-1)
  })

  it('puts a running transfer above every cable support blocker', () => {
    const transfer = at(/transfer\.active/)
    expect(transfer, 'the transfer state is no longer in the list').toBeGreaterThan(-1)
    expect(transfer).toBeLessThan(at(/support\.value\.blocker/))
  })

  it('puts the open Bluetooth chooser above them too', () => {
    const picking = at(/blePicking/)
    expect(picking, 'the ble-picking state is no longer in the list').toBeGreaterThan(-1)
    expect(picking).toBeLessThan(at(/support\.value\.blocker/))
  })

  it('shows a Bluetooth fault rather than the card about cables', () => {
    // Keyed on the carrier the attempt was over, so a cable fault does not
    // displace the guidance a browser without Web Serial actually needs.
    const fault = at(/fault\.value && via\.value !== 'adapter'/)
    expect(fault, 'a Bluetooth fault no longer outranks the support blockers').toBeGreaterThan(-1)
    expect(fault).toBeLessThan(at(/support\.value\.blocker/))
  })

  it('still answers the device with no USB host once nothing is happening', () => {
    // The card is right when it is the whole story, and it has to stay: an
    // iPhone has no cable route at all and that is the sentence it needs.
    expect(link).toMatch(/no-usb-host'\) return 'no-cable'/)
  })
})

/**
 * And that the card it draws can actually say how far along the read is.
 *
 * The interface rework moved the progress bar into the connect card and left a
 * `TransferProgress.vue` modal behind, mounted nowhere, which is why this
 * asserts on the card and not on a component. That file has since been
 * deleted, so there is now exactly one place a read can be shown and this is
 * what holds it wired up.
 */
describe('what the reading card is handed', () => {
  it('gets the live counts', () => {
    expect(PAGE).toMatch(/:progress="progress"/)
    expect(PAGE).toMatch(/const progress = computed\([\s\S]*?transfer\.percent/)
  })
})
