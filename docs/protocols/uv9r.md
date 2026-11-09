<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Baofeng UV-9R - notes

Memory layout transcribed from `MEM_FORMAT` in CHIRP's `baofeng_wp970i.py`,
protocol from `baofeng_common.py` (both GPL-3.0). See
[../provenance.md](../provenance.md). The UV-9G is the same family behind its
own magic; [uv9g.md](uv9g.md) records only what differs.

**boofwang has never been connected to one of these radios.** Not an identify,
not a read, not a write. Everything below is CHIRP's description of the
family, cross-checked against CHIRP's own driver classes on images other people
captured. The driver is offered read-only. Its write path exists and is tested
against a scripted radio, and the registry leaves it off until the bench
session at the end of this file has been run on a real UV-9R.

## Which radio this actually is

The name does not decide; the magic does, and here not even the magic. CHIRP
files these radios as subclasses of `WP970I` in `baofeng_wp970i.py`, built on
`BaofengCommonHT` in `baofeng_common.py` - a different module from `uv5r.py`,
which serves the UV-82, UV-5G and UV-5R. Several other radios with "UV-9" in
the name belong to other families entirely:

| Sold as | Where CHIRP says so | Magic | Here |
|---|---|---|---|
| Baofeng UV-9R | class `UV9R` | `MSTRING_WP970I` | this driver |
| Baofeng UV-9R Pro | `ALIASES` of class `BFA58` | `MSTRING_WP970I` | this driver |
| Baofeng UV-9R Plus | tracker: read as `UV9R`, or as `UV82WP` (issues 4511, 9837) | `MSTRING_WP970I`, when it answers | this driver; see below |
| Baofeng BF-UV9R+HP | alias map: the UV-82WP | `MSTRING_WP970I` | this driver, never seen; six-character names |
| youRUSH UV-9RUSH PLUS | alias map: the BF-A58 | `MSTRING_WP970I` | this driver, never seen |
| Baofeng UV-9G | class `UV9G` | `MSTRING_UV9G` | [uv9g.md](uv9g.md) |
| Baofeng UV-9X+ | alias map: the UV-82HP | the UV-82's | the UV-82 driver identifies a UV-82HP and will not write it |
| Baofeng UV-9S | alias map: Radioddity's UV-5RX3 | another family | not supported |
| youRUSH UV-9RUSH PRO | alias map: Radioddity's GA-510 | another family | not supported |

"Alias map" is CHIRP's `chirp/share/model_alias_map.yaml`, the list it shows a
user looking for a radio under another name; `fetch-reference.sh` fetches it.
None of its UV-9 entries appear in a driver's own `ALIASES`.

`MSTRING_WP970I` is `50 BB FF 20 14 04 13`, and CHIRP sends it for seven
models of this family: the WP970I, BF-A58, UV-82WP, GT-3WP, RT6, BF-A58S and
UV-9R. It also sends it to the BF-F8HP, a tri-power radio of the UV-5R family,
where the same bytes are `UV5R_MODEL_A58` in `uv5r.py`. So an acknowledgment
does not even say which family answered. CHIRP separates them by the model the
user picks from a list, and boofwang by the radio picked on the connect
screen - and before offering a write, by what the radio says after the magic.

Not every radio sold as a UV-9R speaks this. CHIRP issue 10270 is newer UV-9R
Pro and UV-9R Plus units that never answer the magic - the reports CHIRP's
developer could trace came down to cables and connectors, and the issue is
still open -
and at least one listing gives a "UV-9R Plus" 200 channels, which this 128-slot
layout cannot be. A radio that does not acknowledge the magic is not this one,
whatever the box says. Check the plug first: this radio's programming jack is
a screw-in connector, and a shroud that keeps it from seating has produced
every symptom of a protocol fault on CHIRP's tracker (issue 9837).

## Four images, none of them boofwang's

