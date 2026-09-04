// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KNOWN_BRIDGE_VENDORS } from '#core/transport/usb-bridges.js'

/**
 * The mobile shell's native configuration, checked against the code it serves.
 *
 * Nothing under `mobile/android` or `mobile/ios` is exercised by a unit test,
 * and nothing in the TypeScript can tell when a manifest has drifted. The
 * failures are all silent ones: a vendor id missing from the USB filter means
 * a cable that works only after a permission prompt; a `neverForLocation` flag
 * that disagrees with the plugin's initialization means a scan that returns
 * nothing on Android 12; a missing Bluetooth usage string means an iOS build
 * that is rejected at upload. So the manifests are read as text and held to
 * the tables the rest of the app is built from.
 */

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8')

const manifest = read('mobile/android/app/src/main/AndroidManifest.xml')
const deviceFilter = read('mobile/android/app/src/main/res/xml/device_filter.xml')
const gradle = read('mobile/android/app/build.gradle')
const plist = read('mobile/ios/App/App/Info.plist')
const capacitor = read('capacitor.config.ts')
const gitignore = read('.gitignore')
const pkg = JSON.parse(read('package.json'))
const bluetooth = read('app/mobile/bluetooth.ts')
const pbxproj = read('mobile/ios/App/App.xcodeproj/project.pbxproj')
const nuxtConfig = read('nuxt.config.ts')

