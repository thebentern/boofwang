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
UV-5R Mini is the one radio an iPhone or iPad can write, and the radios reachable
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
cable is out, the phone is locked or Developer Mode is off. `xcrun xctrace
list devices` is not the same question and will call a perfectly reachable
iPad "Offline"; ask `devicectl`.

Once the profile exists, no account is needed again, and that is worth knowing
because signing into Xcode is the one step in this file nobody can do on
somebody else's behalf. A profile already on the machine can be named
directly, which skips the portal round trip entirely:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project mobile/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=6YF6QJH524 \
  PROVISIONING_PROFILE_SPECIFIER="boofwang development" \
  CODE_SIGN_IDENTITY="Apple Development" build
```

The profile has to carry the device. `ProvisionedDevices` is the list, and it
is worth reading before blaming the certificate:

```bash
security cms -D -i ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/<uuid>.mobileprovision \
  | plutil -p - | grep -A3 ProvisionedDevices
```

Then install and launch without opening Xcode at all:

```bash
xcrun devicectl device install app --device <device-uuid> \
  <derived-data>/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device <device-uuid> \
  --terminate-existing ng.boofwa.app
```

Note that the device UUID `devicectl` wants is its own identifier, not the
hardware UDID in the profile. Both appear in `devicectl list devices`.

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
| S1 | Android | none | none | secure context, `sha256Hex`, timer path, cold-load of `/channels`, external links, back button, file open and save, IndexedDB after a force-quit | part, 2026-09-02, Pixel 8 Pro, Android 17, WebView 151.0.7922.199. Secure context, `sha256Hex`, timer path, cold-load and IndexedDB after a force-quit all pass. External links, file save and file open now pass too. **The back button does nothing.** Opening a *valid* codeplug file not run. [Below](#s1-android-leftovers) |
| S1 | iOS | none | none | the same | part, 2026-09-02, iPad Pro 11-inch (M4), iPadOS 26. Secure context, `sha256Hex`, timer path and IndexedDB pass. Cold-load, external links, file open and save, Files app not run. [Below](#s1-on-two-real-devices) |
| A1 | Android | UV-K5 | USB | read, write, restore | not run |
| A2 | Android | UV-82 | USB | read, write, restore | not run |
| A3 | Android | UV-5R Mini | USB | read, write, restore | not run |
| A4 | Android | DM-32UV | USB | read, write, restore | **pass.** 2026-09-02, Pixel 8 Pro, Android 17, FTDI FT232R `0403:6001`, firmware `DM32.01.01.040`. Read 262,144 bytes in about 35 s, twice byte-identical. One channel renamed, written as 1 block / 4,096 bytes, verified; an independent read found 14 changed bytes, all in that channel's name field, and nothing else in 262,144. Restored from the pre-write backup and read again: sha256 back to `363eecd6dac6f291`, zero bytes different. [Below](#a4-the-dm-32uv-on-a-pixel) |
| A5-A8 | Android | UV-5R Mini | CH340, PL2303, CP210x, FTDI | read | not run |
| A9 | Android | DM-32UV | USB | close-as-reset and `REOPEN_SETTLE_MS` | **pass**, 2026-09-02. Four reads, a write and a restore across one app process, each through the plugin's close and reopen, all answered normally. [Below](#a4-the-dm-32uv-on-a-pixel) |
| A10 | Android | UV-5R Mini | own Bluetooth module | read, write, restore | not run |
| A11 | Android | UV-5R Mini | BT-A1D dongle | read | not run |
| A12 | Android | DM-32UV | USB | key slots: mask, reveal, edit, write, restore | **pass**, 2026-09-02. 22 AES-256 slots. Masked by default, one revealed at a time, editor does not prefill. One slot written: exactly 32 bytes changed, all inside that slot's key field. Restored to sha256 `363eecd6dac6f291`, zero bytes different. [Below](#a12-the-key-slots) |
| I1 | iOS | UV-5R Mini | own Bluetooth module | read, write, restore | not run |
| I2 | iOS | UV-5R Mini | BT-A1D dongle | read | not run |
| B1 | Android | DM-32UV | USB | backgrounded at about half of a read | **did not reproduce**, 2026-09-03, Pixel 8 Pro, Android 17. Four reads backgrounded at blocks 3, 4, 29 and 49 of 59, away up to 58 s, one with the screen off and the device dozing. All four completed, all 262,144 bytes at sha `363eecd6dac6f291`. Keep-awake verified held. [Below](#b1-backgrounding-did-not-break-a-usb-read) |
| B2 | Android | UV-5R Mini | Bluetooth | backgrounded at about half of a read | not run |
| B3 | iOS | UV-5R Mini | Bluetooth | backgrounded at about half of a read | not run |
| B4 | either | UV-K5 | USB | backgrounded mid-write, only after B1, with a restorable backup | not run - **not reachable on this radio**. A DM-32UV restore sends only differing pages, so a safe run (an image identical to the radio) has no write to interrupt, and a long enough one would mean editing somebody's radio substantially. [Below](#b4-why-it-could-not-be-run) |
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
- ~~**The DM-32UV's exit from programming mode.**~~ Answered by A9. Two reads
  in one app process, through the plugin's own close and reopen, returned
  byte-identical images. The second `PSEARCH` was answered normally: no
  silence, no `0x90`, and none of the buffer purge, FTDI reset or DTR pulse
  the fallback list held in reserve was needed.
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

## A4: the DM-32UV on a Pixel

2 September 2026. Pixel 8 Pro, Android 17, boofwang `b588ca9` installed as the
debug app. The radio reached the phone through an FTDI FT232R (`0403:6001`) on
the OTG port, which Android had already granted; the connect card named the
adapter and waited for a radio to be chosen, which is the intended behaviour
and not a defect to work around.

The read: a 200-entry block scan, then 59 blocks, 262,144 bytes, about 35
seconds. That figure comes from a five-second poll, so treat it as 35 s give or
take five, not as a measurement. 45 channels of 4,000 slots, no validation
errors. Firmware `DM32.01.01.040`.

Two reads were taken, the second after the first had closed the port inside the
same app process. They are byte-identical - the same sha256
`363eecd6dac6f291` over all 262,144 bytes - and carry the same `unitHash`
`10ff7f1e1ec5`, so on this radio, on this cable, on this phone the read is
reproducible. That is A9 as well as A4, and it is what retires the worry about
what the plugin's close does to the control lines.

Not done, and it is why A4 says read rather than pass: no read of this radio
was taken the same day by the web build in desktop Chrome, so the Android path
has been shown to agree with itself and not yet with the path it is meant to
match. The radio was on the phone all evening. Nothing was written in this session.

### Four channels stopped being receive-only, and that was on purpose

This is the write half of A4, and it was not run as a test - the owner did it
before any of the above, as ordinary use. What follows is therefore attested
from two images rather than observed: the write session's own block count,
elapsed time and read-back report were never captured, and nothing here should
be read as though they were.

What is attested is the part that matters most. The 19:46 backup is the state
before, the 20:04 and 20:08 reads are the state after, and they differ in
exactly four bytes of 262,144: `0x127D8`, `0x12808`, `0x12838`, `0x12868`.
Those are the `mode` byte at `+0x18` of channel records 42 to 45 in block
`0x12` - `LR DMR`, `AR DMR`, `USA DMR` and `Test DMR` - each `0x1C` to `0x14`,
which is bit 3, `txForbid`, clearing. Four channels the owner meant to make
transmit-capable became transmit-capable, and **not one other byte in the image
moved**.

That is the `encode(doc, base)` invariant holding on real hardware across the
Android plugin: a page-based writer sent whole 4 KiB pages, and everything in
those pages that this codebase has never decoded came back identical, because
it was carried through rather than fabricated. It is the first write boofwang
has made to any radio from a phone that this file records, and it went out on
`b588ca9` - the app was installed at 19:31:48 and the pre-write backup is
19:46, so the build is pinned.

The radio is also demonstrably fine afterwards: it re-reads cleanly, 45
channels of 4,000 slots, no validation errors, and twice in a row to the same
sha256.

The frequencies agree with the intent. All four are RX 443.1250 MHz and TX
448.1250 MHz, one repeater pair at the standard +5 MHz 70 cm offset carrying
four talk groups, inside the 400-480 MHz band this schema marks `txAllowed`. A
repeater channel you cannot key is not a repeater channel.

One thing is worth keeping in view even though nothing was wrong here. Those
four bytes were the *only* difference, and that is simultaneously what a
deliberate receive-only toggle looks like and what an encoder silently
clearing `txForbid` while writing something else would look like, minus the
something else. What separates the two is whether anything else changed, which
is an argument for reading the diff before the token is typed rather than
after, and for taking a byte-level diff of two backups even when nothing is
suspected.

What is still not done: no restore back to the original sha256, and no read of
this radio the same day by the web build in desktop Chrome, which is the
cross-check that would let the read half say pass without qualification.

### The write and restore cycle, driven end to end

Run on 2 September 2026 on the same radio, cable and phone as the read above.
Every step went through the interface, including both typed confirmations: the
gates exist so a person types them, and a test that injects them past the
gate is not a test of the thing.

| Step | What happened |
|---|---|
| Baseline | Read, sha256 `363eecd6dac6f291` |
| Edit | Channel 45 renamed `Test DMR` to `BOOFTEST` |
| Diff | `1 channel change · 0 gains transmit · 0 slots erased · 0 receive-only lost`, `1 block · 4,096 bytes on the wire` |
| Confirm | `WRITE` typed; the send button is disabled until it is |
| Write | `VERIFIED. 1 block written, all read back and matched` |
| Read back | 14 bytes changed in 262,144, all in one page |
| Restore | Pre-write backup, `RESTORE` typed, 200-entry scan then 42 in-scope pages walked |
| Final read | sha256 `363eecd6dac6f291`, **zero bytes different** |

The edit was deliberately a name. It cannot move a frequency, a power level or
`txForbid`, so the worst case for a test on somebody's own radio is a channel
with a silly label, and the diff's own counters confirmed the write carried
none of those: nought gaining transmit, nought receive-only lost.

The read-back is the part worth having. A whole 4,096-byte page went to the
radio and exactly 14 bytes came back different - the rest of channel 45's
record, both neighbouring records, and all 58 other blocks were untouched. That
is `encode(doc, base)` on real hardware over the Android plugin: the page was
patched from the image that was read, not rebuilt, so bytes this codebase has
never decoded survived because they were carried through.

#### Fourteen bytes for an eight-character name

The name is eight characters and fourteen bytes changed, which is worth
writing down rather than rounding off.

```
before  54 65 73 74 20 44 4d 52  00 00 ff ff ff ff ff ff   "Test DMR" 00 00 then six FF
after   42 4f 4f 46 54 45 53 54  00 00 00 00 00 00 00 00   "BOOFTEST" then eight 00
```

Eight name bytes, and six padding bytes normalised from `0xFF` to `0x00`. The
field is declared `ascii(16, { pad: 0x00, terminators: [0x00, 0xff] })`, so the
encoder pads the whole field with its own filler while the radio had left
erased flash in the tail. Nothing decodes differently - the first terminator is
at index 8 either way - and the field is one the driver owns, so the gate is
right not to raise `unowned-bytes-changed` over it.

It is still six bytes the diff did not mention. The diff speaks in channels, by
design and for good reasons, but "one channel change" covered a byte change
slightly wider than the edit. Nothing here needs fixing; it is recorded so that
the next person diffing two images does not spend an evening on it.

The restore put them back. The final image holds `00 00 ff ff ff ff ff ff`
again, because a restore writes the bytes the backup holds rather than
re-encoding a document, which is the behaviour that makes it a way back.

#### The count of 42, resolved

The restore's progress counts to 42, which is `targets.length` - the pages in
the writable scope it walks - and not the number it sends. That was left open
here and is now settled: restoring an image **identical** to what the radio
holds completes with no write phase at all and leaves the sha256 unchanged. The
skip happens inside the loop, the screen's "sends only the blocks that differ"
is literally true, and 42 is pages considered, not written.

## A12: the key slots

2 September 2026, same radio, cable and phone. No key material appears in this
note, in the commit that added it, or in the session that produced it: every
check below was written to report a shape - masked or not, a length, a count, a
boolean - and never a value.

This radio carries **22 slots, every one an AES-256 key**, named `Encrypt 1`
through `Encrypt 22`, none blank. That is a second radio agreeing with the
comment in `layout.ts`: a full AES-256 key occupies the **entire** 32-byte field
from `+0x0C`, not right-aligned at `+0x24` as the specification says. The spec's
sample almost certainly had a short key that the vendor software right-aligned.

**Nothing on the radio uses them.** `encryptionKeyId` at `+0x2A` is zero on all
49 live channels, so no channel references a slot. Sequential names and no
references together suggest factory defaults rather than anything operational,
which is what made a write test on slot 22 reasonable.

### What held

- **Masked by default.** All 22 render as bullets with four hex characters at
  each end. `maskKey` scales that budget with length - `min(4, len/8)` - so a
  10-character ARC4 key gets no window at all rather than eight of its ten.
- **One at a time.** Revealing slot 2 re-masked slot 1 without being asked, and
  the buttons flipped `Reveal`/`Hide` to match.
- **The editor does not prefill.** Opening slot 22 shows an empty key field
  reading "leave blank to keep the current key", so editing a slot's name
  cannot reveal its key as a side effect.
- **The summary carries nothing.** The `.html` export was written to the device
  and grepped there: zero hex runs of 32 characters or more, zero of 64, zero
  occurrences of `Encrypt N`, zero mask bullets, zero mentions of AES - and it
  does carry its own disclaimer and 44 channel mentions, so it is a real
  summary rather than an empty file. Not the key, not a masked key, not the
  name of the slot: `io/summary.ts` says all three and the file agrees.
- **The write is surgical.** One slot written with a test pattern: exactly 32
  bytes changed in 262,144, all inside that slot's key field, one page touched.
  The slot name, the type byte, the other 21 slots and the roughly 3 KB after
  the key area were untouched.
- **The restore puts it back.** sha256 returned to `363eecd6dac6f291` with zero
  bytes different, and the slot no longer holds the test pattern.

Key pages are verified like any other: `writeImage` compares all 4,096 bytes of
the page it wrote. The comment that key slots "cannot be read back" means not
by eye, by a person - not that the driver skips them. Worth stating because the
short form reads the other way.

### The gap: a key change gets no account

The write screen's diff speaks in channels. Editing a key slot therefore
produces **"no channel changes"**, followed by an honest paragraph saying the
4,096 bytes are elsewhere and could be "a zone, talk group or scan list name,
an RX group, a radio ID, a setting or a key slot", and that boofwang has no
line-by-line account of those yet.

Nothing there is untrue, and stating the uncertainty rather than hiding it is
the right instinct. But the effect is that the single most sensitive edit this
program can make - replacing key material - is the one the confirmation screen
can say least about. Somebody types WRITE having been told a page is going
somewhere, not that slot 22's key is being replaced. A per-slot line would not
need to show any key to be useful: "key slot 22 replaced", or "key slot 7
cleared", is the whole of what is needed.

### Exports land in shared storage

`Filesystem.writeFile` with `Directory.Documents` puts exports in
`/sdcard/Documents/boofwang/`, which is shared storage a file manager can read,
and then hands the file to the share sheet. For a summary that is fine - it
holds no keys by construction. The same menu offers `.bwp`, `.img` and `.bin`,
which are full codeplugs and carry every key in plaintext by design, to that
same directory. On a desktop the browser asks where a download goes; here it
does not. Nothing is wrong with exporting a full codeplug - it is what the
format is for - but a phone puts it somewhere more readable than a laptop does,
and that difference is not stated anywhere in the interface.

## S1 Android leftovers

Three items S1 left as "not run", plus one claim that had never been run on
hardware. 2 September 2026, Pixel 8 Pro, `b588ca9`, no radio attached for any
of it.

**External links: pass.** Tapping "Report a bug" launched Chrome as its own
activity in its own task (t80 against the app's t79) and the WebView stayed on
`https://localhost/`. The failure this rules out is the ordinary one for a
WebView - an external link navigating in place, leaving somebody inside an app
with no address bar, no back affordance and no way to the page they wanted.

