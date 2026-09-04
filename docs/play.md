# Getting boofwang onto Google Play

The build side is done and has been for a while: tag a release and
`.github/workflows/mobile.yml` produces a signed `.aab` on the run. What was
missing is everything Play asks for around the binary, and most of it is
writing rather than engineering. This file is that writing, plus a plain list
of the steps that need an account nobody but the owner has.

Read `docs/mobile.md` first for how the shell is built and signed. This file
only covers the store.

## Where this stands

| Piece | State |
|---|---|
| Play listing | Created 2026-09-04 under the personal account `thebentern`. App id 4974818952627673396, package `ng.boofwa.app`. |
| Review | **Submitted 2026-09-04.** Eight changes sent: the store listing, content rating, target audience, privacy policy, ads, data safety, health apps and app category. Play's pre-review checks passed and it reports "Your changes are now in review". Google says reviews usually finish within seven days. |
| Store listing | Filled and saved: name, both descriptions, icon, feature graphic, five phone screenshots, category Tools, contact email and website. |
| App content | All declarations complete. Play reports "You're all caught up". |
| Privacy policy | <https://boofwa.ng/privacy/> - live since main was deployed on 2026-09-04, and set in the console. |
| Data safety | Submitted: no data collected, no data shared. |
| Content rating | Submitted. Lowest rating in every region: ESRB Everyone, PEGI 3, USK 0, ClassInd L. |
| Upload key | Generated 2026-09-04, RSA 4096, valid to 2054. SHA-256 `04:92:1F:AC:...:D9:B1`. Kept at `~/boofwang-release.keystore` with its password in `~/.boofwang-upload-key.pw`, both 0600. |
| CI secrets | All four `ANDROID_*` secrets set, so a tag now signs. |
| Internal testing release | `1002 (0.1.2)` **live** on the internal track since 2026-09-04 07:36. Track active, 4.17 MB install, 19,276 supported devices. Not yet reviewed, so testers see the temporary name `ng.boofwa.app (unreviewed)`. |
| Internal testers | One list, `boofwang internal`, with ben@meshtastic.com. Opt-in at <https://play.google.com/apps/internaltest/4700406117493732747>, then the Play listing appears for that account. |
| `targetSdk` | 36. Play's floor for new submissions is 35, so this is current. |
| `versionCode` | Derived from the version: 0.1.2 is 1002. Play accepted it. |
| `applicationId` | `ng.boofwa.app`, matching the iOS bundle id and the App ID already registered. |
| Permissions | Four, and none of them location. The Bluetooth plugin's uncapped coarse-location grant is capped in the app manifest; see below. |
| Icon, feature graphic | `node scripts/make-store-art.mjs` writes both to `build/play/`. |
| Screenshots | Five, 1080x2400, in `build/play/screenshots/`, uploaded. Captured on an emulator; see below. |

## What is left

The app is installable. What remains is the path to being public, and all of
it needs people rather than a checkout.

1. **Closed testing, twelve testers, fourteen continuous days.** This is the
   long pole and it decides when boofwang can be public.

   A personal Play account registered after November 2023 cannot publish to
   production until it has run a closed test with at least twelve testers who
   stay opted in for fourteen days. Twelve real Google accounts, not twelve
   devices, and the clock restarts if the count drops below twelve. The
   console says so plainly on the dashboard: "0 testers currently opted-in".

   Internal testing has no such requirement and takes effect immediately,
   which is why the automated upload step targets that track.
2. **Apply for production access**, answering Google's questions about how the
   closed test went.
3. ~~**Send the store listing for review.**~~ Sent 2026-09-04. What is left of
   this one is answering the reviewer if they come back with anything. Until
   the review passes, testers see `ng.boofwa.app (unreviewed)` rather than
   "boofwang", which is normal and not a packaging fault.

The account's verified physical address appears on the public listing, because
it is an individual account. Worth knowing now that the listing is in review.

## The listing

Sentence case, lowercase boofwang, and no claim that is not true on Android.
That last one is not pedantry: `docs/mobile.md`'s table records that of the
five radios, only the DM-32UV has been read and written on an Android phone.
The drivers themselves are verified against hardware captures and, for most
of them, against real radios elsewhere, but the honest Android claim today is
narrower than the honest claim for the project.

