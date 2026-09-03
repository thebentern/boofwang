# The mobile apps

boofwang runs on Android and iOS as the same static site the desktop build
wraps, loaded into a WebView by [Capacitor](https://capacitorjs.com). This
document is what the apps are and are not, how to build and sign them, and
what has actually been exercised on a phone. The last part is the important
one, and it is kept honest in the same way the protocol notes are: a claim
goes in only once it has been done, with the numbers.

## What the apps are

The site is bundled. There is no service worker and no update check: the
build in the app is the build the store delivered, the About page says so, and
the footer names the commit as it does everywhere else.

Transports are the shell's, not the WebView's. No mobile WebView has Web
Serial and only Android's has Web Bluetooth, so the cable and the Bluetooth
radio arrive through native plugins. Both end in the same `SerialPortLike`
seam the browser paths end in (`lib/transport/transport.ts`), which is what
lets every driver, codec, the write gate and every screen run unchanged. The
adapters are `lib/transport/native-serial-port.ts` and
`lib/transport/native-gatt.ts`; the plugins are reached only from
`app/mobile/`, and a test holds that line.

| | Android | iOS |
|---|---|---|
| USB serial (OTG cable) | yes, an in-repo plugin over `usb-serial-for-android` | no. An iPhone cannot drive a USB serial adapter. |
| Bluetooth LE | yes, `@capacitor-community/bluetooth-le` | yes, the same plugin |
| Writes over Bluetooth | the [UV-5R Mini](protocols/uv5rmini.md), which has taken one. Nothing behind a dongle. | the same |

That last row matters for iOS, because Bluetooth is the only carrier there: the
UV-5R Mini is the one radio an iPhone or iPad can write, and the four reachable
only through a clip-on dongle stay read-only on this platform until one of them
has survived a write over that link. A store listing must not say more.

Everything in the risk register applies unchanged. A write is never one click
from idle, a backup precedes every write, and the typed confirmation is the
same token on a phone keyboard.

## Building and running

Prerequisites: the repository's usual Node and pnpm, plus Android Studio (or
the command-line SDK with a JDK 21) for Android and Xcode for iOS. CocoaPods
is not needed: the iOS project uses Swift Package Manager.

```bash
pnpm mobile:site           # nuxt generate at base URL /, no service worker
pnpm mobile:sync           # ...and copy it into both native projects
pnpm mobile:open:android   # Android Studio
pnpm mobile:open:ios       # Xcode
```

`pnpm mobile:android` and `pnpm mobile:ios` sync and then `cap run`, which
picks a connected device or an emulator.

