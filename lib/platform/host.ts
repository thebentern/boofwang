// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What kind of host boofwang is running in, and what that host can do.
 *
 * boofwang ships as a web app, as a desktop shell and as a mobile shell from
 * one codebase. The difference between them is expressed here, once, as
 * capabilities rather than as a build flag - so that a feature declares what it
 * *needs* instead of which build it belongs to. Nothing else in the codebase
 * should branch on which host it is running in; it should ask whether the
 * capability it wants is present.
 *
 * Kept DOM-free like the rest of `lib/platform/`, so the reasoning is testable
 * without a browser and cannot drift into a component.
 */

export type HostKind = 'browser' | 'desktop' | 'android' | 'ios'

export interface HostCapabilities {
  /**
   * Whether an arbitrary cross-origin HTTP request will succeed.
   *
   * False in a browser for any host that sends no `Access-Control-Allow-Origin`.
   * This is the only capability that gates a data source today, and it gates
   * exactly two of them - most of what boofwang reads is either CORS-open or
   * comes from a file the user exported themselves.
   */
  readonly crossOriginFetch: boolean
  /**
   * Whether backups can be written to a directory chosen by the user, through a
   * privileged process rather than through the browser's storage.
   *
   * The browser build reaches the same outcome by a different route - a
   * persisted `FileSystemDirectoryHandle` - so this being false does not mean
   * backups are less durable there.
   */
  readonly fileVault: boolean
  /**
   * Whether outbound requests can carry a `User-Agent` we choose.
   *
   * Browsers forbid setting it. No source currently in the registry requires
   * one: the requirement belonged to RepeaterBook, which is excluded on licence
   * grounds. Declared because the shell has the capability, not because
   * anything needs it - see `docs/provenance.md`.
   */
  readonly customUserAgent: boolean
  /**
   * Whether the shell supplies serial ports itself, through a native plugin,
   * rather than the page reaching `navigator.serial`.
   *
   * A WebView has no Web Serial, so on a phone the only route to a cable is
   * the shell's own. False in a browser and in the desktop shell, where the
   * page still goes through the Web API and the shell only answers the picker.
   */
  readonly nativeSerial: boolean
  /**
   * Whether the shell supplies Bluetooth links itself, likewise.
   *
   * This is what makes an iPhone reachable at all: no browser there has Web
   * Bluetooth, but the native stack does, and the shell lends it to the page.
   */
  readonly nativeBluetooth: boolean
  /**
   * Whether the operating system can present a USB serial device at all.
   *
   * False on an iPhone or iPad, which have no USB host stack a programming
   * cable can attach to. That is a fact about the hardware, not about any
   * browser or plugin, and the advice has to say so rather than suggest one.
   */
  readonly usbHost: boolean
  /**
   * Whether `window.print()` reaches a printer.
   *
   * False in both mobile WebViews, where the call is a no-op that neither
   * prints nor reports that it did not. A print control offered there is a
   * button that does nothing, which is worse than no button.
   */
  readonly print: boolean
  /**
   * Whether files leave through a share sheet rather than a download.
   *
   * A WebView has no downloads folder to speak of; the OS way to hand a file
   * on is the share sheet, which is what the mobile shell's `saveFile` opens.
   */
  readonly shareSheet: boolean
}

export type HostCapability = keyof HostCapabilities

const BROWSER: HostCapabilities = {
  crossOriginFetch: false,
  fileVault: false,
  customUserAgent: false,
  nativeSerial: false,
  nativeBluetooth: false,
  usbHost: true,
  print: true,
  shareSheet: false,
}

const DESKTOP: HostCapabilities = {
  crossOriginFetch: true,
  fileVault: true,
  customUserAgent: true,
  nativeSerial: false,
  nativeBluetooth: false,
  usbHost: true,
  print: true,
  shareSheet: false,
}

const ANDROID: HostCapabilities = {
  crossOriginFetch: true,
  fileVault: false,
  customUserAgent: true,
  nativeSerial: true,
  nativeBluetooth: true,
  usbHost: true,
  print: false,
  shareSheet: true,
}

const IOS: HostCapabilities = {
  crossOriginFetch: true,
  fileVault: false,
  customUserAgent: true,
  nativeSerial: false,
  nativeBluetooth: true,
  usbHost: false,
  print: false,
  shareSheet: true,
}

export function capabilitiesFor(host: HostKind): HostCapabilities {
  switch (host) {
    case 'desktop':
      return DESKTOP
    case 'android':
      return ANDROID
    case 'ios':
      return IOS
    default:
      return BROWSER
  }
}

/** Whether `host` can satisfy every capability in `needs`. */
export function hostSupports(host: HostKind, needs: readonly HostCapability[]): boolean {
  const caps = capabilitiesFor(host)
  return needs.every((n) => caps[n])
}

/**
 * Whether the shell, not the page, owns the transports.
 *
 * True for both mobile shells: there the Web APIs are absent and the link to
 * the radio arrives through a plugin. The support gates ask this before they
 * look at anything the browser can tell them, because inside a WebView every
 * one of those answers describes the wrong program.
 */
export function shellProvidesTransports(host: HostKind): boolean {
  return host === 'android' || host === 'ios'
}

/**
 * What to call the host in guidance copy, when it is not a browser.
 *
 * Exists so that copy never says "Chrome is showing its own port list" inside
 * a WebView. The Android WebView's user agent contains `Chrome/` and the iOS
 * one contains `Safari/`, so `detectBrowser` names a browser that is not
 * running, and the person reading it is looking at an app icon. Null for the
 * browser and desktop hosts, where the browser's own name is the right one.
 */
export function hostLabel(host: HostKind): string | null {
  switch (host) {
    case 'android':
      return 'Android'
    case 'ios':
      return 'iOS'
    default:
      return null
  }
}

/**
 * Read the host kind from whatever the shell injected, failing closed.
 *
 * Anything other than the exact shape the shells promise resolves to
 * `'browser'`, the least capable answer. A missing preload, a partially
 * initialised bridge and a page opened in an ordinary tab are indistinguishable
 * from here and must all take the same path: a bug that guesses `'desktop'`
 * would offer a control that cannot work, which is worse than offering nothing.
 *
 * `desktop` is read first. The Electron preload never writes `mobile` and the
 * mobile plugin never writes `desktop`, so an object carrying both was made by
 * neither of them; when one does turn up, the desktop answer is the one whose
 * transports still go through the Web APIs, which is the safer of the two
 * shells to be mistaken for.
 */
export function detectHost(injected: unknown): HostKind {
  if (typeof injected !== 'object' || injected === null) return 'browser'
  const bridge = injected as { desktop?: unknown; mobile?: unknown }
  if (bridge.desktop === true) return 'desktop'
  if (bridge.mobile === 'android') return 'android'
  if (bridge.mobile === 'ios') return 'ios'
  return 'browser'
}