The radio list below was got wrong once, here. It said four radios, because
CLAUDE.md's opening line says four and that was believed over
`lib/radio/registry.ts`, which registers five - the Radioddity UV-5G was the
one dropped. The names, channel counts and transports are now read off the
running app on a phone, which is the one source that cannot be stale.

**App name** (30 characters): `boofwang`

**Short description** (80): 

```
Read, edit and write codeplugs for Baofeng and Quansheng handheld radios.
```

**Full description** (4000):

```
boofwang is a codeplug editor and programmer for handheld two-way radios. Plug
a programming cable into your phone, or connect over Bluetooth, and read what
is actually in the radio: channels, names, tones, power, scan lists, and on a
DMR radio the contacts, talkgroups and key slots. Edit it, see exactly what
changed, and write it back.

Supported radios

  Quansheng UV-K5      200 channels, analog. Reads egzumer firmware too.
  Baofeng UV-82        128 channels, analog
  Radioddity UV-5G     128 channels, GMRS/FRS
  Baofeng UV-5R Mini   1,000 channels, analog. Has its own Bluetooth.
  Baofeng DM-32UV      4,000 channels, DMR, with zones and AES key slots

Connect over a USB programming cable (CH340, PL2303, CP210x and FTDI adapters
are recognized) or, on radios that have a module of their own, over Bluetooth.

Writing to a radio is treated as the risk it is

Every memory format here was worked out by reading other people's
implementations and watching real radios, not from the manufacturer. A wrong
byte can leave a radio unable to transmit, so boofwang is built to make that
hard to reach by accident:

  A backup is taken before anything is written, and a write is refused if
  there is no backup, or if the backup belongs to a different radio.
  You are shown what will change before you confirm it, one line per
  channel, with a channel gaining transmit and a slot being erased called out
  by name. Confirming takes a deliberate action rather than a tap.
  Every block written is read back off the radio and compared, because an
  acknowledgement says a frame arrived and not that it landed where it was
  meant to.
  Bytes boofwang does not understand are carried through untouched rather
  than regenerated, and a change landing outside the region a driver claims
  to understand stops the write instead of warning about it.
  Calibration data is captured in every backup and never written.
  Receive-only channels stay receive-only through import, edit, preset and
  write, and are called out by name in the difference.

Also here

  Import and export CHIRP CSV, and read CHIRP .img files.
  Repeater lookup from hearham and RadioID, and talkgroups from BrandMeister.
  Presets for GMRS, MURS and NOAA weather, the 2 m and 70 cm band plans, and
  UK PMR446.
  Backups kept on the device, with a restore that puts a radio back exactly
  as it was.
  Works with no network, and there is no account. Your codeplugs, backups and
  keys never leave the device. The repeater and talkgroup lookups are the only
  thing that reaches the internet, and only when you search.

What has actually been tested on a phone

The DM-32UV has been read, written and restored over a USB cable on an
Android phone, byte-for-byte verified. The other four radios are verified
against hardware elsewhere but have not yet been exercised over a cable on
Android, and neither has the Bluetooth path. If you try one, an issue on
GitHub saying what happened is genuinely useful.

boofwang is free software under the GNU General Public License v3 or later.
The source is at github.com/thebentern/boofwang. It comes with no warranty:
programming a radio incorrectly can render it unusable, and you are
responsible for keeping a backup you have checked you can restore, and for
transmitting only where your license allows.

Not affiliated with, endorsed by or connected to Baofeng, Quansheng or any
radio manufacturer.
```

**Category**: Tools. **Tags**: amateur radio, utilities.

**Contact email**: the account's verified address. **Website**:
<https://boofwa.ng>. **Privacy policy**: <https://boofwa.ng/privacy>.

## The permission the listing would have shown

Worth its own section because nothing in this repository was wrong, and the
built app still asked for something it does not use.

`AndroidManifest.xml` caps every legacy Bluetooth permission at API 30 and
flags the scan `neverForLocation`, which is accurate: `app/mobile/bluetooth.ts`
initialises the plugin with `androidNeverForLocation: true`, and on that path
`BluetoothLe.kt` requests only BLUETOOTH_SCAN and BLUETOOTH_CONNECT from
Android 12 onwards. So boofwang never asks where you are.