**File save: pass.** The `.html` summary export written during A12 landed in
`/sdcard/Documents/boofwang/` and was readable there with the right size and
contents. That is `Filesystem.writeFile` with `Directory.Documents`, then the
share sheet, both working.

**File open: pass, for the half that was reachable.** The button opens
Android's own DocumentsUI picker, the picker lists files, and a selection comes
back to the app. The picker is not MIME-filtered, so a file that is not a
codeplug can be chosen and the app has to say so itself. It does, accurately:

```
Could not open that file
This file is 7,988 bytes, which does not match any radio boofwang supports.
If it is a codeplug, open the .bwp or CHIRP .img instead: a bare .bin cannot
say which radio it came from.
```

That names the real byte count rather than a generic "unsupported file", gives
the remedy, and explains why a bare `.bin` cannot be identified. Opening a
*valid* codeplug is still not run: the only file to hand would have been a
`.bwp` of this radio, and exporting one writes 22 AES-256 keys into shared
storage, which is not a thing to do for a test.

**The back button still does nothing.** Unchanged from S1.

### The native "no adapter" message, finally run

`16bf5b2` swapped the connect page's primary button from `requestPort` to
`acquirePort` and claimed the native path "throws with its own message when no
adapter is attached". That had never been exercised on a phone. With the cable
unplugged it produces:

