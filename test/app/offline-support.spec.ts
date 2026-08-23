// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { evaluateOfflineSupport } from '#core/platform/offline-support.js'

/**
 * Whether boofwang keeps a copy of itself, and what it says when it does not.
 *
 * The combination worth the test is the desktop shell, which is Chromium
 * carrying a scheme it registered as secure - so every check after the first
 * passes there, and getting the order wrong installs a cache in front of a
 * packaged application that updates by being replaced.
 */

const CHROME = {
  userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  serviceWorker: {},
}
const FIREFOX = { userAgent: 'Mozilla/5.0 (Macintosh; rv:151.0) Gecko/20100101 Firefox/151.0' }

describe('where an offline copy belongs', () => {
  it('is kept in a browser that can', () => {
    expect(evaluateOfflineSupport(CHROME, true, 'browser', false)).toEqual({
      supported: true,
      blocker: 'none',
      browser: 'Chrome',
      advice: '',
    })
  })

  it('is never kept in the desktop shell, even though everything there would allow it', () => {
    /*
     * The shell carries Chromium and registers `app:` as secure, so it looks
     * exactly like a supported browser. A worker there would hold one release's
     * assets in the profile and go on serving them after the application had
     * been replaced - an offline cache defeating an update, which is the failure
     * this whole feature exists to prevent.
     */
    const support = evaluateOfflineSupport(CHROME, true, 'desktop', false)
    expect(support.supported).toBe(false)
    expect(support.blocker).toBe('desktop-shell')
  })

  it('says nothing about it in the desktop shell', () => {
    // Explaining the absence of a feature somebody already has by another route
    // is a warning that trains people to skip warnings.
    expect(evaluateOfflineSupport(CHROME, true, 'desktop', false).advice).toBe('')
  })

  it('is not kept by the dev server', () => {
    const support = evaluateOfflineSupport(CHROME, true, 'browser', true)
    expect(support.blocker).toBe('development')
    expect(support.advice).toContain('Build the site')
  })

  it('cannot be kept over plain http', () => {
    const support = evaluateOfflineSupport(CHROME, false, 'browser', false)
    expect(support.blocker).toBe('insecure-context')
    expect(support.advice).toContain('https://')
  })

  it('cannot be kept by a browser without service workers, and names it', () => {
    const support = evaluateOfflineSupport(FIREFOX, true, 'browser', false)
    expect(support.blocker).toBe('unsupported-browser')
    expect(support.advice).toContain('Firefox')
    // The reassurance matters as much as the refusal: nothing about privacy
    // changes, only whether the page has to be fetched first.
    expect(support.advice).toContain('on your device')
  })

  it('treats an absent navigator as unsupported', () => {
    expect(evaluateOfflineSupport(undefined, true, 'browser', false).supported).toBe(false)
  })

  it('checks the host before anything else', () => {
    // Every other blocker is also true of a desktop shell served over http in
    // dev, and only one of them is the reason.
    expect(evaluateOfflineSupport(undefined, false, 'desktop', true).blocker).toBe('desktop-shell')
  })
})
