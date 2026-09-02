// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  capabilitiesFor,
  detectHost,
  hostLabel,
  shellProvidesTransports,
  type HostCapability,
  type HostKind,
} from '#core/platform/host.js'

/**
 * The host model, now that there are four hosts.
 *
 * Two of them are WebViews whose user agent names a browser that is not
 * running, so everything downstream depends on `detectHost` reading the
 * injected bridge exactly and on the capability tables saying the truth about
 * each device. A wrong entry here is a control offered on a phone that cannot
 * use it, or an iPhone user told to install Chrome.
 */

const KINDS: readonly HostKind[] = ['browser', 'desktop', 'android', 'ios']

describe('detectHost reads the bridge exactly', () => {
  it('answers browser for anything that is not one of the two shapes', () => {
    // The Capacitor plugin writes the lowercase platform name and nothing
    // else. A capitalised name or a bare true is some other program's idea of
    // a bridge, and the fail-closed answer is the one that offers nothing it
    // cannot back.
    for (const injected of [
      undefined,
      null,
      'ios',
      'android',
      42,
      [],
      {},
      { mobile: 'Android' },
      { mobile: 'IOS' },
      { mobile: true },
      { mobile: 'web' },
      { desktop: 'true' },
      { desktop: 1 },
    ]) {
      expect(detectHost(injected), JSON.stringify(injected) ?? 'undefined').toBe('browser')
    }
  })

  it('answers the mobile platform the plugin names', () => {
    expect(detectHost({ mobile: 'android' })).toBe('android')
    expect(detectHost({ mobile: 'ios' })).toBe('ios')
  })

  it('answers desktop for a literal true', () => {
    expect(detectHost({ desktop: true })).toBe('desktop')
  })

  it('lets desktop win when both flags are present', () => {
    // Neither shell writes the other's flag, so this object was made by
    // neither. Desktop is the answer whose transports still go through the Web
    // APIs, which is the safer shell to be mistaken for.
    expect(detectHost({ desktop: true, mobile: 'ios' })).toBe('desktop')
    expect(detectHost({ desktop: true, mobile: 'android' })).toBe('desktop')
  })

  it('ignores a false desktop flag next to a mobile one', () => {
    expect(detectHost({ desktop: false, mobile: 'ios' })).toBe('ios')
  })
})

describe('every host answers every capability', () => {
  const keys = Object.keys(capabilitiesFor('browser')) as HostCapability[]

  it('has the same keys on every table', () => {
    // A capability added to the interface and to three of the four tables
    // compiles, because the fourth is the same object type - this is what
    // makes the omission fail.
    for (const kind of KINDS) {
      const caps = capabilitiesFor(kind)
      expect(Object.keys(caps).sort(), kind).toEqual([...keys].sort())
      for (const k of keys) expect(typeof caps[k], `${kind}.${k}`).toBe('boolean')
    }
  })

  it('denies a USB host on iOS and nowhere else', () => {
    // This is a fact about the hardware, not the shell. An iPhone or iPad has
    // no USB host stack a programming cable can attach to.
    for (const kind of KINDS) {
      expect(capabilitiesFor(kind).usbHost, kind).toBe(kind !== 'ios')
    }
  })

  it('has native serial on Android and nowhere else', () => {
    // The desktop shell answers the Web Serial picker; it does not replace
    // the API. Only the Android plugin supplies ports itself.
    for (const kind of KINDS) {
      expect(capabilitiesFor(kind).nativeSerial, kind).toBe(kind === 'android')
    }
  })

  it('has native Bluetooth on both mobile shells', () => {
    for (const kind of KINDS) {
      expect(capabilitiesFor(kind).nativeBluetooth, kind).toBe(kind === 'android' || kind === 'ios')
    }
  })

  it('cannot print from either WebView, where window.print is a no-op', () => {
    for (const kind of KINDS) {
      expect(capabilitiesFor(kind).print, kind).toBe(kind === 'browser' || kind === 'desktop')
    }
  })
})

describe('what the gates ask of the host', () => {
  it('says the shell owns the transports on exactly the two mobile hosts', () => {
    for (const kind of KINDS) {
      expect(shellProvidesTransports(kind), kind).toBe(kind === 'android' || kind === 'ios')
    }
  })

  it('labels the mobile hosts and stays silent elsewhere', () => {
    // Null, not a string, for the browser and desktop hosts: there the
    // browser's own name is the right one, and this must not override it.
    expect(hostLabel('android')).toBe('Android')
    expect(hostLabel('ios')).toBe('iOS')
    expect(hostLabel('browser')).toBeNull()
    expect(hostLabel('desktop')).toBeNull()
  })
})