describe('the Android USB device filter', () => {
  it('lists exactly the vendors the drivers recognise', () => {
    const listed = [...deviceFilter.matchAll(/vendor-id="(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b)
    const known = Object.keys(KNOWN_BRIDGE_VENDORS)
      .map(Number)
      .sort((a, b) => a - b)
    expect(listed).toEqual(known)
  })

  it('is wired to the activity, so plugging a cable in offers the app', () => {
    expect(manifest).toContain('android.hardware.usb.action.USB_DEVICE_ATTACHED')
    expect(manifest).toContain('android:resource="@xml/device_filter"')
    expect(manifest).toMatch(/usb\.host"\s+android:required="false"/)
  })
})

describe('the Android manifest', () => {
  it('asks for the Bluetooth permissions the plugin needs, and no location', () => {
    expect(manifest).toMatch(/BLUETOOTH_SCAN"\s+android:usesPermissionFlags="neverForLocation"/)
    expect(manifest).toContain('android.permission.BLUETOOTH_CONNECT')
    // The legacy set is capped, so a modern device is not asked for a
    // location grant it does not need.
    for (const legacy of [
      'BLUETOOTH"',
      'BLUETOOTH_ADMIN"',
      'ACCESS_FINE_LOCATION"',
      'ACCESS_COARSE_LOCATION"',
    ]) {
      expect(manifest).toMatch(new RegExp(`${legacy}\\s+android:maxSdkVersion="30"`))
    }
    expect(manifest).toMatch(/bluetooth_le"\s+android:required="false"/)
  })

  it('caps the coarse grant the Bluetooth plugin asks for uncapped', () => {
    /*
     * This one is not about what the app asks for. It is about what a library
     * asks for on the app's behalf.
     *
     * `@capacitor-community/bluetooth-le` declares ACCESS_COARSE_LOCATION with
     * no ceiling, and a permission only the library declares reaches the built
     * app exactly as the library wrote it. So the release APK requested
     * approximate location on every Android version, next to a FINE_LOCATION
     * line that carefully stopped at 11 and a `neverForLocation` flag saying
     * the scan was not about position. Found by reading `aapt2 dump badging`
     * on a signed release build, which is the only place it was visible: every
     * file in this repository looked right.
     *
     * The app therefore declares it too, purely to put the ceiling on. The
     * ceiling is safe because BluetoothLe.kt asks for the location aliases
     * only on its pre-Android-12 branch.
     *
     * What this test cannot see is the merged manifest, so it holds the source
     * line that fixes it. If the plugin ever needs coarse location above 30,
     * this is the assertion that should be argued with.
     */
    expect(manifest).toContain('android.permission.ACCESS_COARSE_LOCATION')
  })

  it('agrees with the plugin about location: both say never', () => {
    // Android 12+ returns no scan results, silently, when these disagree.
    expect(bluetooth).toContain('androidNeverForLocation: true')
  })

  it('refuses cleartext traffic', () => {
    expect(manifest).toContain('android:usesCleartextTraffic="false"')
  })

  it('refuses the system backup, because the privacy policy says these bytes stay put', () => {
    /*
     * Android Auto Backup's default set is shared preferences plus the app's
     * files and databases, and that sweeps up the WebView profile directory
     * where this app's IndexedDB lives - the backups store, so a DM-32UV
     * image with its AES key slots in it. Google's copy is encrypted with the
     * device lock-screen secret, so it was never a plaintext disclosure. It
     * was still a copy off the device that outlives an uninstall, and
     * app/pages/privacy.vue tells people in as many words that neither
     * happens.
     *
     * The page is the promise. If backup is ever wanted, it needs
     * `dataExtractionRules` excluding `app_webview` and a restore onto a
     * second device proving the backups store comes back empty - not an edit
     * to the copy.
     */
    expect(manifest).toContain('android:allowBackup="false"')
  })

  it('marks every piece of hardware optional, so Play offers the app to everyone', () => {
    /*
     * Two of these four are here because of what a permission implies rather
     * than what this file asked for. `aapt2` derives `android.hardware.
     * bluetooth` from BLUETOOTH/BLUETOOTH_ADMIN and `android.hardware.
     * location` from the two location aliases, and an implied feature is
     * REQUIRED unless it is contradicted - so the built app told Play it
     * needed Bluetooth and location hardware, and Play would have hidden it
     * from anything lacking either.
     *
     * Neither was visible in this file or in any test. They were visible in
     * `aapt2 dump badging` on a signed release build, as `uses-implied-
     * feature`, which is worth running before a submission for exactly this
     * reason.
     */
    for (const feature of [
      'android.hardware.usb.host',
      'android.hardware.bluetooth_le',
      'android.hardware.bluetooth',
      'android.hardware.location',
    ]) {
      expect(manifest, `${feature} is not declared optional`).toMatch(
        new RegExp(`${feature.replace(/\./g, '\\.')}"\\s+android:required="false"`),
      )
    }
  })

  it('keeps one activity, so a cable plugged in does not open a second copy', () => {
    expect(manifest).toContain('android:launchMode="singleTask"')
  })
})

describe('the Android build', () => {
  it('takes its version from the build, never from a literal', () => {
    // A release whose Gradle number disagrees with package.json is the
    // failure release.yml's header warns about. CI passes both in.
    expect(gradle).toMatch(/versionCode \(project\.hasProperty\('versionCode'\)/)
    expect(gradle).toMatch(/versionName \(project\.hasProperty\('versionName'\)/)
    expect(gradle).not.toMatch(/versionName\s+"\d/)
  })
})

describe('the iOS Info.plist', () => {
  it('explains Bluetooth in the product’s voice, or the upload is rejected', () => {
    const match = plist.match(/<key>NSBluetoothAlwaysUsageDescription<\/key>\s*<string>([^<]+)<\/string>/)
    expect(match).not.toBeNull()
    expect(match![1]!.length).toBeGreaterThan(20)
    expect(match![1]).toContain('boofwang')
  })

  it('makes the Documents folder visible in Files, so a saved codeplug can be found', () => {
    expect(plist).toMatch(/<key>UIFileSharingEnabled<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>LSSupportsOpeningDocumentsInPlace<\/key>\s*<true\/>/)
  })

  it('claims no background mode', () => {
    // bluetooth-central would not make a request/response protocol with
    // three-second timeouts survive suspension; it would only let the app
    // claim something it cannot do.
    expect(plist).not.toContain('UIBackgroundModes')
  })
})

describe('capacitor.config.ts', () => {
  it('serves the generated site from a secure local origin', () => {
    expect(capacitor).toContain("webDir: '.output/public'")
    expect(capacitor).toContain("androidScheme: 'https'")
    expect(capacitor).toContain("path: 'mobile/android'")
    expect(capacitor).toContain("path: 'mobile/ios'")
  })

  it('does not patch the global fetch', () => {
    expect(capacitor).not.toMatch(/CapacitorHttp:\s*\{\s*enabled:\s*true/)
  })

  it('states a user agent', () => {
    expect(capacitor).toMatch(/appendUserAgent: 'boofwang/)
  })
})

describe('the repository', () => {
  it('ignores the web build copied into the native projects', () => {
    expect(gitignore).toContain('mobile/android/app/src/main/assets/public/')
    expect(gitignore).toContain('mobile/ios/App/App/public/')
    expect(gitignore).toContain('mobile/android/*.keystore')
  })

  it('builds the mobile site without a service worker', () => {
    // The assets are bundled and the store is the update channel. A worker in
    // front of a packaged app is a cache that outlives the app being replaced.
    expect(pkg.scripts['mobile:site']).toBe('pnpm desktop:site')
    expect(pkg.scripts['desktop:site']).not.toContain('build-service-worker')
  })
})

describe('the shell code in app/', () => {
  const appFiles = (dir: string): string[] =>
    readdirSync(fileURLToPath(new URL(dir, root)), { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? appFiles(`${dir}${d.name}/`) : /\.(ts|vue)$/.test(d.name) ? [`${dir}${d.name}`] : [],
    )

  it('imports Capacitor only from app/mobile/', () => {
    // The seam is SerialPortLike and the bridge; a plugin import anywhere
    // else is a second host switch, and the browser build would ship it.
    const offenders = appFiles('app/').filter(
      (f) => !f.startsWith('app/mobile/') && /from '@capacitor|import\('@capacitor/.test(read(f)),
    )
    expect(offenders).toEqual([])
  })

  it('has one anchor download, in useFileSave', () => {
    // The blob-and-anchor save does nothing useful in a WebView. One copy is
    // gated by the bridge; a second copy would not be.
    const anchors = appFiles('app/').filter((f) => /a\.download\s*=/.test(read(f)))
    expect(anchors).toEqual(['app/composables/useFileSave.ts'])
  })
})

/**
 * The iOS floor, in the two places that disagree silently.
 *
 * The Xcode project decides which devices may install the app. The bundler
 * target decides what the JavaScript may assume. When the first is lower than
 * the second the app installs onto a phone it cannot run on and throws before
 * it paints, which reads as a crash on launch and which no simulator on a
 * current iOS reproduces. That is what shipped in 0.1.4: `Object.hasOwn`,
 * `structuredClone`, `findLast` and `at` in the bundle, 15.0 in the project.
 */
describe('the iOS floor', () => {
  it('is the same in the Xcode project and the bundler target', () => {
    const declared = [...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map((m) => m[1]!)
    expect(declared.length).toBeGreaterThan(0)
    expect([...new Set(declared)]).toEqual(['15.4'])
    expect(nuxtConfig).toMatch(/target: 'safari15\.4'/)
  })
})

/**
 * Skipped without a build, like source-gating.spec.ts. The chunk holding the
 * Capacitor runtime may be prefetched - a browser may fetch it idly - but it
 * must never be modulepreloaded, which would execute it in every tab.
 */
const PUBLIC = fileURLToPath(new URL('.output/public', root))
const built = existsSync(`${PUBLIC}/index.html`)

describe.skipIf(!built)('the built bundle', () => {
  it('keeps the Capacitor runtime out of every modulepreloaded chunk', () => {
    const index = readFileSync(`${PUBLIC}/index.html`, 'utf8')
    const preloaded = [...index.matchAll(/rel="modulepreload"[^>]*href="\/_nuxt\/([^"]+)"/g)].map((m) => m[1]!)
    expect(preloaded.length).toBeGreaterThan(0)
    const offenders = preloaded.filter((f) => /registerPlugin\(|CapacitorHttp/.test(readFileSync(`${PUBLIC}/_nuxt/${f}`, 'utf8')))
    expect(offenders).toEqual([])
  })
})

