// SPDX-License-Identifier: GPL-3.0-or-later
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { StatusBar, Style } from '@capacitor/status-bar'
import { KeepAwake } from '@capacitor-community/keep-awake'
import { assertFetchable } from '#core/platform/fetchable.js'
import type { ShellBridge } from '#core/platform/shell.js'

/**
 * What the mobile shell puts on `window.boofwang`.
 *
 * The counterpart of `electron/preload.cjs`, and the same division of labour:
 * this file announces the host and exposes the few privileged things the page
 * cannot do for itself. `app/mobile/` is the one directory in `app/` that
 * imports `@capacitor/*`, and it is not auto-imported - the Nuxt plugin that
 * calls `installMobileBridge` loads it lazily, only when the Capacitor
 * runtime has injected itself, so a browser or the desktop build never
 * downloads a byte of it. A test holds that line.
 *
 * Transports are not here. They live in `bluetooth.ts` and `serial.ts` beside
 * this file and are reached through the same `SerialPortLike` seam the
 * browser paths end in.
 */

/** Set once by `installMobileBridge`, from the build the page is running. */
let userAgent = 'boofwang (+https://boofwa.ng)'

/**
 * Fetch a JSON document from anywhere, through the native HTTP stack.
 *
 * This is `crossOriginFetch`. hearham and RadioID send no
 * `Access-Control-Allow-Origin`, so the WebView cannot read them at any price;
 * a native request has no origin to be refused. https only, decided by the
 * same rule the desktop shell applies, so a plugin cannot be talked into
 * fetching a file:// path.
 */
async function fetchJson(url: string): Promise<unknown> {
  const target = assertFetchable(url)
  const res = await CapacitorHttp.get({
    url: target.toString(),
    headers: { accept: 'application/json', 'user-agent': userAgent },
    responseType: 'json',
  })
  if (res.status < 200 || res.status >= 300) throw new Error(`${target.host} answered ${res.status}.`)
  return res.data as unknown
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

/**
 * Hand the person a file.
 *
 * Written to the app's Documents folder first, then offered through the share
 * sheet. Two steps rather than one because they fail differently: on iOS the
 * sheet always offers "Save to Files", but on Android the targets are whatever
 * apps registered, and a phone without Drive may have no filesystem target at
 * all. A file that already exists in Documents survives a dismissed sheet,
 * which is why the toast names the folder rather than claiming a share.
 *
 * Documents is invisible in the iOS Files app until `UIFileSharingEnabled`
 * and `LSSupportsOpeningDocumentsInPlace` are set; both are, in Info.plist.
 * The fallback to the cache directory is for Android 10, where the public
 * Documents folder needs a legacy storage flag this app does not set.
 */
async function saveFile(data: Uint8Array | string, filename: string, _mime: string): Promise<boolean> {
  const path = `boofwang/${filename}`
  const body = typeof data === 'string' ? { data, encoding: Encoding.UTF8 } : { data: toBase64(data) }

  let uri: string
  try {
    const written = await Filesystem.writeFile({ path, directory: Directory.Documents, recursive: true, ...body })
    uri = written.uri
  } catch {
    const written = await Filesystem.writeFile({ path, directory: Directory.Cache, recursive: true, ...body })
    uri = written.uri
  }

  try {
    await Share.share({ title: filename, files: [uri] })
  } catch {
    // A dismissed sheet is not a failed save; the file is already on disk.
    // Whether the sheet was also unavailable (no share targets) is something
    // the platform does not distinguish, and the toast says where the file is.
  }
  return true
}

/**
 * Keep the screen on while a transfer runs.
 *
 * The screen locking is the ordinary way an app is backgrounded in the middle
 * of a thirty-second read, and both OSes freeze the WebView's JavaScript a
 * few seconds after that - timers, streams and the transport with them. This
 * cannot make a transfer survive a deliberate switch to another app; it stops
 * the accidental case.
 */
async function keepAwake(on: boolean): Promise<void> {
  try {
    if (on) await KeepAwake.keepAwake()
    else await KeepAwake.allowSleep()
  } catch {
    // Not supported on this device. A read still works; it just needs the
    // person to keep the screen on themselves, and the reading card says so.
  }
}

/**
 * Paint the status bar from the same tokens as the page.
 *
 * The two hexes are `--bg` in app/assets/css/main.css and the manifest's
 * `theme_color`; test/app/offline-install.spec.ts holds the three together.
 */
export async function applyStatusBar(dark: boolean): Promise<void> {
  try {
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light })
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setBackgroundColor({ color: dark ? '#141A22' : '#F2F5F8' })
    }
  } catch {
    // No status bar to paint (an iPad in a multitasking window, say).
  }
}

/** Fires when the app moves between foreground and background. */
export function onAppStateChange(cb: (active: boolean) => void): () => void {
  const handle = App.addListener('appStateChange', ({ isActive }) => cb(isActive))
  return () => {
    void handle.then((h) => h.remove())
  }
}

/**
 * Hold the Android back button.
 *
 * Capacitor's default with no listener is WebView history back, and exit at
 * the root. A stray press during a write would navigate away from the page
 * driving the transfer; while one runs the button does nothing at all.
 */
export function holdBackButton(): () => void {
  const handle = App.addListener('backButton', () => {})
  return () => {
    void handle.then((h) => h.remove())
  }
}

/**
 * Install the bridge. Called once, before any page mounts.
 *
 * `mobile` is the fact `detectHost` reads; everything else is a capability
 * the page asks for by name. Fails closed: a platform that is neither Android
 * nor iOS installs nothing, and the page runs as a browser.
 */
export function installMobileBridge(build: { version: string }): ShellBridge | null {
  const platform = Capacitor.getPlatform()
  if (platform !== 'android' && platform !== 'ios') return null
  userAgent = `boofwang/${build.version} (+https://boofwa.ng)`

  const bridge: ShellBridge = {
    mobile: platform,
    fetchJson,
    saveFile,
    keepAwake,
    bluetoothProbe: async () => (await import('./bluetooth')).nativeBluetoothProbe(),
  }
  ;(window as { boofwang?: ShellBridge }).boofwang = bridge
  return bridge
}