`@capacitor-community/bluetooth-le` declares ACCESS_COARSE_LOCATION with no
`maxSdkVersion`, and a permission that only a library declares reaches the
built app exactly as the library wrote it. The manifest merger had nothing to
merge it with. The result was a release APK requesting approximate location on
every Android version, and a Play listing that would have shown "approximate
location" under a radio programmer that never asks for it.

It was invisible in the source. It showed up in

```bash
aapt2 dump badging app-release.apk | grep uses-permission
```

which is now worth running before any submission, because this class of defect
can arrive with a dependency bump and change nothing a test can see. The app
now declares the permission itself purely to cap it at 30, and
`test/app/mobile-config.spec.ts` holds that line.

The four permissions a reviewer will see: INTERNET, BLUETOOTH_SCAN
(neverForLocation), BLUETOOTH_CONNECT, and the legacy set capped at API 30.

## Data safety

Play's form asks two questions about every data type: is it collected (sent
off the device) and is it shared. For boofwang the answer to the whole form is
**no data collected and no data shared**, and the reasoning matters because a
data safety declaration that is wrong is a policy violation rather than a
mistake.

The three facts it rests on, each checked in the code on 2026-09-03:

- **The app makes no request of its own.** `pnpm mobile:site` builds with no
  service worker and the shell registers none, so there is no update check, no
  error reporting and no analytics. `capacitor.config.ts` says the same thing
  in its comment: the store is the update channel.
- **Codeplugs, backups, keys and settings never leave the device.** They are
  in the app's own storage and in files the user exports deliberately.
- **Three lookups go to third parties, and only one of them carries anything
  of the user's**: the callsign typed into the repeater search box, sent to
  radioid.net as a query parameter. hearham and BrandMeister are fetched
  whole, with no query, and filtered on the device. Coordinates from "use my
  location" are used on the device and sent to nobody.

That callsign is the one item worth a second look, and the reason it is not
declared is Play's exemption for data transferred to a third party as a
result of a specific user-initiated action the user expects: it is typed into
a search box on a screen that names the directory being searched, and pressing
search is what sends it. `/privacy` documents it anyway, which is the part
that is not optional.

If a reviewer disagrees, the fix is small: declare it under Personal info,
"collected, not shared, not required, for app functionality".

**Encryption in transit**: yes. All three endpoints are hard-coded https
constants in `lib/data/`, so nothing can be redirected to a scheme by
configuration; there is no runtime scheme check, because there is no runtime
URL to check. **Deletion**: nothing is held to delete.

## Content rating and audience

The IARC questionnaire, answered for a utility with no social features:

- No violence, sexual content, profanity, drugs, gambling or simulated
  gambling.
- No user-to-user communication, no user-generated content, no sharing of
  location between users.
- No in-app browser. External links open in the system browser, which
  Capacitor does by default and `docs/mobile.md`'s S1 row confirms on device.
- Ads: none. In-app purchases: none.

Expected outcome is the lowest rating in every region.

**Target audience**: 18 and over. Not because anything here is unsuitable for
a fifteen-year-old with a license, but because declaring any under-13 audience
pulls the listing into the Families policy, which brings requirements this app
has no reason to take on.

One thing to check rather than assume: the About page and the footer link to
buymeacoffee.com. Donation links are ordinarily fine outside Play's billing
system, but if the reviewer raises it, hiding that link in the shell build is
a two-line change and is not worth arguing over.

## Graphics

```bash
node scripts/make-store-art.mjs
```

Writes `build/play/icon-512.png` (512x512, no alpha, composited onto the icon's
own ground rather than left transparent, because Play draws its own corners
over it and a transparent icon lands on white) and
`build/play/feature-graphic.png` (1024x500, no alpha). Both are git-ignored:
they are regenerated in a second and no build consumes them.

**Screenshots**: five, in `build/play/screenshots/`, 1080x2400, which is
inside Play's 320-3840 range. Dark, because the icon and the feature graphic
are dark and a listing that changes theme halfway down looks like two apps.

