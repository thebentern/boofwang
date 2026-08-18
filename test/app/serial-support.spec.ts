// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { evaluateSerialSupport, type NavigatorLike } from '#core/platform/serial-support.js'

const nav = (userAgent: string, withSerial: boolean): NavigatorLike =>
  withSerial ? { userAgent, serial: {} } : { userAgent }

const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const SAFARI = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const FIREFOX = 'Mozilla/5.0 (Macintosh; rv:151.0) Gecko/20100101 Firefox/151.0'
const EDGE = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'

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