If `xcodebuild` complains that the active developer directory is the command
line tools, point one command at Xcode rather than changing the system
setting:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer pnpm mobile:ios
```

Xcode 26 ships the iOS SDK but not the platform runtime the build needs, and
`xcodebuild` then reports every destination as ineligible with "iOS 26.5 is
not installed". Install it once from Xcode, Settings, Components, or with
`xcodebuild -downloadPlatform iOS`; it is several gigabytes. The CI runner's
Xcode has it already.

The first `xcodebuild … build` on a fresh checkout also has to clone the two
remote Swift packages, and it gives no sign that it is doing so: the run sat
for thirteen minutes having used two seconds of CPU and written nothing to
DerivedData. Resolving them as their own step first says what is happening
and makes the build that follows ordinary.

```bash
xcodebuild -project App.xcodeproj -scheme App -resolvePackageDependencies
```

And if `xcodebuild -exportArchive` says only `error: exportArchive Copy
failed`, look at your `PATH` before you look at your certificates. Xcode's
last step shells out to `rsync -E` to build the `.ipa`, Apple's `/usr/bin/rsync`
accepts that, and Homebrew's does not:

```
rsync: on remote machine: --extended-attributes: unknown option
```

That line is in `IDEDistributionPipeline.log` inside the `.xcdistributionlogs`
bundle the failure names, and nowhere else. Exporting with `PATH=/usr/bin:/bin`
is enough. CI is unaffected, having no Homebrew rsync ahead of Apple's.

### What the two projects have compiled as

Both, on a Mac, on 2 September 2026. This is the toolchain check, not a
hardware one; the table at the end of this document is still empty.

| | Android | iOS |
|---|---|---|
| Toolchain | JDK 21.0.10, Android Studio's JBR, compileSdk 36 | Xcode 26.6 (17F113), iOS SDK 26.5 |
| Command | `./gradlew assembleDebug -PversionName=0.0.0-local -PversionCode=1` | `xcodebuild -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` |
| Result | 305 tasks in 59 s, a 5,655,399 byte `app-debug.apk` | `BUILD SUCCEEDED`, `App.app` |
| Contents | `ng/boofwa/usbserial/UsbSerialPlugin` and `com/hoho/android/usbserial`, by `dexdump` over every `classes*.dex` | all six plugin classes in the binary, by `nm`, and the site under `public/` |

The Java had never been compiled and was expected to need work. Checked
against the 3.9.0 API jar it did not: `setDTR`, `setRTS`, `write`,
`setParameters`, `SerialInputOutputManager`'s two-argument constructor,
`start`, `stop` and the `Listener`'s `onNewData(byte[])` and
`onRunError(Exception)` all match as written. One thing was wrong, and it was
Gradle rather than Java - the app project could not see JitPack, so it could
not resolve the library the plugin module compiles against.

The iOS app has been installed on an iPhone 17 Pro simulator running iOS 26.5
and launched. It renders, and the connect page correctly says Bluetooth is the
way in on this device, so host detection works under `capacitor://localhost`.
A simulator has no Bluetooth and no USB, so this is not S1 and fills in
nothing below.

**Live reload is not committed.** Capacitor can point the WebView at the dev
server (`server.url` in `capacitor.config.ts`) so edits appear without a
sync. That turns off the local server and with it the secure context, so
`crypto.subtle` disappears and every write is blocked. Use it for interface
work, never for a transport, and never commit it.

The Android project is committed, as Capacitor intends, minus what `cap sync`
regenerates (the copied site under `app/src/main/assets/public/`). The same
for iOS. `.gitignore` lists the exclusions; `test/app/mobile-config.spec.ts`
checks that it does.

## The device list

A native app has no `requestDevice` dialogue. The scan results come to the
page and the page draws them (`app/components/connect/BluetoothScanList.vue`).
The scan runs with no native filter, because CoreBluetooth cannot filter by
name and whether the UV-5R Mini advertises its service is still recorded as
unverified; rows are matched in JavaScript with the same OR semantics the
browser's chooser applies. "Show every device" reveals the rest. The field
under it is the `?ble=service,write,notify` override with a different entry
point, for a phone with no address bar.

One scan per opening: Android allows five scan starts per thirty seconds.

## Backgrounding

Both operating systems freeze the WebView's JavaScript a few seconds after
the app leaves the foreground. Timers, streams and the transport freeze with
it. Nothing in the app can make a request/response protocol with
three-second timeouts survive that, and the iOS `bluetooth-central`
background mode is deliberately not claimed, because it would not either.

What the app does instead: keeps the screen on while a transfer runs, holds
the Android back button, and when the app is backgrounded anyway marks the
transfer interrupted rather than cancelling it (a cancel poisons the
transport; a notification shade pulled down may have cost nothing). A failure
that follows is then blamed on the interruption, not on the radio. The
reading card says to keep boofwang in front until it finishes.

## Signing

Key material never enters the repository. Everything below is a GitHub
Actions secret, decoded outside the workspace, exactly as `docs/signing.md`
does for the desktop builds.

### Android

Create a keystore once and keep it: Play will not accept an update signed
with a different key.

```bash
keytool -genkeypair -v -keystore boofwang-release.keystore -alias boofwang \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -i boofwang-release.keystore | pbcopy
```

Secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. With them a tag produces a
signed `.apk` attached to the release and an `.aab` on the run for Play;
without them the run says so and produces a debug APK only.