```
Could not open a serial port
No USB serial adapter is attached. Plug the programming cable into the phone
through an OTG adapter.
```

Which is the point of that commit: before it, the same tap reached
`navigator.serial` in a WebView that has none and reported "This browser does
not support Web Serial" - a true sentence about a program that is not running,
to somebody holding an app. The card correctly stays on its opening state
rather than raising a fault, because no adapter attached is not a fault.

### Still blocked

Backgrounding - B1 through B4, and the whole of the Backgrounding section above
- needs a transfer to interrupt, and the radio was unplugged from the phone
before it could be tried. Nothing in that section has been run. It is the
largest untested claim in this file: `markInterrupted`, the keep-awake hold,
the held back button and the "interrupted rather than cancelled" message are
all argued from source.

## B1: backgrounding did not break a USB read

3 September 2026, Pixel 8 Pro, Android 17, `b588ca9`, DM-32UV on an FTDI
FT232R. The row is B1's scope run against a DM-32UV rather than the UV-K5 it
names, because that is the radio that was on the cable.

**Keep-awake works, and this is the first time it has been watched.** While a
transfer runs the app holds a `SCREEN_BRIGHT_WAKE_LOCK` attributed to
`ng.boofwa.app` and its window carries `fl=KEEP_SCREEN_ON`; before the read
there is no boofwang wake lock at all, and within three seconds of
backgrounding it is released again. That is `bridge.keepAwake` and the
`transfer.active` watcher doing exactly what they claim.

