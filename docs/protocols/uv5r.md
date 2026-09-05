<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Baofeng UV-5R - notes

Offsets transcribed from CHIRP's `uv5r.py` (GPL-3.0). See
[../provenance.md](../provenance.md). The memory map, block protocol and every
quirk are the [UV-82's](uv82.md) - or rather the UV-82's are this radio's, which
is the point of the next section. This file records what is different, and what
has and has not been verified.

**Nothing here has been verified on hardware.** The driver is read-only for that
reason and for no other. What is written below is transcription and reasoning;
where a number came off a wire it says which wire, and it was never this radio's.

The connect screen also offers this radio through a clip-on BLE-to-serial
dongle, untested - see [ble-dongle.md](ble-dongle.md).

## The family is named after this radio, and boofwang got to it last

CHIRP's `BaofengUV5R` is the base class. `BaofengUV82Radio` and
`RadioddityUV5GRadio` are subclasses of it that change the ident magic, the
accepted firmware strings and the band plan, and nothing else. boofwang
implemented the UV-82 first, so the shared code lives in `lib/radios/uv82/` and
this driver is 30 lines that hand it a magic list, a schema and a classifier.

That ordering is worth stating plainly because it decides how much the existing
hardware verification is worth here. The layout this driver uses is not the
UV-82's layout assumed to fit a UV-5R; it is `MEM_FORMAT` out of `uv5r.py`,
which is the UV-5R's own, and which the UV-82 and UV-5G captures happen to have
confirmed on two radios that share it. What that does **not** establish is
anything this radio does for itself: which magic it answers, what its firmware
string says, whether its band edges are what CHIRP believes.

## Not to be confused with the UV-5R Mini

boofwang supports both, and they share nothing. The Mini is a UV-17 Pro family
radio: 115200 baud, obfuscated 64-byte blocks, a 33 KB image, an ASCII
handshake. This radio is 9600 baud, plain blocks, 6,472 bytes, a seven-byte
binary magic. Same shelf at the same retailer, two unrelated memory formats.

## One magic, three radios

This is the hard part of this radio, and the reason its classifier is stricter
than its siblings'.

`UV5R_MODEL_291` (`50 BB FF 20 12 07 25`) is `_idents` for three registered
CHIRP models:

| CHIRP class | Sold as | Power levels |
|---|---|---|
| `BaofengUV5RGeneric` | UV-5R, and seven resellers' badges | two: 4 W / 1 W |
| `BaofengBFF8HPRadio` | BF-F8HP, UV-5XP, GA-5S, TI-F8+, TS-T9+ | three: 8 W / 4 W / 1 W |
| `IntekKT980Radio` | KT-980HP | three |

The UV-82 and UV-5G have no such problem: their magics admit one power layout
each, so their firmware string is only ever confirming what the magic already
settled. Here the magic settles nothing and the firmware string has to carry
the whole distinction - through a two-bit `lowpower` field that means different
things depending on the answer.

And the string cannot always carry it. `N5RV` is in `BASETYPE_UV5R` **and** in
`BASETYPE_F8HP`. A radio reporting it is a 4 W UV-5R or an 8 W BF-F8HP, and
nothing on the wire says which. CHIRP resolves this by making the user pick a
model from a list; boofwang has no list at that point and so declines: the
classifier returns null, the radio is read and backed up, and nothing is
written. Guessing "plain" would put a Low channel back at 8 W on a radio whose
owner never touched it.

`BFP3V3 F`, `N5R-3`, `N5R3`, `F5R3`, `BFT` and `BFP3V3 B` are unambiguous
tri-power and are identified as such - named in the refusal rather than
rejected as unknown, so the user is told which radio they have.

Note that the UV-5G's magic differs from this one **in a single byte**: `0x06`
against `0x07` in position five. CHIRP takes that seriously enough to keep the
UV-5G's magic in an `IDENT_BLACKLIST` that its UV-5R driver probes for after
every real ident has failed, purely so it can tell the user they picked the
wrong model. boofwang does not probe - the connect screen already made the user
choose, and a wrong choice fails to identify rather than reading garbage - but
the adjacency is why a wrong pick must fail loudly and does.

## Two magics, one radio

`_idents` is `[UV5R_MODEL_291, UV5R_MODEL_ORIG]`. The second,
`50 BB FF 01 25 98 4D`, is what the pre-BFB291 radios of 2012 answer.

Carrying it is what made `Uv5rFamilyModel.magic` into `magics`, the only change
this radio forced on shared code. The alternative was leaving an original UV-5R
unable to connect at all, which is a worse thing to tell its owner than "read
only" - a backup is exactly what a radio nobody can write needs.

Those radios are read and never written. CHIRP uploads a different set of
auxiliary ranges to them (`0x1EE0-0x1EF0` and `0x1FC0-0x1FE0` rather than the
modern set) and refuses outright when an image's era does not match the radio's.
None of that has been exercised here, so `classifyBasetype` returns null for
BFB below 291, and for a BFB string whose number cannot be parsed at all - the
fail-closed shape the UV-5G's adversarial review had to add.

## What the magic and the firmware still cannot tell you

Behind `UV5R_MODEL_291` with a `BASETYPE_UV5R` firmware string also sit:

- **`RadioddityGT5RRadio`** - a GMRS radio whose firmware restricts transmit to
  the GMRS channels. boofwang would show it the plain UV-5R's ham band plan.
- **`RadioddityUV5RX3Radio`** - tri-band, with 200-260 MHz where this schema has
  nothing.
- **`BaofengUV5GPro`** - 108-136 MHz airband receive in AM, a mode this schema
  does not list.

CHIRP cannot separate these either: `match_model` returns `False` on all three
so that the user has to say which radio they have. boofwang shows the plain
UV-5R's plan.

While this driver is read-only that is a display claim and nothing more - no
frequency reaches a radio. **It has to be settled before a channel is ever
written**, and it is the first item on the list below.

There is a fourth case the image itself could answer and this driver does not.
CHIRP reads byte `0x03` of the ident block: `0x02` there means a 220 MHz radio,
whose bands are 130-176 and 220-260 MHz rather than VHF and UHF. That byte is in
every image boofwang reads, so the variant is detectable; modeling it needs
`rfFor(doc)` and a way to get an ident byte into the decoded document, and it
has not been done. A 220 MHz UV-5R currently reads correctly and is described
wrongly.

## What differs from the UV-82

- **The magics**: two of them, above, against the UV-82's single
  `50 BB FF 20 13 01 05`.
- **UHF stops at 520 MHz**, where the UV-82's `_uhf_range` is 400-521. One
  megahertz, and the reason the two radios do not share a band constant even
  though their VHF ranges are identical.
- **No single-PTT switch and no VFO/MR lock.** Both bytes are decoded and
  carried through like every other, but neither control is offered: CHIRP
  exposes `singleptt` and `vfomrlock` only to the UV-82 family, the UV-82HP and
  the F-11. This radio has one PTT button.
- **Basetypes are matched by containment, not prefix**, as on the UV-5G, and for
  the same CHIRP-shaped reason (`any(type in rid ...)` in `model_match`).

## What has actually been checked

Against the committed **UV-5G** capture, firmware `HN5RV011`, a real radio read
over an FTDI cable - because `RadioddityUV5GRadio` has no memory map of its own,
these are UV-5R bytes in a UV-5G's shell:

- All 41 channels decode identically to CHIRP's own `bitwise` parse of the same
  bytes using `MEM_FORMAT` from **uv5r.py** - name, rx, tx, bandwidth, power,
  skip and both tones. The comparison fixture is `uv5g-chirp-decode.json`,
  produced by `scripts/dump-uv5r-channels.py`.
- `encode(decode(image), image)` is byte-identical across the image, with and
  without settings decoded.
- The eleven receive-only channels keep their `FF FF FF FF` transmit fill
  through a re-encode.
- This driver and the hardware-verified UV-5G driver produce identical channel
  documents from those bytes, which is the closest thing available to a
  statement that the schema differences between them do not reach the decoder.

Against nothing at all: everything in the two sections above about magics and
firmware strings. Those are transcribed from `uv5r.py` and tested only against
themselves.

## First bench session, 2026-09-05: read only

A **Baofeng UV-5R**, labelled as such on the case - which matters, because the
firmware string cannot say so. Read over an FTDI cable through the development
bridge by `test/hardware/uv5r.spec.ts`. Nothing was written.

| | |
|---|---|
| Firmware | `HN5RV011!!!` |
| Ident bytes | `aa 30 76 04 00 05 20 dd` |
| Magic | `50 bb ff 20 12 07 25` (`UV5R_MODEL_291`) - implied, not observed |
| Image | 6,472 bytes |
| sha256 | `d783efb5c2b81c938e5b42483282aeff8bc791a8e8a58944865cebfe5dbc05ce` |
| Dropped byte | yes |
| Classified | refused as ambiguous, so read-only |

What it settles:

- **A UV-5R answers this driver.** The first one to. Two complete sessions,
  identify and read, and the ident block prefixes the image as it should.
- **Two reads agree byte for byte**, same sha256. That is what a read path has
  to do before a write is worth discussing.
- **`encode(decode(image), image)` is byte-identical on this radio's own
  bytes.** The invariant had only ever been checked against UV-82 and UV-5G
  captures, which are the same memory map in a different shell.
- **Not a 220 MHz unit.** Ident byte `0x03` is `0x04`, where CHIRP reads `0x02`
  for the 220 MHz radio. So the band question above stays open in general and
  is answered for this unit.
- **The ambiguity is not theoretical.** The section above wondered what
  proportion of real UV-5Rs report the ambiguous `N5RV`. The first one seen
  does: `HN5RV011!!!` contains it, and the radio was refused a write by a rule
  written before any UV-5R had been plugged in. A sample of one, and it landed
  on the expensive case.

What it does not settle: which magic actually drew the acknowledgement - that
is derived from the firmware not being pre-BFB291, because `identify` returns
the ident block and not the magic that fetched it. No independent reader
outside the app has read the same bytes. The capture is not committed. And
nothing has been written, so the band plan and the
GT-5R/UV-5RX3/UV-5G Pro question are exactly where they were.

## First write session, 2026-09-05: three findings, and writing enabled

Same radio, same cable, immediately after the read session. It ended with the
radio back at `d783efb5c2b81c938e5b42483282aeff8bc791a8e8a58944865cebfe5dbc05ce`,
its exact pre-write image, and with writing enabled - but only after three
separate things had to be fixed, two of which looked like the radio refusing to
store what it was sent.

**1. A byte here programs once, and a sparse write cannot undo itself.** Slot 2
had no name: seven bytes of 0xFF. Renaming it to `BOOF` landed and verified. The
restore, writing 0xFF back, was acknowledged and silently ignored - twice, at the
same address. Then 0x00 was tried, and the answer arrived in one frame:

| | |
|---|---|
| sent | `00 00 00 00 00 00 00` |
| read back | `42 4f 4f 46 00 00 00` |

The three bytes still holding 0xFF took the 0x00. The four already holding `BOOF`
did not, though 0x42 to 0x00 only clears bits. So this is not "cleared bits only"
- it is one program per erase, and an acknowledgement says nothing about it.

The consequence is not a failed restore, it is silent corruption: shorten a name
on a diff-driven write and the tail of the old one stays. Rename `GMRS1` to
`BOOF` and the radio reads `BOOF1`. **This is why the UV-5R carries
`writesWholeImage`.** CHIRP never had the problem because it never writes
sparsely - `_ranges_main` is three contiguous spans swept end to end, and
whatever erase this memory needs comes with the sweep.

**2. The sweep works.** With `writesWholeImage` set, writing the reconstructed
baseline put the name field back to 0xFF and the whole image back to its original
sha256, confirmed by a fresh read in a new session. That is the fix, verified.

**3. The verification was reading the wrong memory, and that is what looked like
a settings failure.** Every sweep failed its verification at radio `0x0e20` with
the same pair:

| | |
|---|---|
| sent | `03 00 00 03 00 00 05 00` |
| read back | `00 00 00 01 05 00 01 00` |

It was never a failed write. The last run wrote the baseline *over itself* - the
radio already held the sent bytes - and it still "failed". A read-only probe
settled it:

| Read | Returned |
|---|---|
| `0x0e00` size `0x40` | matches the image exactly |
| `0x0e10` size `0x10` | the bytes that belong at `0x0e40` |
| `0x0e20` size `0x10` | the same bytes again |
| `0x0e40` size `0x10` | the same bytes, correct this time |

**A `0x10` read here returns another block's contents while echoing the address
it was asked for**, so the header check that exists to catch a slipped block saw
nothing wrong. Writing is a `0x10` conversation and reading is a `0x40` one, and
verifying a `0x10` write with a `0x10` read was the mistake. Verification now
reads the `0x40` window each written block falls in - the size the read path has
always used, and the reason every read session was clean while only verification
lied. Fewer round trips than before, too.

With that fixed the whole cycle passes on the bench unit through the driver the
registry builds, nothing forced: identify, read, rename a channel, sweep, verify
259 blocks, read again in a fresh session showing exactly the four name bytes
moved, restore, and back to `d783efb5`. Run it with `BOOFWANG_HW=1
BOOFWANG_HW_WRITE=1` against `test/hardware/uv5r.spec.ts`.

**The ambiguity is settled against the radio, not the string.** `HN5RV011!!!`
still names a 4 W UV-5R and an 8 W BF-F8HP alike and nothing on the wire says
which. Refusing every such radio was a proxy for the real property, and an
expensive one - it made the first UV-5R anyone plugged in read-only. So
`classifyBasetype` claims the two-power radio and `writeImage` checks it: it
decodes and re-encodes the image the radio just handed over and refuses if a
single byte moves. `lowPower` is a two-bit field, so a tri-power Mid channel
holds a value this build's power table has no entry for and cannot survive that
round trip. A BF-F8HP with a Mid channel is refused on its own bytes; one whose
channels are all High and Low round-trips, and writing it as two-power is then
correct rather than lucky.

## Not verified

Everything that needs a radio:

- **Only one UV-5R has answered, and only one magic.** The session above drew
  an acknowledgement without ever needing `UV5R_MODEL_ORIG`, so the fallback to
  it is still exercised only by a scripted fake port - as is every path for a
  pre-BFB291 radio.
- **One firmware string has been read off one radio.** Every other classifier
  case is still a transcription of `BASETYPE_*` from `uv5r.py`. The one real
  string reports the ambiguous `N5RV`, which is the answer nobody wanted to the
  question of how often that happens: if it is typical rather than unlucky, the
  read-only-on-ambiguity rule is more expensive than it looks and deserves a
  better answer than "decline".
- **The band edges are CHIRP's numbers**, not measured ones.
- **Only one radio, and only one firmware string.** Everything above is one
  bench UV-5R reporting `HN5RV011!!!`. The pre-BFB291 path, `UV5R_MODEL_ORIG`
  and every other `BASETYPE_*` case are still transcriptions exercised only by a
  scripted fake port.
- **No reader outside the app has read these bytes.** The two reads that agree
  are both boofwang's, and the capture is not committed - it has not been
  scanned for names and DTMF identities.
- **The dongle route is offered and untested**, as it is for every radio that
  offers it.

## What a bench session would settle, in order

`test/hardware/uv5r.spec.ts` does steps 1-3 and prints the numbers for this
document. It reads and never writes. The session above did 1, 2 and half of 3.

1. ~~**Which magic.**~~ Done, with a caveat: `UV5R_MODEL_291` is implied by the
   firmware rather than observed, because `identify` does not report which of
   its magics drew the `0x06`. Ident byte `0x03` was `0x04`, so not 220 MHz.
2. ~~**The firmware string**, and what `classifyBasetype` makes of it.~~ Done,
   and it is the bad case: `HN5RV011!!!` contains `N5RV`, so the ambiguity is
   real and has to be dealt with before writing.
3. **Two reads, compared** - done, byte-identical - plus a third with an
   independent reader outside the app, matching sha256, which has not been
   done. Then commit the capture as
   `test/fixtures/images/uv5r-<firmware>.bin`, scan it for names and DTMF
   identities first, and regenerate the cross-check fixtures with
   `scripts/dump-uv5r-channels.py` and `scripts/dump-uv5r-settings.py`.
4. **Settle which UV-5R it is.** A GT-5R or a UV-5RX3 behind the same ident is
   the open question that blocks writing, not the write path itself.
5. **An adversarial review**, before the first write, as the UV-5G had.
6. **Then** `enableWrite: true` in the registry, and only for the firmware
   strings that survived step 2.