The version comes from the build, never from a literal in Gradle:
`versionName` is `package.json`'s version and `versionCode` is the run
number, both passed in by the workflow. That is the same rule `release.yml`
applies to artifact names.

### iOS

The team is `6YF6QJH524`, `O=Benjamin Meadors` - the individual one, the same
team the desktop builds are signed and notarised with. It is written down in
two places rather than left to whatever Xcode has selected: `DEVELOPMENT_TEAM`
in the App target's Debug and Release configurations, and `teamID` in
`mobile/ExportOptions.plist`. The account belongs to more than one team, and
`docs/signing.md` says what picking the other costs - an employer's name on
the app and one of their slots spent. An unset team is how that happens by
accident.

The certificate is an **Apple Distribution** identity, not the Developer ID
one the desktop build is notarised with; `docs/signing.md` records how much
time the wrong certificate type cost once already. You need:

- an App ID `ng.boofwa.app` in the developer portal,
- an App Store provisioning profile for it, named `boofwang` (the name is
  what `mobile/ExportOptions.plist` refers to),
- the Apple Distribution certificate exported as a `.p12`.

Secrets: `IOS_DIST_CERT_P12` (base64), `IOS_DIST_CERT_PASSWORD`,
`IOS_PROVISIONING_PROFILE_BASE64`. With them a tag produces an `.ipa` on the
run, exported for App Store Connect; uploading it to TestFlight is a manual
step until the App Store Connect key's role has been confirmed sufficient
for `altool`, which has not been tried. Without them the run builds the
project for the simulator, which is the check a pull request gets.

#### Putting a build on your own iPhone or iPad

None of the release machinery above is involved. A development build needs an
Apple Development certificate and a profile for `ng.boofwa.app` carrying the
device's identifier, and Xcode makes all three itself the first time, but only
for an Apple ID it is signed in as. With none it stops at:

```
error: No Accounts: Add a new account in Accounts settings.
```

