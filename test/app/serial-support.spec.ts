// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { evaluateSerialSupport, type NavigatorLike } from '#core/platform/serial-support.js'

const nav = (userAgent: string, withSerial: boolean): NavigatorLike =>
  withSerial ? { userAgent, serial: {} } : { userAgent }

const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const SAFARI = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const FIREFOX = 'Mozilla/5.0 (Macintosh; rv:151.0) Gecko/20100101 Firefox/151.0'
const EDGE = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
// What the two WebViews say about themselves. Both name a browser that is not
// running: Android's carries `; wv)` and `Chrome/`, iOS's is Safari's with the
// `Version/` token missing.
const ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36'
const IOS_WEBVIEW =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

describe('evaluateSerialSupport', () => {
  it('passes a Chromium browser on https', () => {
    expect(evaluateSerialSupport(nav(CHROME, true), true)).toMatchObject({
      supported: true,
      blocker: 'none',
      browser: 'Chrome',
    })
  })

  it('passes Firefox 151+, which shipped Web Serial in 2026', () => {
    expect(evaluateSerialSupport(nav(FIREFOX, true), true).supported).toBe(true)
  })

  it('reports the insecure context first, not "unsupported browser"', () => {
    // A Chrome user on plain http sees navigator.serial === undefined. Telling
    // them their browser is at fault sends them on a pointless detour.
    const r = evaluateSerialSupport(nav(CHROME, false), false)
    expect(r.blocker).toBe('insecure-context')
    expect(r.advice).toMatch(/HTTPS/)
    expect(r.advice).not.toMatch(/does not (expose|implement)/)
  })

  it('names Safari specifically, since no Safari version will ever work', () => {
    const r = evaluateSerialSupport(nav(SAFARI, false), true)
    expect(r.blocker).toBe('unsupported-browser')
    expect(r.advice).toMatch(/Safari does not implement Web Serial/)
  })

  it('distinguishes Edge from Chrome despite Edge claiming both', () => {
    expect(evaluateSerialSupport(nav(EDGE, false), true).browser).toBe('Edge')
  })

  it('degrades gracefully when there is no navigator at all', () => {
    const r = evaluateSerialSupport(undefined, false)
    expect(r.supported).toBe(false)
    expect(r.browser).toBe('your browser')
  })

  it('always explains itself when blocking', () => {
    for (const [ua, secure] of [
      [CHROME, false],
      [SAFARI, true],
      [FIREFOX, false],
    ] as const) {
      const r = evaluateSerialSupport(nav(ua, false), secure)
      expect(r.supported).toBe(false)
      expect(r.advice.length).toBeGreaterThan(20)
    }
  })
})

describe('inside the mobile shell', () => {
  it('tells an iPhone that the cable is out and Bluetooth is in, and never names a browser', () => {
    // The iOS WebView has no navigator.serial and its user agent reads as
    // Safari. Without the host check this would say "Safari does not implement
    // Web Serial", which is true of a program that is not running.
    const r = evaluateSerialSupport(nav(IOS_WEBVIEW, false), true, 'ios')
    expect(r.supported).toBe(false)
    expect(r.blocker).toBe('no-usb-host')
    expect(r.browser).toBe('iOS')
    expect(r.advice).toMatch(/Bluetooth/)
    expect(r.advice).not.toMatch(/install/i)
    expect(r.advice).not.toMatch(/Chrome/)
    expect(r.advice).not.toMatch(/Safari/)
  })

  it('is supported on Android with no Web Serial at all, because the plugin supplies the ports', () => {
    const r = evaluateSerialSupport(nav(ANDROID_WEBVIEW, false), true, 'android')
    expect(r.supported).toBe(true)
    expect(r.blocker).toBe('none')
    expect(r.browser).toBe('Android')
    expect(r.advice).toBe('')
  })

  it('does not consult the secure-context flag inside the shell', () => {
    // The shell serves its bundle from a scheme of its own; whatever the page
    // reports for isSecureContext, there is nothing for a person to change.
    expect(evaluateSerialSupport(nav(ANDROID_WEBVIEW, false), false, 'android').supported).toBe(true)
    expect(evaluateSerialSupport(nav(IOS_WEBVIEW, false), false, 'ios').blocker).toBe('no-usb-host')
  })

  it('changes nothing for the browser and desktop hosts', () => {
    expect(evaluateSerialSupport(nav(CHROME, true), true, 'browser')).toEqual(evaluateSerialSupport(nav(CHROME, true), true))
    expect(evaluateSerialSupport(nav(SAFARI, false), true, 'desktop').blocker).toBe('unsupported-browser')
  })
})
