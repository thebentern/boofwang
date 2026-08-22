// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import type { RadioId } from '#core/model/codeplug.js'
import { RADIO_IDS, SCHEMAS } from '#core/radio/registry.js'
import { bluetoothProfile } from '#core/transport/bluetooth-uuids.js'

/**
 * Which radios the connect screen may offer a wireless route for.
 *
 * `requestDevice` filters the chooser on a service UUID, so a radio offered
 * over Bluetooth without one lists nothing at all - and an empty chooser is
 * indistinguishable from a radio that is switched off, which is the failure
 * this project has already misdiagnosed twice on physical cables. So the list
 * of radios allowed to claim Bluetooth is pinned rather than trusted: adding a
 * second one has to be a deliberate edit here, and the edit is the moment to
 * ask whether a profile has actually been read off that radio.
 */
const BLUETOOTH_RADIOS: readonly RadioId[] = ['uv5rmini']

describe('transport declarations', () => {
  it.each(RADIO_IDS)('%s can be reached over a cable', (id) => {
    // No radio here is wireless-only, and one that was would need a connect
    // flow that does not open with "pick the one on your cable".
    expect(SCHEMAS[id]?.capabilities.transports).toContain('serial')
  })

  it('offers Bluetooth for exactly the radios that have a profile', () => {
    const declared = RADIO_IDS.filter((id) => SCHEMAS[id]?.capabilities.transports.includes('bluetooth'))
    expect(declared).toEqual(BLUETOOTH_RADIOS)
  })

  /*
   * The flag the UI reads before it is allowed to describe Bluetooth as
   * working. If the default profile ever goes back to being a guess, the
   * connect screen has to go back to calling it untested, and this is what
   * would notice.
   */
  it('has a profile that a radio has actually answered on', () => {
    expect(bluetoothProfile().verified).toBe(true)
  })
})
