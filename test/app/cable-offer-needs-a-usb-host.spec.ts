// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hostSupports } from '#core/platform/host.js'
import { evaluateSerialSupport } from '#core/platform/serial-support.js'

/**
 * "Use a cable instead" must not appear on a device that has no cable.
 *
 * The offer is carrier-based - anything reached over Bluetooth gains a way back
 * to the cable - rather than listed in each Bluetooth state, because a
 * Bluetooth read that times out lands in the shared `off` state and listing it
 * per state left exactly those cases stranded. See transport-fallback.spec.ts,
 * which is the rule this one bounds.
 *
 * What that rule cost was the one card that is itself about an absent cable.
 * `no-cable` declares `via: 'bluetooth'` and lists no actions of its own, so on
 * an iPhone the rule appended the only button on a card titled "Bluetooth is
 * the way in on this device" - and the button led to `requestPort` in a
 * WKWebView with no `navigator.serial`, so the card contradicted itself and
 * then reported that the browser does not support Web Serial.
 *
 * These are source-level facts, like the rest of test/app. Nothing on the iOS
 * path has been run on a device.
 */
const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8')

const fault = read('app/components/connect/LinkFault.vue')
const page = read('app/pages/index.vue')

/** The computed itself, without the reasoning above it, which names the states. */
const strandedRule = fault.slice(fault.indexOf('const actions = computed'))

describe('the offer of a cable', () => {
  it('is gated on the device having a USB host', () => {
    expect(strandedRule).toMatch(/props\.usbHost &&\s+\(via\.value === 'bluetooth'/)
  })

  it('keeps the carrier test rather than replacing it', () => {
    // The gate is an extra conjunct. Swapping the carrier test for a host test
    // would take the cable away from the browser dead ends it exists for.
    expect(strandedRule).toContain("via.value === 'bluetooth' || via.value === 'dongle'")
    expect(strandedRule).toContain('!IN_PROGRESS.includes(props.state)')
  })

  it('cannot be dropped by a caller that forgets the prop', () => {
    // The prop is required, alone among the card's environment props, because
    // an optional boolean is cast to false when absent - which would withdraw
    // the way back to the cable on every host at once and say nothing. This is
    // the regression transport-fallback.spec.ts exists to catch, so the fix
    // for it must not be the thing that reintroduces it.
    expect(fault).toMatch(/^ {2}usbHost: boolean$/m)
    expect(fault).not.toMatch(/usbHost\?: boolean/)
  })

  it('is not gated on the state that happens to carry it today', () => {
    // `no-cable` is the only card an iPhone reaches only because `link` ranks
    // it above every other. A state test would go quiet the day a transfer or
    // a Bluetooth fault outranks it, and there is still no cable on that
    // device from any card.
    expect(strandedRule).not.toContain("'no-cable'")
  })

  it('is not gated on whether the shell picks the port', () => {
    // The nearer-to-hand capability, and the wrong one: an ordinary desktop
    // browser has no native serial and does want the cable offered.
    expect(hostSupports('browser', ['nativeSerial'])).toBe(false)
    expect(hostSupports('browser', ['usbHost'])).toBe(true)
  })
})

describe('the capability the page asks for', () => {
  it('is asked by name, not inferred from the host', () => {
    expect(page).toMatch(/hostSupports\(useShell\(\)\.host, \['usbHost'\]\)/)
    expect(page).toContain(':usb-host="usbHost"')
    expect(page).not.toMatch(/host === 'ios'/)
  })

  it('is false on exactly the hardware with no USB host', () => {
    expect(hostSupports('ios', ['usbHost'])).toBe(false)
    for (const host of ['browser', 'desktop', 'android'] as const) {
      expect(hostSupports(host, ['usbHost'])).toBe(true)
    }
  })

  it('is the same fact that raises the card', () => {
    // One capability, read twice: it decides the blocker in lib/ and the
    // button in app/, so the card and its actions cannot disagree.
    expect(evaluateSerialSupport(undefined, true, 'ios').blocker).toBe('no-usb-host')
    expect(page).toMatch(/blocker === 'no-usb-host'\) return 'no-cable'/)
  })
})

describe('the no-cable card', () => {
  it('lists no actions of its own', () => {
    // Which is why the appended cable was the whole of it, and why removing
    // it has to leave something else behind.
    const at = fault.indexOf("  'no-cable': {")
    expect(at).toBeGreaterThan(-1)
    const entry = fault.slice(at, fault.indexOf('\n  },', at))
    expect(entry).toContain("via: 'bluetooth'")
    expect(entry).not.toContain('actions:')
  })

  it('is not left with nothing to press', () => {
    // Both offers come from the page as slotted actions, so the card keeps a
    // file to open and, where the radio has a route, a Bluetooth attempt.
    expect(page).toMatch(/BLE_OFFER_STATES[^\n]*\n?[^\n]*'no-cable'/)
    expect(page).toMatch(/FILE_STATES[^\n]*\n?[^\n]*'no-cable'/)
  })
})
