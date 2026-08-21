// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { evaluateBluetoothSupport } from '#core/platform/bluetooth-support.js'
import { evaluateSerialSupport } from '#core/platform/serial-support.js'
import type { NavigatorLike } from '#core/platform/browser.js'

const nav = (userAgent: string, withBluetooth: boolean): NavigatorLike =>
  withBluetooth ? { userAgent, bluetooth: {} } : { userAgent }

const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const SAFARI = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const FIREFOX = 'Mozilla/5.0 (Macintosh; rv:151.0) Gecko/20100101 Firefox/151.0'
const EDGE = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1'
const IPADOS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

describe('evaluateBluetoothSupport', () => {
  it('passes a Chromium browser on https with an adapter', () => {
    expect(evaluateBluetoothSupport(nav(CHROME, true), true, { adapterAvailable: true })).toMatchObject({
      supported: true,
      blocker: 'none',
      browser: 'Chrome',
    })
  })

  it('passes when the adapter question was never asked', () => {
    // `getAvailability()` is itself optional. Refusing to connect because we
    // could not ask would block a browser that works.
    expect(evaluateBluetoothSupport(nav(EDGE, true), true).supported).toBe(true)
  })

  it('reports the insecure context first, not "unsupported browser"', () => {
    const r = evaluateBluetoothSupport(nav(CHROME, false), false)
    expect(r.blocker).toBe('insecure-context')
    expect(r.advice).toMatch(/HTTPS/)
  })

  it('says Firefox and Safari are never going to do this', () => {
    // Both declined on stated privacy grounds rather than as a backlog item, so
    // "try a later version" would be the wrong advice in both cases.
    for (const ua of [SAFARI, FIREFOX]) {
      const r = evaluateBluetoothSupport(nav(ua, false), true)
      expect(r.blocker).toBe('unsupported-browser')
      expect(r.advice).toMatch(/does not intend to/)
      expect(r.advice).toMatch(/Chrome or Edge/)
    }
  })

  it('tells an iPhone user that no browser will help, rather than to install one', () => {
    const r = evaluateBluetoothSupport(nav(IOS_CHROME, false), true)
    expect(r.blocker).toBe('unsupported-browser')
    expect(r.anotherBrowserWouldHelp).toBe(false)
    expect(r.advice).toMatch(/Safari underneath/)
  })

  it('sees through an iPad pretending to be a Mac', () => {
    // iPadOS reports a desktop Safari user agent. Without the touch-point test
    // an iPad user is told to install Chrome, which on iOS is Safari.
    const desktop = evaluateBluetoothSupport(nav(IPADOS, false), true, { maxTouchPoints: 0 })
    const ipad = evaluateBluetoothSupport(nav(IPADOS, false), true, { maxTouchPoints: 5 })
    expect(desktop.anotherBrowserWouldHelp).toBe(true)
    expect(ipad.anotherBrowserWouldHelp).toBe(false)
    expect(ipad.advice).toMatch(/iPhone or iPad/)
  })

  it('distinguishes no adapter from no API, because the remedy differs', () => {
    const r = evaluateBluetoothSupport(nav(CHROME, true), true, { adapterAvailable: false })
    expect(r.blocker).toBe('no-adapter')
    expect(r.advice).toMatch(/Switch Bluetooth on/)
    expect(r.advice).not.toMatch(/Use Chrome/)
  })

  it('degrades gracefully when there is no navigator at all', () => {
    const r = evaluateBluetoothSupport(undefined, true)
    expect(r.supported).toBe(false)
    expect(r.browser).toBe('your browser')
  })

  it('always explains itself when blocking', () => {
    for (const [ua, secure, api] of [
      [CHROME, false, false],
      [SAFARI, true, false],
      [IOS_CHROME, true, false],
    ] as const) {
      const r = evaluateBluetoothSupport(nav(ua, api), secure)
      expect(r.supported).toBe(false)
      expect(r.advice.length).toBeGreaterThan(20)
    }
  })
})

describe('the two gates disagree in exactly the places they should', () => {
  it('gives Android Bluetooth and not Serial, which is the whole point', () => {
    // No mobile browser implements Web Serial. Chrome on Android does implement
    // Web Bluetooth, and that is the only route this tool has onto a phone.
    const bt = evaluateBluetoothSupport(nav(ANDROID_CHROME, true), true)
    const serial = evaluateSerialSupport({ userAgent: ANDROID_CHROME }, true)
    expect(bt.supported).toBe(true)
    expect(serial.supported).toBe(false)
  })

  it('gives Firefox Serial and not Bluetooth', () => {
    // Firefox 151 shipped Web Serial and has said it will not ship Web
    // Bluetooth, so this is the one browser where the narrower gate bites a
    // user who has just been told the tool works.
    const bt = evaluateBluetoothSupport(nav(FIREFOX, false), true)
    const serial = evaluateSerialSupport({ userAgent: FIREFOX, serial: {} }, true)
    expect(serial.supported).toBe(true)
    expect(bt.supported).toBe(false)
  })
})
