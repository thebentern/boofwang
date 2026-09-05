# boofwang

Browser-based codeplug editor and programmer for two-way radios, over the
[Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API).
Static site, no server, no account. Codeplugs stay on the machine.

Live at [boofwa.ng](https://boofwa.ng), and as a
[desktop build](https://github.com/thebentern/boofwang/releases) for macOS, Windows and Linux.

## Working offline

boofwang self-hosts its fonts and never calls out for an icon, because radios
get programmed where there is no network. The site itself still needed one to
load, which made both of those gestures rather than measures. It no longer does.

Open [boofwa.ng](https://boofwa.ng) once on a network and the browser keeps a
copy: the whole build, about 2 MB, precached atomically. After that it opens
with the network off, on a laptop or on a phone doing Bluetooth to a UV-5R Mini
in a field. Chromium browsers also offer to install it to the home screen or
dock, which is the same copy in a window without a URL bar.

**The version is stated in the footer of every page** - `boofwa.ng 0.1.1 ·
a1b2c3d` - and in full on the About page, with how old the commit is and when
this device last managed to look for a newer one. A codeplug editor that has
quietly stopped being updated is a hazard of its own: the offsets under
`lib/radios/` change when somebody works out that a byte meant something else,
and an old copy will write the old understanding to a radio without hesitating.

When a newer build arrives it is stated, never applied. Applying it means
reloading, and a reload discards a codeplug that has been read and edited but
not yet written, so the offer follows the risk register: one click when nothing
is open, nothing at all while a transfer is running, and the destructive tier -
what is lost, named, then a typed word - when there are unwritten edits.

The cache is narrow on purpose. It holds exactly what the build emitted, adds
nothing opportunistically, and never touches a cross-origin request: the
repeater directories, the BrandMeister device list and the RadioID database are
live, and a repeater that changed frequency six months ago is a licence problem
rather than a convenience one. `sw/worker.js` states the four rules in full, and
`test/sw/` runs that exact file in a fake worker scope, because the alternative
way to check it is to deploy a site, install it, unplug the network and look at
a blank page.

The worker is written into the built site by `scripts/build-service-worker.mjs`,
which runs as part of `pnpm build` and `pnpm generate`. The desktop build
deliberately does not get one; see below.

## The desktop build

The same application, in a window of its own. It exists for one reason: two
repeater directories - hearham and RadioID - send no `Access-Control-Allow-Origin`
header, so a browser tab cannot read them at any price. The shell fetches them
from outside the renderer, where the same-origin policy does not apply.

Everything else is identical, including the radio support: the shell is Electron
rather than Tauri because Electron carries Chromium on every platform, so the
Web Serial and Web Bluetooth transports this project already has are the ones
that run. Nothing is reimplemented for the desktop - a second transport stack
would be a second thing to get wrong against somebody's radio.

`lib/platform/host.ts` names the difference as capabilities rather than as a
build flag, and a feature declares what it needs rather than which build it
belongs to. Two capabilities are real today, `crossOriginFetch` and
`customUserAgent`; a browser has neither and says so on the screen instead of
failing.

It gets no service worker. The shell is already an installed application and
already works without a network, and it updates by being replaced through the
releases page - so a cache in front of it would hold one release's assets in the
profile and go on serving them after the application itself had been updated.
That is an offline copy defeating an update, which is the exact failure the
offline build is there to prevent. `lib/platform/offline-support.ts` decides it,
and checks the host before anything else, because the shell carries Chromium and
registers its own scheme as secure: every naive check passes there.

```bash
pnpm desktop:dev      # generate the site, then run the shell against it
pnpm desktop:build    # package for the current platform into dist-desktop/
```

The macOS builds are signed with a Developer ID certificate and notarized, so
they open normally. Windows builds are **not signed** - SmartScreen will warn
until a certificate earns reputation, and why that is harder to fix than macOS
is in `docs/signing.md`. On Linux a serial cable is a group-permissions question
before it is a software one, usually `dialout` or `uucp`.

The pipeline signs when credentials are present and builds unsigned when they
are not, saying which in its own log, so a contributor without a certificate can
still package the app. `docs/signing.md` records what was done for macOS and
what the remaining platforms would cost, and `scripts/setup-signing.sh` sets the
secrets.

Every icon is generated from `build/icon.svg`, the desktop ones and the ones the
web app manifest points at:

```bash
pnpm icons          # build/icon.{png,ico,icns} and public/icon-{192,512,maskable-512}.png
pnpm icons:check    # fail if the committed icons are stale
```

They are committed because only macOS has `iconutil`, so a Windows or Linux
build cannot make its own - and `icons:check` runs in CI so the committed ones
cannot drift from the drawing.

Three silhouettes come out of the one drawing. The macOS one is inset in its
canvas; the maskable one is squared off and inset, because Android crops a
maskable icon to whatever shape its launcher wants and a squircle cropped by a
second squircle reads as a notch.

## The mobile apps

The same site again, bundled into an Android app and an iOS app by
[Capacitor](https://capacitorjs.com). Here the argument the desktop section
makes runs the other way: there is no Chromium to carry on a phone, no mobile
WebView has Web Serial, and only Android's has Web Bluetooth. So the cable and
the Bluetooth radio arrive through native plugins - an in-repo USB serial
plugin on Android, and a community Bluetooth LE plugin on both - and each ends
in the same `SerialPortLike` seam the browser transports end in. Everything
above that seam is unchanged; a test holds the plugins to `app/mobile/`.

Android has USB (an OTG cable to the same CH340, FTDI, CP210x and PL2303
adapters) and Bluetooth. iOS has Bluetooth only: an iPhone cannot drive a USB
serial adapter, and the connect page says so once. The UV-5R Mini writes over
Bluetooth as well as over the cable. A radio reachable only through a clip-on
BLE-to-serial dongle still writes over the cable alone, because no radio has
survived a write through one, so on an iPhone those four can be read, backed
up, edited and exported and not written.

Nothing about the apps has yet been run on a phone. [`docs/mobile.md`](docs/mobile.md)
is the build, signing and verification record, and its table of what has been
exercised is empty until it is not. The Radios table below mentions Android or
iOS for a radio only once that radio's protocol note carries the entry.

## Radios

| Radio | Memory | Read | Write | Hardware-verified |
|---|---|---|---|---|
| Quansheng UV-K5 | 200 channels, analog, 8 KB EEPROM | Yes | Yes | Read, write, restore |
| Baofeng UV-82 | 128 channels, analog, 6 KB image | Yes | Yes | Read, write, restore |
| Radioddity UV-5G | 128 channels, analog GMRS, 6 KB image | Yes | Yes | Read, write, restore |
| Baofeng UV-5R | 128 channels, analog, 6 KB image | Yes | No | None: no UV-5R has been on a cable |
| Baofeng UV-5R Mini | 999 channels, analog, 33 KB image | Yes | Yes | Read, write, restore; read also over Bluetooth |
| Baofeng DM-32UV | 4000 channels, DMR, zones/talkgroups/AES keys | Yes | Yes | Read, write, restore; startup picture |

CHIRP has no DM-32UV driver. Baofeng's own CPS is Windows-only.

The UV-5R is read-only, and the last cell of its row is the whole reason: its
memory map is the one the UV-82 and UV-5G drivers are verified on - CHIRP's
`BaofengUV5R` is the class both of those subclass - but nobody working on
boofwang has had a UV-5R on a cable, so its ident magics, its firmware
classifier and its band plan have been read out of CHIRP and never off a
wire. Reading is offered because a backup is exactly what an unverified radio
needs. [docs/protocols/uv5r.md](docs/protocols/uv5r.md) lists what a bench
session would settle, and in what order.

The UV-5R Mini can also be read over Bluetooth, with no cable at all — the
radio's wireless CPS mode speaks the same protocol over a GATT characteristic.
In a browser, support is narrower than Web Serial: Chrome and Edge on desktop
and Android, and nothing on Safari, Firefox or iOS. The mobile apps carry
their own Bluetooth stack, which is what would put this on an iPhone; see
[`docs/mobile.md`](docs/mobile.md) for what has and has not been exercised.

Per-radio protocol notes, including exactly what has and has not been exercised
against hardware, are in [`docs/protocols/`](docs/protocols/).

The UV-K5 also reads the [egzumer](https://github.com/egzumer/uv-k5-firmware-custom)
custom firmware, which arranges its EEPROM differently: channels, names and
settings all decode, and the settings page gains a form that stock firmware has
no equivalent for. That layout is **read-only**. Nobody working on boofwang has
a radio running it, so its offsets are checked against CHIRP's driver and
against nothing else, and writing stays off until one has been.

Two different radios are sold as "UV-5R Mini" and "5RM"/"UV-5RM". They differ in
ident string, region map, channel count and power table. Both are implemented;
the handshake selects between them. Only the UV-5R Mini has been tested on
hardware.

DM-32UV writes cover channel records, zones and their channel lists, talk
groups, scan list names, RX groups, DMR radio IDs, radio settings and the
encryption key slots, the per-channel talk group, both VFOs, text messages,
roaming, DTMF codes and both analog contact lists, and the DMR address book in
its own memory region. Channels, zones, talk groups, contacts and messages can be added and
removed, and the radio's own ordering of its talk group list is rewritten to
match. What is not written is roaming zone membership and the individual fields
inside other structures whose meaning is documented as derived rather than
confirmed. Its pages relocate between sessions
and 22 of its 59 allocated blocks are undocumented, so every other byte is read,
preserved and never sent back.

## File formats

| Format | Read | Write |
|---|---|---|
| `.bwp` — boofwang codeplug; records radio identity and a SHA-256 | Yes | Yes |
| CHIRP `.img` | Yes | Yes |
| CHIRP CSV | Yes | Yes |
| Raw `.bin` | Yes | Yes |
| Channel summary — one self-contained `.html`, or a Markdown table | No | Yes |

CSV output is byte-identical to CHIRP's own, checked by loading it with
`chirp.generic_csv.CSVRadio` and diffing CHIRP's re-export
(`scripts/crosscheck-chirp-csv.py`).

`.img` files carry CHIRP's metadata trailer and open in CHIRP. The DM-32UV is
excluded, because CHIRP cannot open a radio it has no driver for.

A summary is the channel plan rather than the codeplug: the radio, the firmware,
the channel count and the channel list, in one file that references nothing
outside itself and can be emailed or pasted into a wiki. It never carries
encryption keys, in any form, including the names of the slots they sit in - a
`.bwp` is what to send when the whole radio is genuinely wanted. The channels
page also prints, dropping the interface and the virtualised window so that
every channel reaches the paper with its receive-only marking still legible in
black and white.

## Fleet programming

A club buys twenty DM-32UVs, one person builds the channel plan, and every
handset needs it. What must not travel with it is the DMR ID: radios sharing one
share a single identity on every repeater they touch, and none of them can tell.

So `/fleet` takes a roster — a row per radio, carrying the two things that are
its own, a DMR ID and the name filed with it — and runs the ordinary write flow
once per handset. Connect, read (which is what stores that unit's backup), apply
the roster row to the master, show the diff, type the word. Each radio's document
is rendered onto **its own** image, so calibration and every undecoded byte stay
with the unit they came from, exactly as in a one-radio clone.

There is deliberately no bulk send and no fleet exception to the typed
confirmation. Typing `WRITE` is about five seconds against the two or three
minutes a DM-32UV takes to read and write.

The roster is pasted as CSV — any column order, with a header row naming the
columns, or `label,dmrId,name` without one — and exports back out, along with a
record of the run naming which physical unit took which row.

Two checks exist only here, because they are failures only a fleet run can have:

- **Two rows on one DMR ID** blocks the run before a radio is plugged in.
- **The same physical handset presented twice** is caught by its unit
  fingerprint, because twenty identical radios go through one cable over an
  afternoon and nothing on the outside of any of them says which are done.

## Development

Requires [pnpm](https://pnpm.io/). Node 24.11.1 is pinned in `.npmrc` via
`use-node-version`.

```bash
pnpm install
pnpm dev            # http://localhost:3000
pnpm test
pnpm typecheck
pnpm lint
pnpm build          # static output in .output/public
```

No test requires a radio. Drivers are exercised against captured hardware
images in `test/fixtures/images/` and a scripted fake serial port.

Upstream references the drivers are transcribed from (CHIRP sources, the DM-32UV
protocol specification) are not redistributed here. Fetch them into the
git-ignored `reference/` directory:

```bash
./scripts/fetch-reference.sh
```

## Serial bridge (development only)

Web Serial requires a person to answer a native port chooser, so an automated
session cannot obtain a port. `tools/serial-bridge` supplies a `SerialPortLike`
backed by a localhost WebSocket instead of `navigator.serial`.

```bash
pnpm bridge                       # one terminal
pnpm dev                          # another
# http://localhost:3000/?bridge
```

Everything below the `SerialPortLike` seam is the shipping code path: transport
framing, timeouts, protocol, driver, decode and UI. It does not exercise the
`navigator.serial` glue in `app/composables/useWebSerial.ts`.

Constraints: binds to 127.0.0.1, rejects non-localhost origins, is never started
by the app or the build, and the client side requires both a dev build and an
explicit `?bridge` query parameter.

### Bluetooth

The same idea, over the air. Web Bluetooth has the same chooser problem as Web
Serial and a narrower set of browsers that implement it at all, so the browser
is taken out of the Bluetooth path during development: a second bridge holds the
GATT connection and speaks the same protocol, and `BridgeSerialPort` cannot tell
the difference.

```bash
python3 -m venv .venv && .venv/bin/pip install -r tools/ble-bridge/requirements.txt
pnpm bridge:ble                   # one terminal
pnpm dev                          # another
# http://localhost:3000/?bridge
```

It is Python rather than Node beside its sibling because `bleak` works on macOS
and has read a whole codeplug off a real radio, where `noble` is fragile there.
The scan filters on the CPS service by default; `--all` lists everything.

The bridge reports `kind: "bluetooth"`, which is not cosmetic - the UV-5R Mini
sends 0x80 upload blocks over its own Bluetooth module where the cable takes
0x40, and a bridge that failed to say so would write the wrong size while
looking healthy.

The carrier is not the whole story, because of dongles. A TIDRADIO BL-1 clips
onto a radio's two-pin programming port and bridges BLE to the radio's own
UART: the host is on Bluetooth while the radio behind it behaves exactly as on
a cable, and takes the cable block size. `Transport` carries the two facts
separately - `kind` for the carrier, `radioLink` for what the radio believes -
and the connect screen offers the dongle route for the K-port radios. A
Baofeng BT-A1D has carried a whole UV-5R Mini codeplug this way - 1,000 slots
over BLE, with the radio believing it was on a cable throughout - so the route
is real. It is not universal: a UV-82 behind the same dongle stayed silent,
and the difference looks like frame shape rather than baud. Which radios are
proven, what the two enumerated dongles do, and how to capture a third are in
[`docs/protocols/ble-dongle.md`](docs/protocols/ble-dongle.md).

macOS refuses Bluetooth to an application that has not been granted it, and
refuses by killing the process rather than returning an error. An instant exit
with no message is that, not a fault in the bridge.

## Layout

```
lib/          framework-agnostic core; no Vue or Nuxt imports, runs in plain Node
  codec/      binary struct DSL: explicit offsets, partial writes, coverage reporting
  transport/  framing, timeouts, teardown, fakes, trace recorder; Web Serial and BLE ports
  radio/      driver interface, registry, image model, write gate, diffing, fleet plan
  radios/     one directory per radio: protocol, layout, schema, driver
  model/      channels, tones, units, codeplug document
  io/         CHIRP CSV, CHIRP .img, .bwp, raw .bin, shareable summary, fleet roster
  storage/    IndexedDB backups
  platform/   browser capability checks
  version/    which build is running, and whether an update is worth a prompt
app/          Nuxt 4 UI, rendered from radio schemas rather than per-radio code
sw/           the offline cache, a classic worker script filled in at build time
```

The `lib/` boundary is enforced by an ESLint `no-restricted-imports` rule and by
a Vitest project running in a DOM-less Node environment.

### Encoding invariant

`driver.encode(doc, base)` takes the bytes read off the radio as its base and
overwrites only the ranges the driver declares it understands. There is no
`encode(doc)`. Bytes the codebase does not model survive a read/edit/write cycle
because they are never allocated fresh.

Tested directly: `encode(decode(image), image)` is byte-identical to `image`,
for every fixture.

## Safety

- A backup of the connected radio is required before any write, enforced in the
  driver rather than the UI. `writeImage` throws `BackupRequiredError` when one
  is absent or belongs to a different radio.
- Where a driver can fingerprint the physical unit, the backup must match that
  unit and not merely the model and firmware. The DM-32UV uses its calibration
  block; identifiers derived only from firmware cannot distinguish two identical
  radios.
- Every write is preceded by a byte diff. A change outside the ranges the driver
  claims to own blocks the write; it indicates a defect in the encoder.
- **Every block written is read back and compared.** An acknowledgement says a
  frame arrived, not that it landed where it was meant to or survived being
  written to flash. The UV-K5 and the DM-32UV verify each block before sending
  the next; the UV-82 and the UV-5R Mini send the plan and then read every block
  of it back. Either way nothing reports success until the radio has been asked
  what it is actually holding.
- **A write can still damage memory outside the blocks it sent, and only a fresh
  read finds that.** A UV-5R Mini erased 19 channels while every frame was
  acknowledged, every block read back and matched, and the round-trip invariant
  stayed byte-identical - because the block that was sent was correct and the
  damage was everywhere else. That radio now receives its whole image on every
  write, which is why. boofwang does **not** re-read the whole radio afterwards
  and diff it; reading one is minutes, not seconds. Read the radio again if you
  want that comparison, and the backup taken before the write is what you would
  compare against.
- A fleet run is N ordinary writes rather than a new kind of write. It calls the
  same read and write functions every other screen calls, takes a fresh backup
  per handset, and asks for the typed confirmation on each radio's own diff.
- Read-only regions are marked in the image and never transmitted. The UV-K5's
  calibration block is one.
- Receive-only channels are decoded as such and preserved. The UV-K5 has no
  transmit-inhibit bit; CHIRP expresses it by parking the transmit frequency at
  zero, and boofwang reads and writes that convention.
- Transmitting into a receive-only allocation is warned about, prominently, on
  every affected channel — and then left to you. A frequency the radio cannot
  physically tune or key is still a blocking error, because that is a fact about
  the hardware rather than about your licence.
- Unrecognised firmware is read-only but still readable, so an unsupported radio
  can still be backed up.
- Encryption key material is masked by default and revealed one slot at a time.
  The keys page states the legal position: encryption is prohibited on amateur
  (47 CFR 97.113(a)(4)), GMRS/FRS (95.1731, 95.587) and MURS (95.2731).

The write gate is a single pure function, `evaluateWriteGate`, called by both
the UI and the transfer flow. Its blocking conditions are: writing unsupported
for the radio or firmware, image/radio mismatch, missing or foreign backup,
encode failure, changed bytes outside owned ranges, validation errors, and
nothing to write.

## Licence

GPL-3.0-or-later. See [`LICENSE`](LICENSE) and
[`docs/provenance.md`](docs/provenance.md).

Independent project. Not affiliated with or endorsed by Baofeng, Quansheng, or
the CHIRP project.
