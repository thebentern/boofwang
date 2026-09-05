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

/**
 * Which radios may offer the clip-on dongle route.
 *
 * A different claim from `BLUETOOTH_RADIOS`, pinned for the same reason: the
 * dongle is the Bluetooth device and the radio behind it is not, so this list
 * is about programming ports, not radio modules. The DM-32UV is absent
 * despite having the same two-pin jack - its protocol needs the port-close
 * resets a dongle cannot deliver (the schema comment argues it in full). The
 * UV-82 and the UV-K5 are absent despite their jacks fitting: a BT-A1D drew
 * nothing from a UV-82 on two separate attempts, a PTT fob drew nothing from
 * a UV-K5, and neither radio is named on either dongle's supported list. A
 * port that fits is not a route, which is the whole reason this list is
 * written out rather than derived from the plug.
 *
 * Editing it is the moment to ask what a dongle has actually carried. One
 * radio has: the UV-5R Mini, which is why `dongleProven` is a separate
 * question from this one.
 */
const DONGLE_RADIOS: readonly RadioId[] = ['uv5g', 'uv5r', 'uv5rmini']

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

  it('offers the dongle route for exactly the pinned radios', () => {
    const declared = RADIO_IDS.filter((id) => SCHEMAS[id]?.capabilities.dongle !== undefined)
    expect(declared).toEqual(DONGLE_RADIOS)
  })

  it('pins which radios have actually been read through a dongle', () => {
    /*
     * A Baofeng BT-A1D carried a UV-5R Mini codeplug on 2026-09-01 and drew
     * nothing at all from a UV-82 the same day. `dongle` says the jack fits;
     * this says a codeplug has come off. Keeping them apart is what stops one
     * radio's success labelling every other radio's button "connect".
     */
    const proven = RADIO_IDS.filter((id) => SCHEMAS[id]?.capabilities.dongleProven === true)
    expect(proven).toEqual(['uv5rmini'])
    // And nothing claims proof without the port that carries it.
    for (const id of proven) expect(SCHEMAS[id]?.capabilities.dongle).toBe('k2')
  })

  it('keeps the dongle a port fact, never a transport', () => {
    // 'bluetooth' in `transports` means the radio has a BLE module of its
    // own. A dongle radio claiming it there would put the wrong words on the
    // connect screen and, on the UV-5R Mini, the wrong block size on the wire.
    for (const id of DONGLE_RADIOS) {
      expect(SCHEMAS[id]?.capabilities.dongle).toBe('k2')
      expect(SCHEMAS[id]?.capabilities.transports).toContain('serial')
    }
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
