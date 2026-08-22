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
 * What the chooser is allowed to filter on.
 *
 * A service filter matches only a service the device puts in its
 * advertisement, and this radio puts none there: FFE0 came from a GATT
 * enumeration, which happens after connecting. Filtering on it alone listed
 * nothing with the radio a foot away in wireless CPS mode. The name is what
 * matches, so a chooser that has gone back to service-only is the bug
 * returning, and an empty chooser with no way out is what made it expensive.
 */
describe('the Bluetooth chooser', () => {
  it('filters on the advertised name, not only on the service', () => {
    expect(CHOOSER).toMatch(/namePrefixes\.map\(\(namePrefix\) => \(\{ namePrefix \}\)\)/)
  })

  it('keeps a way out of an empty chooser', () => {
    // `acceptAllDevices` is the escape hatch for a radio advertising a name
    // nobody has recorded. Reachable from the card, not only from a query
    // string somebody has to be told about.
    expect(CHOOSER).toMatch(/everyDevice/)
    expect(PAGE).toMatch(/'bluetooth-all'/)
  })
})
