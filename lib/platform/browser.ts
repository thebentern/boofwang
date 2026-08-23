// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Who is asking, to the extent a user agent string can say.
 *
 * Shared by the Web Serial and Web Bluetooth gates, which need the same answer
 * for the same reason: neither API is universal, and the difference between
 * "this browser cannot" and "*Safari* cannot, and no version ever will" is the
 * difference between a user retrying and a user opening Chrome.
 *
 * Used only to write guidance. Nothing is ever gated on the browser's name -
 * the presence of the API decides that - because sniffing to decide capability
 * is how a tool stops working the week a browser ships the feature.
 */

/**
 * The structural subset of `Navigator` these checks need.
 *
 * Declared rather than pulled from the DOM lib so `lib/` keeps compiling
 * without DOM types - the same reason `SerialPortLike` exists.
 */
export interface NavigatorLike {
  readonly userAgent?: string
  readonly serial?: unknown
  readonly bluetooth?: unknown
  readonly serviceWorker?: unknown
}

export function detectBrowser(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return 'Chrome'
  if (/Chromium\//.test(ua)) return 'Chromium'
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Safari\//.test(ua)) return 'Safari'
  return 'your browser'
}

/**
 * Whether this is an iPhone or iPad, whatever the browser calls itself.
 *
 * Worth its own check for Web Bluetooth specifically. Every iOS browser is
 * WebKit underneath, so "install Chrome" - the advice that fixes this
 * everywhere else - fixes nothing here, and telling an iPhone user to try
 * another browser sends them on a errand that cannot succeed.
 *
 * iPadOS reports a desktop Safari user agent, hence the touch-point test: a Mac
 * has no touch points and an iPad claiming to be one has five.
 */
export function isAppleMobile(ua: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPod|iPad/.test(ua)) return true
  return /Macintosh/.test(ua) && maxTouchPoints > 1
}
