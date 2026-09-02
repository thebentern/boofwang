// SPDX-License-Identifier: GPL-3.0-or-later
import { detectBrowser, type NavigatorLike } from './browser.js'
import { shellProvidesTransports, type HostKind } from './host.js'

/**
 * Whether boofwang can keep a copy of itself here, and why not if it cannot.
 *
 * The shape mirrors `serial-support.ts` and `bluetooth-support.ts`, for the
 * same reason: the interesting part is not the boolean, it is being able to say
 * something true about *this* machine when the answer is no. Five reasons, and
 * four of them are not faults:
 *
 *   the desktop shell   already an installed application, updated through
 *                       GitHub releases. A cache in front of it would hold one
 *                       release's assets in the profile and go on serving them
 *                       after the application had been replaced, which is an
 *                       offline copy defeating an update - the exact failure
 *                       the whole feature exists to prevent.
 *
 *   the mobile shell    the same reasoning. The assets are bundled into the
 *                       app and updates arrive through the store, so a worker
 *                       would only ever serve a version the store had already
 *                       replaced.
 *
 *   the dev server      deliberate. Defeating the cache on every save is an
 *                       afternoon, and a stale module served to a developer is
 *                       a longer one.
 *
 *   plain http          service workers need a secure context, the same rule
 *                       that governs Web Serial. Nothing to fix in a browser.
 *
 *   no API              the only actual fault, and rare: every engine has had
 *                       service workers for years.
 *
 * The order is load-bearing. The desktop shell registers its scheme as secure
 * and carries Chromium, so every later check passes there and the answer would
 * come back "supported" - which would be true and wrong.
 *
 * Pure, so every combination can be checked without a browser.
 */

export type OfflineBlocker =
  | 'desktop-shell'
  | 'mobile-shell'
  | 'development'
  | 'insecure-context'
  | 'unsupported-browser'
  | 'none'

export interface OfflineSupport {
  supported: boolean
  blocker: OfflineBlocker
  /** Best-effort browser label, for the guidance text only. */
  browser: string
  /**
   * What to tell somebody, or `''` when there is nothing to say.
   *
   * Empty for either shell as well as for the supported case: there the app
   * is already installed and offline, and explaining the absence of a feature
   * somebody already has by another route is noise.
   */
  advice: string
}

export function evaluateOfflineSupport(
  nav: NavigatorLike | undefined,
  isSecure: boolean,
  host: HostKind,
  isDev: boolean,
): OfflineSupport {
  const browser = detectBrowser(nav?.userAgent ?? '')

  if (host === 'desktop') return { supported: false, blocker: 'desktop-shell', browser, advice: '' }
  if (shellProvidesTransports(host)) return { supported: false, blocker: 'mobile-shell', browser, advice: '' }

  if (isDev) {
    return {
      supported: false,
      blocker: 'development',
      browser,
      advice: 'The development server does not register a service worker. Build the site to exercise it.',
    }
  }

  if (!isSecure) {
    return {
      supported: false,
      blocker: 'insecure-context',
      browser,
      advice:
        'Keeping an offline copy needs a secure context, the same rule that governs Web Serial. Open this ' +
        'page at its https:// address.',
    }
  }

  if (nav === undefined || !('serviceWorker' in nav)) {
    return {
      supported: false,
      blocker: 'unsupported-browser',
      browser,
      advice:
        `${browser} does not expose service workers, so boofwang cannot keep a copy of itself here and will ` +
        'need a network to open. Everything it does once open still happens on your device.',
    }
  }

  return { supported: true, blocker: 'none', browser, advice: '' }
}