**The interruption did not happen.** Four reads were backgrounded part way -
at blocks 3, 4, 29 and 49 of 59 - and left in the background for up to 58
seconds. The fourth had the screen switched off with the power button, which
overrides keep-awake, and `mWakefulness` reached `Dozing`. All four finished.
All four wrote 262,144 bytes at sha256 `363eecd6dac6f291`, the same image the
foreground reads produce, so they completed correctly rather than merely
appearing to.

That contradicts the premise this document opens the Backgrounding section
with: "both operating systems freeze the WebView's JavaScript a few seconds
after the app leaves the foreground. Timers, streams and the transport freeze
with it." On this device, on this Android version, over USB, they did not.

What that does and does not license. It does not make the guard wrong: the
guard costs nothing, `markInterrupted` only changes which sentence a failure
gets, and one phone is not a platform. It does mean the section's flat claim
is too strong to leave standing unqualified, and that the more specific
worries behind it are still open. Nothing here was tested over Bluetooth,
where a GATT link is far more exposed to radio-level throttling than a USB
device an app holds open; nothing was tested on iOS, which is stricter about
background execution than Android and is the platform the section's
`bluetooth-central` paragraph is about; and nothing was tested under memory
pressure, which is when Android actually reclaims a backgrounded WebView.

**The interrupted message is therefore still unverified.** No read could be
made to fail, so `useRadioSession`'s "The read was interrupted" branch and the
"boofwang went to the background at N%" log line have never been produced by a
real interruption. They remain argued from source.

