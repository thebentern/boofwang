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
 * It cannot be filtered for. `requestDevice` matches its filters against the
 * advertisement, and this radio advertises neither its service nor a name -
 * both were tried against real hardware and both listed nothing. So the
 * request has to be `acceptAllDevices`, and the screen has to name what the
 * radio calls itself, because the list is then every Bluetooth device in
 * range. A filter creeping back in is an empty chooser returning.
 */
describe('the Bluetooth chooser', () => {
  it('does not send a filter a device cannot match', () => {
    expect(CHOOSER).toMatch(/!profile\.filterable/)
  })

  it('tells the reader which row is theirs', () => {
    // With every device listed, the advertised name is the only thing that
    // distinguishes the radio from the headphones next to it.
    expect(PAGE).toMatch(/advertisedName/)
    expect(PAGE).toMatch(/:ble-name="bleName"/)
  })
})
