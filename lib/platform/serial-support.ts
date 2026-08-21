// SPDX-License-Identifier: GPL-3.0-or-later
import { detectBrowser, type NavigatorLike } from './browser.js'

/**
 * Whether this browser can talk to a radio at all, and why not if it cannot.
 *
 * Support as of Aug 2026: Chrome/Edge 89+, Firefox 151+ on desktop. Safari does
 * not implement Web Serial on any platform, and neither does any mobile browser
 * worth relying on. The API additionally requires a secure context, which
 * GitHub Pages provides - but only over https, so a user who reaches the site
 * over plain http gets `navigator.serial === undefined` and deserves a better
 * message than "nothing happened".
 */

export type SerialBlocker = 'unsupported-browser' | 'insecure-context' | 'none'

export type { NavigatorLike } from './browser.js'

export interface SerialSupport {
  supported: boolean
  blocker: SerialBlocker
  secureContext: boolean
  /** Best-effort browser label, for the guidance text only. */
  browser: string
  advice: string
}

export function evaluateSerialSupport(nav: NavigatorLike | undefined, isSecure: boolean): SerialSupport {
  const ua = nav?.userAgent ?? ''
  const browser = detectBrowser(ua)
  const hasApi = typeof nav !== 'undefined' && 'serial' in nav

  if (hasApi && isSecure) {
    return { supported: true, blocker: 'none', secureContext: true, browser, advice: '' }
  }

  // A secure context is a prerequisite for the API even existing, so check it
  // first: reporting "unsupported browser" to a Chrome user on http is wrong.
  if (!isSecure) {
    return {
      supported: false,
      blocker: 'insecure-context',
      secureContext: false,
      browser,
      advice:
        'Web Serial is only available over HTTPS. Open this page at its https:// address ' +
        '(localhost also counts as secure during development).',
    }
  }

  return {
    supported: false,
    blocker: 'unsupported-browser',
    secureContext: true,
    browser,
    advice:
      browser === 'Safari'
        ? 'Safari does not implement Web Serial on any platform. Use Chrome, Edge, or Firefox 151+ on a desktop computer.'
        : `${browser} does not expose the Web Serial API. Use Chrome 89+, Edge 89+, or Firefox 151+ on a desktop computer. ` +
          'Mobile browsers are not supported.',
  }
}