They were taken on the `Medium_Phone_API_36.0` emulator rather than a handset,
for the ordinary reason that the phone was locked, and the emulator turns out
to be the better tool anyway: 1080x2400 at density 420 is 411 CSS pixels, so
it renders the same phone layout `useFormFactor` picks on the Pixel, and the
WebView can be driven over CDP instead of by tapping at coordinates.

The content is real. A UV-5R Mini codeplug was opened from
`test/fixtures/images/uv5rmini-5RMINI.bin`, and the bundled GMRS preset staged
into free slots, which is why the channel list shows named GMRS channels with
a band edge and the write screen shows a 23-channel difference. Nothing is
mocked up and no screen was edited afterwards.

To retake them, with the app installed and a codeplug open:

```bash
adb -s emulator-5554 exec-out screencap -p > 01-channels.png
```

The five are the channel list, the channel editor, the connect screen with the
radio chooser, the presets library, and the write screen - that last one is
the one worth leading with, because it shows the backup gate refusing and the
per-channel difference in the same view.

**Do not screenshot the key slots.** A revealed key in a store listing is a
key published.

## What the pre-submission audit found

Everything above was checked by an adversarial review before submission: six
readers over the manifest, the data-safety answer, the listing copy, the
privacy page, policy risk and the release pipeline, and every finding then
handed to a separate reader told to refute it. Twenty-six survived, ten did
not. The ones that changed something:

- **`allowBackup` was on**, so Android Auto Backup copied the IndexedDB - the
  backups store, key slots and all - to the user's Google account, where it
  outlives an uninstall. That falsified two sentences on `/privacy` and the
  sentence the whole data-safety answer rests on. Now `false`, with a test.
- **Two hardware features were required by implication**, Bluetooth and
  location, both derived by `aapt2` from permissions rather than written
  anywhere. Play would have hidden the app from devices lacking either. Both
  now declared optional, with a test.
- **`versionCode` came from `github.run_number`**, which is the CALLER's
  number under `workflow_call` - so tags reaching Mobile directly and tags
  reaching it through Release were counting on two separate meters. Play
  accepts a code once, permanently. It now comes from the version.
- **The Play upload ran before `upload-artifact`**, so a rejected bundle took
  the only copy of a signed build down with it. Reordered.
- **"Use my location" could not work in the shell** and is no longer offered
  there. Measured, not assumed: with the OS location mode on and a fix set,
  `getCurrentPosition` timed out and `dumpsys package` showed the permission
  ungranted, because nothing ever requests it.
- **Four claims in the listing copy were wrong.** There is no FRS preset;
  talkgroups come only from BrandMeister; the write screen shows one line per
  channel rather than a field-by-field difference; and three of the five
  drivers send every block and then verify, rather than verifying before the
  next block goes - the code says so itself, in as many words.
- **Two claims on the privacy page were wrong.** The Bluetooth permission is
  asked for as the app opens, not when you connect, and the scan is
  unfiltered, so the phone receives every nearby advertiser.

Known and not fixed, because neither blocks a submission:

- The Android back button does nothing. `docs/mobile.md` records it twice.
- The footer tells the reader "Everything runs in your browser", which is
  literally true of a WebView and misleading in an installed app. It is
  behind `v-if="!phone"`, so a phone never sees it.

One thing that is worth saying plainly: **CLAUDE.md's rule "Every block
written is read back and compared before the next is sent" is not what three
of the five drivers do.** They write everything and then verify everything,
which `uv82/driver.ts` and `uv5rmini/driver.ts` both state in a comment. Every
block is still read back and compared, so the guarantee holds; the ordering in
the sentence does not. The listing copy was corrected to the guarantee. The
rule itself is not this file's to rewrite.

## Automated upload

`mobile.yml` has a step that uploads the `.aab` to Play's **internal** track
when `PLAY_SERVICE_ACCOUNT_JSON` is set, and says so and does nothing when it
is not, which is the same shape as every other signing step in this
repository. It never promotes to production: moving a build from internal to
open or production is a decision, and a decision belongs to a person and not
to a tag.

To set it up, after the first manual upload:

1. In the Play Console, Setup, API access, link a Google Cloud project and
   create a service account with the Release manager role.
2. Grant it access to this app only.
3. Download its JSON key and `gh secret set PLAY_SERVICE_ACCOUNT_JSON < key.json`.
