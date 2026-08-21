// SPDX-License-Identifier: GPL-3.0-or-later
import { detectBrowser, isAppleMobile, type NavigatorLike } from './browser.js'

/**
 * Whether this browser can reach a radio over Bluetooth, and why not if it cannot.
 *
 * The shape mirrors `serial-support.ts` on purpose, but the answer is narrower
 * and the difference is worth being blunt about rather than softening. Web
 * Serial is now in three desktop engines. Web Bluetooth is in exactly one:
 * Chromium. Firefox declined to implement it and Safari declined to implement
 * it, both on stated privacy grounds rather than as a backlog item, so "try
 * again in a later version" is not honest advice for either. And because every
 * browser on iOS is WebKit underneath, there is no iPhone or iPad on which any
 * browser will do this.
 *
 * The one place this is *wider* than Web Serial is Android, where Chrome has
 * Web Bluetooth and no browser has Web Serial. That is the entire reason the
 * feature is worth having: it is the only way this tool runs on a phone.
 *
 * There is a second failure with no Web Serial equivalent - the browser
 * supports the API and the machine has no Bluetooth radio, or it is switched
 * off. `navigator.bluetooth.getAvailability()` answers that, asynchronously,
 * so the caller passes the answer in rather than this becoming async: it is a
 * pure function so that it can be tested against every combination, which is
 * how the advice strings stay right.
 */

export type BluetoothBlocker = 'unsupported-browser' | 'insecure-context' | 'no-adapter' | 'none'

export interface BluetoothSupport {
  supported: boolean
  blocker: BluetoothBlocker
  secureContext: boolean
  /** Best-effort browser label, for the guidance text only. */
  browser: string
  advice: string
  /**
   * Whether another browser would fix it.
   *
   * False on iOS, where the engine is WebKit whatever the icon says. The connect
   * screen uses this to decide whether offering "use Chrome instead" is help or
   * a wild goose chase.
   */
  anotherBrowserWouldHelp: boolean
}

export interface BluetoothProbe {
  /**
   * What `navigator.bluetooth.getAvailability()` said, or null if it was not
   * asked - which is also what a browser without the method leaves it as.
   */
  adapterAvailable?: boolean | null
  /** `navigator.maxTouchPoints`, which is how an iPad is told from a Mac. */
  maxTouchPoints?: number
}

export function evaluateBluetoothSupport(
  nav: NavigatorLike | undefined,
  isSecure: boolean,
  probe: BluetoothProbe = {},
): BluetoothSupport {
  const ua = nav?.userAgent ?? ''
  const browser = detectBrowser(ua)
  const appleMobile = isAppleMobile(ua, probe.maxTouchPoints ?? 0)
  const hasApi = nav !== undefined && 'bluetooth' in nav

  // A secure context is a prerequisite for the API existing at all, so it is
  // checked first: telling a Chrome user on plain http that their browser is at
  // fault sends them to install a browser they already have.
  if (!isSecure) {
    return {
      supported: false,
      blocker: 'insecure-context',
      secureContext: false,
      browser,
      anotherBrowserWouldHelp: false,
      advice:
        'Web Bluetooth is only available over HTTPS. Open this page at its https:// address ' +
        '(localhost also counts as secure during development).',
    }
  }

  if (!hasApi) {
    return {
      supported: false,
      blocker: 'unsupported-browser',
      secureContext: true,
      browser,
      anotherBrowserWouldHelp: !appleMobile,
      advice: appleMobile
        ? 'No browser on iPhone or iPad can do this. Every iOS browser is Safari underneath, including the ' +
          'ones called Chrome and Firefox, and Apple has not implemented Web Bluetooth in any of them. ' +
          'A programming cable and a desktop computer, or an Android phone, are the ways in.'
        : browser === 'Safari' || browser === 'Firefox'
          ? `${browser} does not implement Web Bluetooth and has said it does not intend to. Use Chrome or ` +
            'Edge, on a desktop computer or on Android.'
          : `${browser} does not expose the Web Bluetooth API. Use Chrome or Edge, on a desktop computer or ` +
            'on Android.',
    }
  }

  // The API is present and the machine has nothing to talk with. Distinct from
  // an unsupported browser because the remedy is a switch, not a download.
  if (probe.adapterAvailable === false) {
    return {
      supported: false,
      blocker: 'no-adapter',
      secureContext: true,
      browser,
      anotherBrowserWouldHelp: false,
      advice:
        `${browser} can use Bluetooth, but this machine reports no Bluetooth adapter. Switch Bluetooth on, ` +
        'or plug in an adapter, and reload the page.',
    }
  }

  return {
    supported: true,
    blocker: 'none',
    secureContext: true,
    browser,
    anotherBrowserWouldHelp: false,
    advice: '',
  }
}