B2, B3 and B4 stay "not run": Bluetooth, iOS, and mid-write, none of which
this session could reach.

## B4: why it could not be run

3 September 2026, same radio and phone. B4 is "backgrounded mid-write, only
after B1, with a restorable backup". B1 is done and the backups are there, so
the preconditions were met. It still could not be run honestly.

The safe way to test a mid-write interruption is to write an image identical to
what the radio already holds: then every byte sent equals the byte already
there, and an interruption at any point cannot change the radio. That was tried.
The restore ran its 200-entry scan, found nothing differing, sent nothing, and
finished - and a read afterwards returned sha256 `363eecd6dac6f291`, unchanged.
So the safe version has no write to interrupt.

The unsafe version needs a restore that actually sends pages, which means an
image that differs from the radio in enough places to take long enough to catch.
Every difference available here is one page - the channel rename was one, the
key slot was one - and one page is a couple of seconds. Manufacturing a longer
one would mean making substantial edits to somebody's working radio for the sake
of interrupting the write that puts them back. That is a worse trade than
leaving the row unrun, so it is left unrun.

What would make B4 reachable: a radio nobody minds, or a build with a
deliberately slowed write for the bench. Neither is a reason to change the
shipping driver.

The attempt did establish the thing above about page counts, which was worth
having on its own.

