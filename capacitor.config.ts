// SPDX-License-Identifier: GPL-3.0-or-later
import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The mobile shell.
 *
 * The same static site the desktop build wraps, loaded into a WebView from a
 * local origin the platform treats as secure - `https://localhost` on Android,
 * `capacitor://localhost` on iOS. That matters more than it sounds: image
 * hashing, backup matching and therefore every write go through
 * `crypto.subtle`, which does not exist on an insecure origin, and `file://`
 * is one. It is the same reason `electron/main.mjs` registers its own scheme.
 *
 * Transports are the shell's, not the WebView's. Neither WebView has Web
 * Serial and only Android's has Web Bluetooth, so the cable and the radio
 * arrive through native plugins that end in the same `SerialPortLike` the
 * browser paths end in. Nothing above that seam knows which build it is in.
 */
const config: CapacitorConfig = {
  // The desktop build is ng.boofwa.desktop.
  appId: 'ng.boofwa.app',
  appName: 'boofwang',
  // What `pnpm mobile:site` writes: the site with the base URL at `/` and no
  // service worker, because the assets are bundled and the store is the
  // update channel. See lib/platform/offline-support.ts.
  webDir: '.output/public',
  android: { path: 'mobile/android' },
  ios: { path: 'mobile/ios' },
  // A stated user agent, so a directory operator can see who is asking. This
  // backs the `customUserAgent` capability in lib/platform/host.ts.
  appendUserAgent: 'boofwang-mobile',
  server: {
    // The default, stated so nobody has to remember that `http` here would
    // cost the secure context described above.
    androidScheme: 'https',
  },
  /*
   * `plugins.CapacitorHttp.enabled` is deliberately absent. Switching it on
   * patches the global fetch for every request the page makes, the app's own
   * chunk loads included, and its record with those is not clean. The shell
   * exposes an explicit `fetchJson` instead, exactly as the desktop preload
   * does, with the https-only rule enforced in one place.
   */
}

export default config
