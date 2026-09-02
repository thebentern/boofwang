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
 * that disagrees with the plugin's initialisation means a scan that returns
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
    // The legacy trio is capped, so a modern device is not asked for a
    // location grant it does not need.
    for (const legacy of ['BLUETOOTH"', 'BLUETOOTH_ADMIN"', 'ACCESS_FINE_LOCATION"']) {
      expect(manifest).toMatch(new RegExp(`${legacy}\\s+android:maxSdkVersion="30"`))
    }
    expect(manifest).toMatch(/bluetooth_le"\s+android:required="false"/)
  })

  it('agrees with the plugin about location: both say never', () => {
    // Android 12+ returns no scan results, silently, when these disagree.
    expect(bluetooth).toContain('androidNeverForLocation: true')
  })

  it('refuses cleartext traffic', () => {
    expect(manifest).toContain('android:usesCleartextTraffic="false"')
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

