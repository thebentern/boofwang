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
| Signed `.aab` | Built by `mobile.yml` on a tag, once the keystore secrets exist. Verified locally: `bundleRelease` produced a 4.4 MB `app-release.aab` on 2026-09-03. |
| `targetSdk` | 36. Play's floor for new submissions is 35, so this is current. |
| `versionCode` | The workflow run number, which is monotonic. Play requires nothing else of it. |
| `applicationId` | `ng.boofwa.app`, matching the iOS bundle id and the App ID already registered. |
| Privacy policy | `/privacy`, so <https://boofwa.ng/privacy>. Play requires a URL for every listing whether or not anything is collected. |
| Icon, feature graphic | `node scripts/make-store-art.mjs` writes both to `build/play/`. |
| Screenshots | **Not captured.** Play needs at least two phone screenshots. See below. |
| Play developer account | **Not created.** Only the owner can. |
| Upload key | **Not created.** Only the owner should. |

## What only a person can do

None of these can be done from a checkout, and two of them cost money or
create liabilities, so they are listed rather than automated.

1. **A Play Console developer account.** One-off 25 USD, and identity
   verification that now takes days rather than minutes. Google also requires
   a verified physical address and a public contact email, and the address
   goes on the listing for individual accounts.
2. **The upload key.** `docs/mobile.md` has the command. It has to be made on
   a machine the owner trusts and kept: Play will not take an update signed
   with a different key, though Play App Signing does allow an upload key to
   be reset through support if it is lost.

   ```bash
   keytool -genkeypair -v -keystore boofwang-release.keystore -alias boofwang \
     -keyalg RSA -keysize 4096 -validity 10000
   ```

3. **Four repository secrets**, so the tagged build can sign:

   ```bash
   base64 -i boofwang-release.keystore | gh secret set ANDROID_KEYSTORE_BASE64
   gh secret set ANDROID_KEYSTORE_PASSWORD
   gh secret set ANDROID_KEY_ALIAS      # boofwang
   gh secret set ANDROID_KEY_PASSWORD
   ```

4. **The first upload, by hand.** Play will not accept an upload over its API
   until a build for that package name has been through the Console once. So
   the first `.aab` is downloaded from the workflow run and dragged into the
   Console; every one after that can be automated, which is what the
   `PLAY_SERVICE_ACCOUNT_JSON` step in `mobile.yml` is for.
5. **Submitting for review**, and answering anything the reviewer asks.

## The listing

Sentence case, lowercase boofwang, and no claim that is not true on Android.
That last one is not pedantry: `docs/mobile.md`'s table records that of the
four radios, only the DM-32UV has been read and written on an Android phone.
The drivers themselves are verified against hardware captures and, for three
of the four, against real radios elsewhere, but the honest Android claim
today is narrower than the honest claim for the project.

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

  Quansheng UV-K5
  Baofeng UV-82
  Baofeng UV-5R Mini
  Baofeng DM-32UV

Connect over a USB programming cable (CH340, PL2303, CP210x and FTDI adapters
are recognised) or, on radios that have a module of their own, over Bluetooth.

Writing to a radio is treated as the risk it is

Every memory format here was worked out by reading other people's
implementations and watching real radios, not from the manufacturer. A wrong
byte can leave a radio unable to transmit, so boofwang is built to make that
hard to reach by accident:

  A backup is taken before anything is written, and a write is refused if
  there is no backup, or if the backup belongs to a different radio.
  You are shown a field-by-field difference of what will change before you
  confirm it, and confirming takes a deliberate action rather than a tap.
  Every block written is read back off the radio and compared before the next
  one is sent.
  Bytes boofwang does not understand are carried through untouched rather
  than regenerated, and a change landing outside the region a driver claims
  to understand stops the write instead of warning about it.
  Calibration data is captured in every backup and never written.
  Receive-only channels stay receive-only through import, edit, preset and
  write, and are called out by name in the difference.

Also here

  Import and export CHIRP CSV, and read CHIRP .img files.
  Repeater and talkgroup lookup from hearham, RadioID and BrandMeister.
  Presets for the FRS, GMRS, MURS and NOAA weather channels.
  Backups kept on the device, with a restore that puts a radio back exactly
  as it was.
  Works with no network. Nothing is uploaded anywhere and there is no account.

What has actually been tested on a phone

The DM-32UV has been read, written and restored over a USB cable on an
Android phone, byte-for-byte verified. The other three radios are verified
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

**Encryption in transit**: yes, all three endpoints are https and
`lib/data/` refuses anything else. **Deletion**: nothing is held to delete.

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

**Screenshots are still to do.** Play wants at least two phone screenshots,
between 320 and 3840 px on a side. They should be captured from a real device
with a real codeplug open, which needs a radio and an unlocked phone:

```bash
adb exec-out screencap -p > screenshot-1.png
```

The screens worth showing are the channel list with its band colours, the
channel editor, the difference view before a write, and the connect screen.
Do not screenshot the key slots: a revealed key in a store listing is a key
published.

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