## The slide confirmation, on a thumb

3 September 2026, Pixel 8 Pro, `89eaa6c`, DM-32UV on the FTDI cable.

The mobile write screen asks for a drag rather than a typed word, and the
reason is in the commit: a keyboard on a phone covers the diff that justifies
the write. Both halves were exercised on the device, because a drag threshold
is exactly the kind of thing that is right in a test and wrong under a thumb.

**Released short, it sends nothing.** A swipe from the handle to about 63% of
the track and up: `aria-valuenow` went back to `0`, the page stayed on
`/write`, and no transfer started. That is the property that makes this a
confirmation rather than a button.

**Taken to the end, it writes.** A swipe past the end committed, the transfer
ran, and the screen reported `VERIFIED. 1 block written, all read back and
matched`. One channel renamed, one 4 KiB page.

**Restore kept the typed word**, on the same phone at the same width: the
restore screen rendered a text field and no slider, which is the intended
split. There is no diff on that screen to keep on screen, and it is the more
destructive of the two actions.

The radio was put back from the pre-test backup afterwards and re-read: sha256
`363eecd6dac6f291`, the same image this file has recorded all along.

Not covered: the keyboard route. Arrow keys and End move and commit the handle
in the component, and that is asserted in
`test/app/confirmation-survives-the-phone.spec.ts`, but nothing has driven it
with a physical keyboard on a phone or a tablet.
