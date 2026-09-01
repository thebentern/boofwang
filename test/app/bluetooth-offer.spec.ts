// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Where the connect screen is allowed to offer a wireless route.
 *
 * Two failures, one on each side of the same decision.
 *
 * The offer was once gated on the link state alone, and the healthy serial card
 * was deliberately excluded on the grounds that a second route distracts from
 * the button that already works. That is true of the button and wrong about the
 * state: `hasPort` goes true for *any* granted adapter and never goes back, so
 * one cable granted once - for any radio, in any earlier session - permanently
 * hid Bluetooth from the one radio that has been read over it. The reported
 * symptom was "there is no Bluetooth option for the UV-5R Mini", and nothing on
 * the screen suggested the route existed.
 *
 * The other direction is worse, because it fails silently: `requestDevice`
 * filters the chooser on a service UUID, so offering Bluetooth for a radio
 * nobody has read one off opens a chooser that lists nothing at all - which is
 * indistinguishable from a radio that is switched off, and is the diagnosis
 * this project has already got wrong twice on physical cables.
 *
 * A source check, in the manner of the DMR panel gates above it: there is no
 * Vue harness in this suite, and both defects are one computed property.
 */
const PAGE = readFileSync(fileURLToPath(new URL('../../app/pages/index.vue', import.meta.url)), 'utf8')
const CHOOSER = readFileSync(fileURLToPath(new URL('../../app/composables/useWebBluetooth.ts', import.meta.url)), 'utf8')

describe('the Bluetooth offer', () => {
  const offer = /const offerBluetooth = computed\(\s*\(\) =>([\s\S]*?),?\n\)/.exec(PAGE)?.[1] ?? ''

  it('finds the gate it is meant to check', () => {
    expect(offer, 'the page no longer declares offerBluetooth as a computed').not.toBe('')
  })

  it('asks whether this radio can do Bluetooth at all', () => {
    expect(offer).toMatch(/radioDoesBluetooth/)
    // And that question is answered from the schema, not from a list of radio
    // ids kept in the UI, so a driver that gains or loses a profile is right
    // here on the same deploy.
    expect(PAGE).toMatch(/const radioDoesBluetooth = computed\([\s\S]*?capabilities\.transports/)
  })

  it('does not let a granted cable hide the offer', () => {
    const states = /const BLE_OFFER_STATES: readonly \(FaultState \| 'ready'\)\[\] = \[([^\]]*)\]/.exec(PAGE)?.[1]
    expect(states, 'BLE_OFFER_STATES is no longer declared as it was').toBeDefined()
    expect(states).toMatch(/'ready'/)
  })
})

/**
 * How the chooser asks for this radio.
 *
 * Two things have to hold, and the second is the one that broke.
 *
 * A service filter matches only a service the device advertises, and FFE0 came
 * from a GATT enumeration - after connecting - so the name prefixes have to go
 * alongside it. And the profile those filters come from has to be the radio's:
 * `resetBluetoothProfile()` ran on every load without a `?ble=` override and
 * substituted Nordic UART, so the shipped chooser filtered on a service nobody
 * has seen advertised and listed nothing at all.
 */
describe('the Bluetooth chooser', () => {
  it('filters on the advertised names, not only on the services', () => {
    expect(CHOOSER).toMatch(/\.map\(\(namePrefix\) => \(\{ namePrefix \}\)\)/)
  })

  it('keeps a way out of a filter that cannot match', () => {
    // Neither filter is confirmed against this radio's advertisement, so an
    // empty chooser has to be distinguishable from a radio that is not there.
    expect(CHOOSER).toMatch(/everyDevice/)
    expect(PAGE).toMatch(/'bluetooth-all'/)
  })

  it('names every candidate service up front, on both chooser branches', () => {
    // Web Bluetooth refuses a service that was not in `optionalServices`, so
    // a one-service list would strand the escape hatch - and the dongle path,
    // whose two GATT guesses are exactly why this is a list - on whichever
    // variant was not named.
    expect(CHOOSER).toMatch(/optionalServices: services/)
    expect(CHOOSER).not.toMatch(/optionalServices: \[profile\.service\]/)
  })

  it('filters on advertised services and declares the connect-time ones', () => {
    // These are two different lists. A filter may only name what a device
    // broadcasts; optionalServices must name everything getPrimaryService
    // will be called with. Building the filter from the connect-time service
    // is what emptied a chooser with a BF_Writer dongle a foot away.
    expect(CHOOSER).toMatch(/advertisedServices \?\? \[c\.service\]/)
    expect(CHOOSER).toMatch(/advertised\.map\(\(service\) => \(\{ services: \[service\] \}\)\)/)
  })

  it('names the radio for the unfiltered list', () => {
    expect(PAGE).toMatch(/advertisedName/)
    expect(PAGE).toMatch(/:ble-name="bleName"/)
  })
})

/**
 * The dongle route: a cable-only radio reached through a clip-on BLE-to-UART
 * bridge. The dongle is the Bluetooth device; the radio behind it is not.
 */
describe('the dongle offer', () => {
  it('reads the schema, not a list of radio ids kept in the UI', () => {
    expect(PAGE).toMatch(/const dongleRoute = computed\([\s\S]*?capabilities\.dongle/)
  })

  it('hands the chooser the dongle candidates on the dongle route', () => {
    expect(PAGE).toMatch(/profiles: BL1_DONGLE_PROFILES/)
  })

  it('derives its caveat from THIS radio, not from the dongle profile', () => {
    /*
     * The profile is verified - a BT-A1D carried a UV-5R Mini codeplug - and
     * keying the label on that would have promoted every cable-only radio to
     * "connect" on the strength of a different radio's success. A UV-82 on
     * the same dongle the same day drew nothing, so the claim has to be made
     * per radio and `dongleProven` is where that fact lives.
     */
    const label = /const bleLabel = computed\(\(\) => \{([\s\S]*?)\n\}\)/.exec(PAGE)?.[1] ?? ''
    expect(label, 'bleLabel is no longer the computed this checks').not.toBe('')
    expect(label).toMatch(/dongleProven\.value/)
    expect(label).not.toMatch(/BL1_DONGLE_PROFILES\.some/)
    expect(label).toMatch(/untested/)
    expect(PAGE).toMatch(/const dongleProven = computed\([\s\S]*?capabilities\.dongleProven/)
  })

  it('offers the dongle alongside the module for a radio that has both', () => {
    /*
     * The UV-5R Mini has a BLE module AND a port a dongle clips onto. Reading
     * "has a module" as "never a dongle" made this screen ask a BF_Writer for
     * the Mini's FFE0 service and report the dongle as the wrong device. It
     * was the right device. Both candidate sets go to the chooser, its own
     * verified profile first, and `linkTo` tries them in order.
     */
    expect(PAGE).toMatch(/const dongleAlso = computed\([\s\S]*?capabilities\.dongle/)
    expect(PAGE).toMatch(/profiles: BL1_DONGLE_PROFILES, withDefault: true/)
  })

  it('does not call the radio a Bluetooth radio on the connected card', () => {
    expect(PAGE).toMatch(/:bluetooth-label="dongleRoute \? 'Bluetooth dongle' : 'Bluetooth'"/)
  })
})
