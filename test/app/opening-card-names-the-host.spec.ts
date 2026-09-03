// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The first card a person sees must name the thing that is actually running.
 *
 * `first` is the opening state of the connect page and it sold the browser:
 * nothing to install, and Web Serial holding the cable back until you ask.
 * Inside the Android app all three of those are false. Something was installed,
 * the program is not a browser, and a WebView has no Web Serial at all - the
 * cable arrives through the plugin behind `app/mobile/serial.ts`, which can
 * enumerate adapters whenever it likes. What withholds the first move there is
 * Android's USB permission, a per-device prompt only the person holding the
 * phone can answer.
 *
 * Same defect as the `picking` card, which claimed we could not see a list our
 * own code was choosing from, and the same remedy: a whole replacement card
 * chosen by `shellPicksPort`, rather than holes punched in the browser's
 * sentences. Too much of the card differs for a substitution to leave copy
 * anybody reads the way a user does.
 *
 * The key stays the capability, not the shell. An iPhone is in a shell too, has
 * no Web Serial either, and never settles on this card: `no-usb-host` outranks
 * the fallback and it lands on `no-cable`, whose advice is a different sentence
 * about a different route.
 */

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8')

const fault = read('app/components/connect/LinkFault.vue')
const page = read('app/pages/index.vue')
const plugin = read('mobile/plugins/usb-serial/android/src/main/java/ng/boofwa/usbserial/UsbSerialPlugin.java')

/**
 * One card's literal, with none of the prose around it.
 *
 * The docstrings above these cards have to name what they are replacing, so a
 * region slice would find "Web Serial" in a comment explaining that the app
 * must not say it.
 */
const card = (name: string) => {
  const at = fault.indexOf(`const ${name}: FaultCopy = {`)
  // Thrown rather than asserted: a missing card would leave every negative
  // assertion below passing against an empty string, which is the one way this
  // file could go green while saying nothing.
  if (at < 0) throw new Error(`${name} is not declared in LinkFault.vue`)
  return fault.slice(at, fault.indexOf('\n}', at))
}

const firstInApp = card('FIRST_IN_APP')
const inApp = firstInApp + card('PICKING_IN_APP')

describe('the opening card', () => {
  it('keeps the browser copy for the browser', () => {
    // The desktop shell still reaches `navigator.serial`, so this sentence is
    // true on three of the four hosts and must not be softened for the fourth.
    expect(fault).toContain('Program your radio from the browser')
    expect(fault).toContain('Web Serial will ')
  })

  it('has a version for the app, registered beside the picking one', () => {
    expect(fault).toContain('const FIRST_IN_APP')
    expect(fault).toContain('first: FIRST_IN_APP')
    expect(fault).toMatch(/props\.shellPicksPort \? IN_APP\[props\.state\]/)
  })

  it('never names Web Serial in a program that has none', () => {
    expect(inApp).not.toContain('Web Serial')
  })

  it('does not promise nothing was installed, inside the thing that was', () => {
    expect(firstInApp).not.toContain('Nothing to install')
  })

  it('does not call the app a browser', () => {
    expect(firstInApp).not.toContain('browser')
  })

  it('names what actually holds the first step back', () => {
    expect(firstInApp).toContain('Android will not let it open')
  })

  it('keeps the button, which is the only way in on either host', () => {
    // A replacement card that dropped the action would leave a phone with the
    // pitch and no cable, which is worse than the sentence being wrong.
    expect(firstInApp).toContain("key: 'pick'")
  })
})

describe('which host gets which opening card', () => {
  it('is chosen by the capability, so an iPhone keeps neither', () => {
    // `inShell` is the tempting shortcut and is wrong here for the same reason
    // it was wrong for `picking`: an iPhone is in a shell and has no USB host.
    expect(page).toContain("hostSupports(useShell().host, ['nativeSerial'])")
    expect(page).toContain(':shell-picks-port="shellPicksPort"')
  })

  it('is outranked on an iPhone by the card about having no cable at all', () => {
    const fn = page.slice(page.indexOf('const link = computed'))
    const noCable = fn.indexOf("return 'no-cable'")
    const fallback = fn.indexOf("hasPort.value ? 'ready' : 'first'")
    expect(noCable).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(noCable)
  })
})

describe('where the app lands on the opening card', () => {
  it('starts there, before any adapter has been granted', () => {
    expect(page).toContain("return hasPort.value ? 'ready' : 'first'")
  })

  it('returns there when the permission prompt is declined', () => {
    // The second way in, and the reason this card is not a splash screen. On
    // the native path a null from `acquirePort` is a declined prompt, and the
    // page deliberately raises no fault for it - so the fallback above is what
    // the person is looking at, with the button still under their thumb.
    const start = page.indexOf('async function pickPort')
    const fn = page.slice(start, page.indexOf('\n}\n', start))
    const raised = [...fn.matchAll(/fault\.value = (?!null)(\S+)/g)].map((m) => m[1])
    expect(raised).toEqual(["'empty'"])
    expect(fn).toContain('!shellPicksPort')
  })
})

describe('what the app card claims about Android', () => {
  it('can list the adapters without asking anyone', () => {
    // "boofwang can look for an adapter on the OTG port without asking anyone"
    // is only honest while listing stays ungated. `getDeviceList` needs no
    // grant; `hasPermission` is reported per device, not required to report it.
    const fn = plugin.slice(plugin.indexOf('public void listDevices'), plugin.indexOf('public void requestPermission'))
    expect(fn).toContain('usbManager().getDeviceList()')
    expect(fn).not.toContain('call.reject')
  })

  it('will not open one until the prompt is answered', () => {
    const fn = plugin.slice(plugin.indexOf('public void open('))
    expect(fn).toMatch(/!usbManager\(\)\.hasPermission\(device\)[\s\S]{0,200}has not been granted/)
  })

  it('asks through Android rather than drawing a prompt of its own', () => {
    const fn = plugin.slice(plugin.indexOf('public void requestPermission'), plugin.indexOf('public void open('))
    expect(fn).toContain('usbManager().requestPermission(device, pi)')
  })
})