So: Xcode, Settings, Accounts, add the Apple ID that owns team `6YF6QJH524`,
then let the build create what is missing.

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project mobile/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates build
```

That registers the App ID `ng.boofwa.app` in the portal if it is not there
already, which is a change to the account and not only to this checkout. It
lands under `6YF6QJH524` because the target names the team; without that it
would land under whichever team the signed-in account offers first.

The device also has to be paired and in Developer Mode - `xcrun devicectl list
devices` says `available (paired)` when it is, and `unavailable` when the
cable is out, the phone is locked or Developer Mode is off.

## The licence question

boofwang is GPL-3.0-or-later and its drivers transcribe offsets from CHIRP,
whose authors have not agreed to Apple's App Store terms. Those terms have
been read as incompatible with the GPL since VLC was removed from the store
in 2011. A sole copyright holder can grant an exception for their own code;
the CHIRP-derived parts are the contested case. This is not resolved here.
The options are TestFlight and ad-hoc distribution only for iOS, asking the
relevant CHIRP authors for an exception, and Google Play and F-Droid on
Android, where there is no equivalent problem. Nothing in the build is gated
on it; the App Store upload is where it stops being theoretical.

## What has been verified

Nothing yet. Every row below is empty until it is not, and a row is filled
in only with the date, the device and OS version, the adapter's `vid:pid`
where there is one, the bytes on the wire, the elapsed time, and a sha256
compared against a read of the same radio taken the same day by the web
build in desktop Chrome. A write records the backup, the change, the
read-back and the restore to the original sha256. The full entry lives in
the radio's own protocol note; this table points at it.

| # | Platform | Radio | Carrier | Scope | Result |
|---|---|---|---|---|---|
| S1 | Android | none | none | secure context, `sha256Hex`, timer path, cold-load of `/channels`, external links, back button, file open and save, IndexedDB after a force-quit | part, 2026-09-02, Pixel 8 Pro, Android 17, WebView 151.0.7922.199. Secure context, `sha256Hex`, timer path, cold-load and IndexedDB after a force-quit all pass. **The back button does nothing.** External links, file open and save not run. [Below](#s1-on-two-real-devices) |
| S1 | iOS | none | none | the same | part, 2026-09-02, iPad Pro 11-inch (M4), iPadOS 26. Secure context, `sha256Hex`, timer path and IndexedDB pass. Cold-load, external links, file open and save, Files app not run. [Below](#s1-on-two-real-devices) |
| A1 | Android | UV-K5 | USB | read, write, restore | not run |
| A2 | Android | UV-82 | USB | read, write, restore | not run |
| A3 | Android | UV-5R Mini | USB | read, write, restore | not run |
| A4 | Android | DM-32UV | USB | read, write, restore | not run |
| A5-A8 | Android | UV-5R Mini | CH340, PL2303, CP210x, FTDI | read | not run |
| A9 | Android | DM-32UV | USB | close-as-reset and `REOPEN_SETTLE_MS` | not run |
| A10 | Android | UV-5R Mini | own Bluetooth module | read; write refused at the gate | not run |
| A11 | Android | UV-5R Mini | BT-A1D dongle | read | not run |
| I1 | iOS | UV-5R Mini | own Bluetooth module | read; write refused at the gate | not run |
| I2 | iOS | UV-5R Mini | BT-A1D dongle | read | not run |
| B1 | Android | UV-K5 | USB | backgrounded at about half of a read | not run |
| B2 | Android | UV-5R Mini | Bluetooth | backgrounded at about half of a read | not run |
| B3 | iOS | UV-5R Mini | Bluetooth | backgrounded at about half of a read | not run |
| B4 | either | UV-K5 | USB | backgrounded mid-write, only after B1, with a restorable backup | not run |
| W1 | bench, BLE bridge | UV-5R Mini | own module | one-field write, read back, restore | not run |
| W2 | Android | UV-5R Mini | own module | the same, through the app | not run |
| W3 | iOS | UV-5R Mini | own module | the same, through the app | not run |

Three items are known unknowns rather than untried checks, and each has a
tell:

- **DTR and RTS at open, on Android.** What `usb-serial-for-android`'s
  drivers do to the control lines inside `open()` differs by chipset and by
  library version. The plugin deasserts both immediately after open, but a
  UV-K5 that reboots when the port opens is the sign that the driver asserted
  one first, and the fix is in the plugin, not the radio.
- **The DM-32UV's exit from programming mode.** On a desktop the port close is
  what resets it, and it needs a fresh port after 3.2 s. What the plugin's
  close does to the lines is unverified. If a second `PSEARCH` in the same
  app session gets silence or `0x90`, try in order a buffer purge, an FTDI
  reset and a DTR pulse on close, and record which the radio needed in
  `protocols/dm32uv.md`. Until then: reads, second session unverified.
- ~~**The blob-URL timer worker under `capacitor://localhost`.**~~ Answered on
  both real devices: it does not fall back, and warm it costs nothing. See
  [S1 on two real devices](#s1-on-two-real-devices).

## S1 on two real devices

A phone and a tablet, 2 September 2026. Neither had a radio attached, so this
is the part of S1 that a radio is not needed for; the rest of the row says
what was left.

| | Pixel 8 Pro | iPad Pro 11-inch (M4) |
|---|---|---|
| OS | Android 17, build `CP2A.260805.005`, WebView 151.0.7922.199 | iPadOS 26 |
| Origin | `https://localhost/` | `capacitor://localhost` |
| `isSecureContext` | true | true |
| `sha256Hex`'s digest of no bytes | `e3b0c442…b7852b855`, correct | the same, correct |
| User agent carries `boofwang-mobile` | yes | not checked |
| Timer path taken | worker | worker |
| Worker start plus first 10 ms sleep | 26 ms | 22 ms |
| Warm 10 ms sleep, median of 8 | 11 ms | 13 ms |
| Warm 10 ms sleep, worst of 8 | 12 ms | 47 ms |
| Plain `setTimeout(10)`, median of 8 | 11 ms | 11 ms |
| Cold load of `/channels` after a forced reload | renders, "No codeplug open" | not run |
| IndexedDB after a force-quit | value written before the kill read back after it | not run |

The write path is clear on both. The blob-URL worker is real on both, and the
emulator's warning about its cost was the emulator's, not the platform's: on
the Pixel a warm 10 ms sleep through the worker is 11 ms against 11 ms plain,
and the 420 ms first round trip an emulator showed is 26 ms here. The
DM-32UV's 10 ms steps are not being stretched by this.

### The Android back button does nothing

At `/channels` with two entries of history, `KEYCODE_BACK` neither took the
WebView back nor left the page. At `/`, it did not exit the app either. The
activity stayed resumed both times, so the key is arriving and being swallowed
rather than missing the app.

The manifest does not set `android:enableOnBackInvokedCallback`, and the app
targets SDK 36, where the platform default is the predictive-back callback and
not the legacy `onBackPressed`. That is the first place to look, but it is a
hypothesis and not a diagnosis.

One caveat that has to travel with this: the presses were `adb shell input
keyevent 4`, and a synthesised key is not a swipe. Predictive back is gesture
driven and the two paths are not identical, so **this needs one confirmation
by hand** - swipe back in the app on a real phone - before it is treated as a
defect rather than as an artefact of how it was tested.

Not run on either device: external links opening in the system browser,
opening a `.bwp` through the file picker, saving one to Documents, and on iOS
whether the Files app shows the boofwang folder.

## What the WebViews answered

The same questions, asked first on a simulator and an emulator before either
real device was to hand. Kept because the comparison is the useful part: it
is where the claim that the timer worker costs more than it saves came from,
and the section above is where a real device withdrew it. Neither of these
fills in a row.

Measured 2 September 2026: an iPhone 17 Pro simulator on iOS 26.5, and the
`Medium_Phone_API_36.0` emulator, `sdk_gphone64_arm64`, API 36.

| | iOS 26.5 simulator | Android API 36 emulator |
|---|---|---|
| Origin | `capacitor://localhost` | `https://localhost/` |
| `isSecureContext` | true | true |
| `crypto.subtle` | present | present |
| `sha256Hex`'s digest of no bytes | `e3b0c442…b7852b855`, correct | the same, correct |
| `Worker` from a `blob:` URL | created, `blob:capacitor:` | created, `blob:https:` |
| Timer path taken | worker | worker |
| Worker start plus first 10 ms sleep | 33 ms | 420 ms |
| Warm 10 ms sleep, median of 8 | 13 ms | 25 ms |
| Warm 10 ms sleep, worst of 8 | 60 ms | 92 ms |
| Plain `setTimeout(10)`, median of 8 | 11 ms | 15 ms |
| `indexedDB.open` | opened | opened |

Three things follow.

The write path is not blocked. A local origin is a secure context under both
schemes, `crypto.subtle` is there, and the primitive `sha256Hex` is built on
returns the right answer for a known input.

The worker is real, not the silent fallback. A `blob:` URL inherits the custom
scheme on both platforms and `new Worker` accepts it, which was the open
question.

And in the foreground the worker costs more than it saves: 25 ms against 15 ms
on Android, 13 ms against 11 ms on iOS. That is not an argument for removing
it - it earns its place in a hidden browser tab, which is what it was written
for. That reading did not survive hardware: on a Pixel 8 Pro the same
measurement is 11 ms against 11 ms, and the 420 ms first round trip is 26 ms.
The lesson is about emulators rather than about the plugin - a 10 ms timer
measured on emulated hardware says almost nothing about a 10 ms timer, and
the DM-32UV's programming-mode entry is exactly the thing that would have
been misjudged from it.

One other thing the emulator showed: the Android app asks for the nearby-devices
permission as soon as it launches, before anyone has asked to connect to
anything. The iOS app does not. Worth deciding whether that is wanted.