| Image | From | License | Ident | Firmware window | Memory sha256 |
|---|---|---|---|---|---|
| UV-9G, factory | CHIRP `tests/images/Baofeng_UV-9G.img` | GPL-3.0 | `aa 44 46 04 00 04 70 dd` | `???????` | `a0dce8c1a129e806...` |
| BF-A58S | CHIRP `tests/images/Baofeng_BF-A58S.img` | GPL-3.0 | `aa 30 79 04 00 05 20 dd` | `???????` | `b1b476c423f4bc8d...` |
| UV-9R, 2017 | CHIRP issue 4511, attachment `Baofeng_UV-9R_20170301.img` | its uploader's | `aa 30 79 04 00 05 20 dd` | all 0xFF | `7e2ce5c3c31f7b33...` |
| UV-9R Pro, factory | CHIRP issue 9932, attachment `Baofeng_UV-9R Pro_Factory Image.img` | its uploader's | `aa 30 79 04 00 05 20 dd` | `???????` | `a07ec0eae342c9e6...` |

Each is the 0x2008 bytes CHIRP saves: the radio's 0x2000 bytes of memory and
then the eight ident bytes. The 2017 file is 0x2010, because CHIRP builds of
that era appended the model name after the ident when the firmware window was
blank; the eight extra bytes say `UV-82WP `, the model its owner picked.

Only the UV-9G image is committed (`test/fixtures/images/uv9g-chirp-test.bin`):
it is part of CHIRP's GPL-3.0 test suite and so redistributable. The two UV-9R
captures belong to the people who posted them, so `scripts/fetch-reference.sh`
fetches them into the git-ignored `reference/` directory, and
`test/lib/radios/uv9r/reference-captures.spec.ts` runs against them when they
are there - which is never, in CI. What is committed is CHIRP's reading of them.

All four are factory programming, scanned for identity before any of this was
written: channel names are numbers or `GMRS`/`REPTR`/`DIY`/`NOAA` labels, the
power-on messages are `WELCOME` and `BAOFENG UV-9G`, the ANI code is the factory
`80808` and the PTT ID codes are the factory's repeated digits.

The committed UV-9R fixture is **synthetic**:
`test/fixtures/images/uv9r-chirp-synthetic.bin`, every byte written by CHIRP's
own `UV9R` class through CHIRP's `bitwise` engine (`scripts/gen-uv9r-fixture.py`,
sha256 `d3bfca915eff4c8b...`). It exists for the paths no factory image
reaches - a Low channel, inverted DTCS, all seven cross tone modes, a split, a
zero transmit filling, 0xFF in the middle of a name, a power selector of 3, a
stale record behind an empty marker - and it proves agreement with CHIRP and
nothing about agreement with a radio.

## What was checked, and against what

On every image above, with CHIRP's own `UV9R` or `UV9G` class building the
expectation (`scripts/dump-wp970i-family.py`):

- every channel `get_memory` reports agrees with boofwang's decode field for
  field: name, receive and transmit frequency, shift against split, bandwidth,
  power label, skip, both tones with polarity, busy-channel lockout, PTT ID and
  S-code - 65 channels on the UV-9G, 22 on the BF-A58S, 21 on each UV-9R, 24 on
  the synthetic image;
- all 50 fields of the settings struct read the same through CHIRP's `bitwise`
  engine and through boofwang's;
- `encode(decode(image), image)` is byte-identical on all five images;
- the 32 settings controls boofwang offers are exactly the 32 `get_settings`
  offers for the settings block, each list the same length as CHIRP's, each
  reading the entry CHIRP reads;
- nine edits on the synthetic image - a shorter name, Med to Low, a repeater
  made receive-only, DTCS to a plain tone, skip off, split to simplex, wide to
  narrow, a zero-filled receive-only channel's power, and the three extras -
  produce the bytes CHIRP's `set_memory` writes, record and name record both.

Run with `pnpm vitest run test/lib/radios/uv9r test/lib/radios/uv9g` after
`./scripts/fetch-reference.sh`; without the fetch, the reference-capture spec
skips and everything else runs.

## The memory map is the UV-5R's, rearranged

Laid side by side in radio addresses, this `MEM_FORMAT` and `uv5r.py`'s agree
on every struct both declare, so the struct definitions are the UV-82's,
imported, and only the addresses are new:

| Struct | Radio address | `uv5r.py` image offset |
|---|---|---|
| channel records, 128 x 16 | `0x0000` | `0x0008` |
| PTT ID codes | `0x0B00` | `0x0B08` |
| ANI code | `0x0CAA` | `0x0CB2` (inside uv5r.py's larger `ani` struct at `0x0C88`) |
| settings, `0x2E` bytes | `0x0E20` | `0x0E28` |
| VFOs | `0x0F00` (with eight leading unknown bytes) | `0x0F10` |
| names, 128 x 16 | `0x1000` | `0x1008` |
| 6+power-on, power-on and firmware messages | `0x1ED0`, `0x1EE0`, `0x1EF0` | `0x1818`, `0x1828`, `0x1838` |
| squelch tables, band limits | `0x1F60`, `0x1FC0` | `0x18A8`, `0x1908` |

Two arrangements differ. CHIRP prefixes the UV-5R family's image with the
ident and appends this family's, so here an image offset and a radio address
are the same number. And this family is read as one sweep of 0x2000, where the
UV-5R family reads `0x0000-0x1800` and `0x1EC0-0x2000` and never the gap
between - so a backup here carries everything the radio holds, including
`0x1E80-0x1EBF`, which on the BF-A58S holds four runs that look like
calibration.

The driver owns three ranges, all of them inside what CHIRP's own upload sends
(`_ranges`): channel records `0x0000-0x0800`, the settings block
`0x0E20-0x0E50`, and names `0x1000-0x1800`. Nothing else is ever sent.

## The protocol, and the one thing CHIRP leaves open

On the wire it is the UV-5R conversation, with the two differences
`baofeng_common.py` makes: the magic goes out in one write rather than a byte
at a time, and the reply to `0x02` is exactly eight bytes, framed `AA .. DD`.
Both of CHIRP's modules acknowledge every block they receive with `0x06` and
then wait 50 ms, and both wait 50 ms after every write frame before reading
the radio's answer. boofwang's UV-5R family driver does neither and works on
three radios, which proves those radios do not need it and nothing about these.
So this driver does both, because CHIRP's sequence is the only one reported
working against these radios (CHIRP issue 10270: a UV-9R, a UV-9G and a UV-9R
Pro downloaded and uploaded over an FTDI cable, 2023-11-30).

What CHIRP leaves open is where the radio's `0x06` before a block header comes
from. CHIRP skips it on the first read after the handshake (`first_command`)
and expects it on every other. That fits two radios equally well: one that
acknowledges each read command except the first, and one that answers the
host's `0x06` after a block with one of its own. A reader that never
acknowledges works on the first and waits forever on the second. The scripted
radio in `test/lib/radios/uv9r/fake-radio.ts` implements both, and the
identify, read and write tests run against each.

Under the second reading, one `0x06` is still in flight when a write begins, so
every write frame's acknowledgment is the one before it - already waiting, so
reading it paces nothing. That is why the 50 ms after each frame is kept: it
was dropped at first, on the reasoning that waiting for the acknowledgment
waits anyway, and the review found that under this reading frames would go out
back to back. CHIRP never notices the off-by-one, because every byte involved
is `0x06`, and neither does this driver - which treats no acknowledgment as
proof of anything: every written block is read back in the 0x40 window it
falls in before a write is called done.

Some later radios drop the byte at `0x1FCF` when the tail of memory is read in
0x40 blocks. CHIRP detects it as `0xFF` at that address and reads the last 0x40
bytes in sixteens; so does this driver. The test is not specific: any radio
whose `0x1FCF` is merely erased takes the slow path too, which costs three
reads and is CHIRP's own behavior. The synthetic image is one by construction.
The BF-A58S holds `0xFF` there, the byte after its third band's limits, and
whether it also drops a byte its capture cannot say - `0x1FD0` is `0xFF` as
well, so the shifted read would look the same.

## Findings

Things that looked one way until they were checked.

- **CHIRP cannot read a power selector of 3.** `get_memory` means to fall back
  to High: its `except IndexError` handler logs the value and picks the first
  level. But the log line formats `_mem.power`, which this struct does not have
  - the field is `lowpower` - so the handler raises `AttributeError` itself and
  the channel cannot be read at all. The layout file said "falls back to High"
  until the fixture generator asked CHIRP. boofwang decodes a 3 as High, which
  is what CHIRP meant, labels that a display claim, and leaves the selector
  exactly as found unless the power is changed. No capture contains one.
- **The ident is not the unit, and not even the model.** The UV-82 on the
  bench, firmware `N822413`, sends `aa 30 79 04 00 05 20 dd` - the same eight
  bytes as both UV-9R captures and the BF-A58S. The Radioddity UV-5G on the
  bench sends `aa 44 46 04 00 04 70 dd`, the UV-9G's. The ident names a hardware
  generation. A comment in the UV-82 driver that called it per-unit was wrong
  and has been corrected; this driver fingerprints the unit separately.
- **The firmware window holds no firmware.** All 0xFF on the 2017 UV-9R and
  `???????` on every 2018-2019 unit. The UV-5R family's members are told apart
  by that window; this family's cannot be, and CHIRP does not try. The
  question marks are read as no firmware rather than shown as one. The 2017
  unit's 6+power-on message, two lines before it, says `160823N` and `WP970I`:
  the radio calls itself a WP970I.
- **Empty is the first byte.** On both UV-9R captures, 106 of 128 slots are a
  stale 155.700 MHz record (`ff 00 57 15 00 00 57 15 ...`) behind a single
  0xFF. That is CHIRP's empty test and evidently the factory's, so a cleared
  slot is marked the same way and the rest is left as found - not CHIRP's
  `set_memory`, which fills both records with 0xFF.
- **Programming an empty slot starts from zeros.** The encoder patched the
  record already in the slot, which is right for an edit and wrong here:
  behind an empty marker is erased flash or the stale template, and on erased
  flash every icon flag and unknown bit reads as set and the power selector
  reads 3, which decodes as High. A new High channel kept the 3 - which CHIRP
  cannot read - and the tone words kept `0xFFFF`. The adversarial review found
  it on the first erased slot of every capture. A slot that was empty is now
  programmed from zeros, as `set_memory` programs every record, and the
  synthetic fixture carries CHIRP's bytes for two such creates.
- **The magic is not this family's alone.** `uv5r.py` sends
  `50 BB FF 20 14 04 13` to the BF-F8HP, an 8 W radio of the UV-5R family
  whose selectors match this family's by index, so its bytes would round-trip
  and it would be written against a 5 W table. Its firmware window holds a
  real version string where every capture of this family holds none, so a
  radio reporting one is now read and not offered for writing.
- **8,200 bytes is not this family's alone.** CHIRP's MURS-V1, GMRS-V2 and
  UV-6R are built on `baofeng_common.py` with the same 0x2000 and the same
  appended ident, and lay their channels out differently. Their CHIRP images
  opened as a UV-9R by size until the review tried them. A CHIRP image naming
  a radio outside this family's classes is now refused, and the family's own
  siblings are listed by name.
- **A name can hold 0xFF in the middle,** which `get_memory` reads as a space.
  The UV-82 driver's name field stops at the first 0xFF instead, which agrees
  with CHIRP on every name without a gap; this family follows the parser it was
  checked against, and writes idempotently so such a name survives a round
  trip.
- **Shift against split is CHIRP's question about CHIRP's bands.** `get_memory`
  calls a channel a split when receive and transmit sit in different
  `VALID_BANDS` (130-180 and 400-521 MHz). The UV-9G's schema lists GMRS windows
  first, so asking the display bands would turn every repeater pair into a
  split; the decoder asks `VALID_BANDS`, and GMRS repeaters read as +5 MHz on
  both radios.

## Writing, when it is turned on

What exists, and what the bench session has to settle:

- **Reach.** Channel records, names and the settings block. The VFOs, PTT ID
  and ANI codes, power-on message, squelch tables and band limits are read, kept
  in every backup and never sent - and so is the calibration CHIRP itself
  refuses to upload across radios. `writeScope` says so on the restore screen.
- **Which radio.** A backup must carry the fingerprint of the unit on the cable:
  a hash of `0x1F00-0x1F60`, `0x1F70-0x1F80` and `0x1F90-0x1FC0`, the three spans
  `_get_aux_data_from_radio` compares before CHIRP will upload calibration. They
  differ between the UV-9G and UV-9R Pro captures, which share a date code. The
  image being written must carry the same spans, and so must the base an edit
  was built on, so a restore of another unit's backup is refused by the driver
  and not only by the screen that calls it.
- **Which model.** Writing is offered only when the radio sends an ident a
  captured radio of the model has sent and its firmware window is empty, as it
  is on every capture of this family. An edit is also refused when the image it
  was built on does not survive a decode and re-encode, which catches bytes this
  build cannot represent. None of this is a model check, and nothing on the
  wire can be: a BF-A58S answers this magic with this ident and an empty
  window, its High and Low are the UV-9R's selectors, and its image round-trips
  cleanly - on CHIRP's capture of one, it does. What says the radio is a UV-9R
  is the connect screen's choice, as CHIRP's model list says it for CHIRP.
- **A new channel** in a slot that was empty is programmed from zeros, as
  `set_memory` programs it. A programmed record is patched, so the bits nobody
  has explained survive an edit.
- **A restore** sends the backup's own bytes for the owned blocks that differ
  from what the radio holds now. It skips the round-trip check an edit gets:
  the bytes are the radio's own, and refusing on what the radio holds now would
  block exactly the recovery a restore is for.
- **Pacing.** 50 ms after every frame before the acknowledgment is read, as
  `_upload` and `_send_block` both do.
- **Receive-only.** Written as `FF FF FF FF`, on every record that changed. A
  zero filling reads as receive-only to CHIRP and is passed on only in a record
  nothing changed; whether the firmware treats a zero transmit frequency as no
  transmit is not something CHIRP's parser can say.
- **Shape.** Diff-driven: only owned sixteen-byte blocks that changed are sent.
  That is this codebase's default and nothing about this radio settles it. The
  UV-5R needed a contiguous sweep because a byte there programs once; the UV-5R
  Mini needed its whole image because it erases a flash page. Both were found by
  writing. `writesWholeImage` switches this driver to the owned-range sweep, and
  a test shows the switch works.

## Not verified

- **No radio of this family has been connected to boofwang.** Nothing above was
  observed on a wire by this project.
- Whether a UV-9R acknowledges the magic sent as one write. CHIRP sends it that
  way, so it probably does.
- Which reading of the leading `0x06` is right, and whether the host's own
  `0x06` and the 50 ms pauses are needed or merely tolerated.
- The DTR and RTS levels on this radio's cable. CHIRP raises both; boofwang
  holds both low, as it does for every radio, because the two-pin Kenwood
  cables reset the radio when either is raised. Nobody has tried either level
  on a UV-9R.
- Whether this radio drops the byte at `0x1FCF`, and whether its sixteen-byte
  reads tell the truth - the UV-5R's do not.
- Whether a sparse write is safe, and whether a byte reprograms. The write shape
  is the first thing the bench session finds out.
- Whether the firmware treats a zero transmit filling as receive-only, and what
  it does with a power selector of 3.
- What a DTCS word past the 105-code table means. CHIRP cannot read one; it is
  shown here as no tone on that side and kept exactly as it is.
- Whether a UV-9R stores Low as 2. CHIRP says so, Baofeng publishes three
  levels, and no capture has a Low channel.
- Whether seven-character names display on every UV-9R. A UV-9R Pro showed
  seven in CHIRP issue 9932; the WP970I and UV-82WP keep six.
- What the UV-9R Plus and UV-9R Pro units that never answer this magic speak.
- Settings outside the settings block - the power-on message, VFOs, band limits,
  PTT ID and ANI codes, squelch tables - are not offered, and the power-on
  message is decoded only.
- Files CHIRP saved before it had metadata, with the model name appended after
  the ident (0x2010 bytes, like the 2017 capture): boofwang does not open them.
- No Bluetooth, and no dongle route: the jack is a screw-in connector, not the
  two-pin plug a clip-on dongle fits.

## The bench session that would settle it

Read first, with the development serial bridge running:

```bash
BOOFWANG_HW=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX pnpm vitest run test/hardware/uv9r.spec.ts
```

It identifies, reads twice, requires the two reads to agree byte for byte and
the image to round-trip, and prints the ident, the firmware window, the
dropped-byte flag, the sha256 and the unit fingerprint. Record them here with
the adapter and the carrier, and the reads that failed as well as the ones that
agreed. A read with an independent reader outside the app is the strongest
form of this and is worth the trouble.

Then save that baseline to a file, and run the write cycle:

```bash
BOOFWANG_HW=1 BOOFWANG_HW_WRITE=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX pnpm vitest run test/hardware/uv9r.spec.ts
```

It shortens one channel name, writes it, reads the radio in a fresh session and
requires that only that name moved - its whole tail included, which is the test
that found the UV-5R's write shape - then restores with no base image and
requires the original sha256. Only after that passes does the registry line
pass `enableWrite: true`, with a comment saying what the write path reaches,
and `test/app/ui-features.spec.ts` loses this radio from its read-only list.
