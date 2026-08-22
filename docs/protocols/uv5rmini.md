<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Baofeng UV-5R Mini — notes

Offsets transcribed from CHIRP's `baofeng_uv17Pro.py` (GPL-3.0). See
[../provenance.md](../provenance.md).

## Two radios, near-identical names

The single most important fact about this radio is that there are two of them,
and CHIRP carries them as separate classes:

| | CHIRP `UV5RMini` | CHIRP `BF5RM` |
|---|---|---|
| MODEL | `UV-5R Mini` | `5RM` (sold as UV-5RM) |
| Ident magic | `PROGRAMCOLORPROU` | `PROGRAMBFNORMALU` |
| Memory regions | 3 — `0x0000/0x8040`, `0x9000/0x0040`, `0xA000/0x01C0` | 4 — as left, plus `0xD000/0x0040`, and `0xA000` is `0x02C0` |
| Total | `0x8240` | `0x8380` |
| Channels | 999 | 1000 |
| Power levels | High 5 W, Low 1 W | High 8 W, Low 1 W, **Medium 5 W** |

5 W is "High" on one and "Medium" on the other, so reading one as the other
mislabels every channel's power as well as asking for a region that is not
there. boofwang tries both idents and lets the radio decide, which is what
CHIRP's `_idents` list does.

`UV-5RM Plus` is a third class again: different third magic, and obfuscation
key 13 rather than 1. It is not supported here.

## Transport

115200 baud, 0x40-byte blocks. Frame is `cmd + 16-bit **big-endian** address +
one length byte` — big-endian, unlike everything else in this codebase, because
CHIRP builds it as `struct.pack(">i", addr)[2:]`.

Handshake: ident magic → `0x06`, then three magics — `0x46`→16 bytes,
`0x4d`→15 bytes, and a 25-byte one beginning `SEND`→1 byte.

Read is `0x52`; the reply repeats the four-byte request header before the
payload, and boofwang compares it rather than discarding it, which is what
catches a read that has slipped a frame.

Every payload passes through CHIRP's `_crypt` with table entry 1, `"CO 7"`: a
rotating four-byte XOR that leaves a byte alone when the key byte is a space,
or when the byte is `0x00`, `0xFF`, the key byte, or the key byte inverted.

## Channel records

32 bytes each from `0x0000`. `lbcd` frequencies in units of 10 Hz, absolute
transmit frequency (the offset is derived), `ul16` tone words.

Three traps, all confirmed against CHIRP:

- **The bit called `wide` means narrow.** `MODES = ["NFM", "FM"]` and
  `mem.mode = _mem.wide and MODES[0] or MODES[1]`, so a set bit selects
  `MODES[0]`, which is NFM. The write side agrees: `_mem.wide = mem.mode ==
  MODES[0]`.
- **The DTCS table has 105 entries, not 104.** `DTCS_CODES =
  tuple(sorted(chirp_common.DTCS_CODES + (645,)))`. The extra code lands at
  index 93, shifting every code above it by one.
- **A tone word is one flat number line, with no flag bit.** 0 and 0xFFFF mean
  no tone; below 600 it is a 1-based DTCS index, offset by 106 for reversed
  polarity; 600 and above it is CTCSS already in tenths of a hertz. The radio
  writes 0 for "none" but blank memory reads 0xFF, so both have to be accepted
  — treating only 0 as empty reports a 6553.5 Hz tone on every blank channel.

A channel is unused when its **first byte alone** is 0xFF. Transmit is
inhibited when all four transmit-frequency bytes are 0xFF **or** all four are
0x00. AM is not stored anywhere: it is derived from the receive frequency
falling in the air band.

Names are 12 bytes at `+0x14`, padded with 0xFF. CHIRP maps both 0xFF and 0x00
to spaces and then strips the trailing ones, rather than treating them as
terminators, so a name containing one keeps everything after it.

## Verified session, 2026-08-20

| | |
|---|---|
| Answers to | `PROGRAMCOLORPROU` — the **UV-5R Mini**, not the 5RM |
| Reports itself as | `5RMINI  +L00000` (the 0x4d reply) |
| Adapter | FTDI FT232R, 115200 8N1 |
| Image | 33,344 bytes = `0x8240`, exactly the three-region total |
| Read | 521 blocks in 21 s |
| sha256 | `31672672aad217fa771deca2be511d179da192b6eb9e5ace67fd9c0d07175cc0` |

Confirmed by this session:

- **The three-region map is right.** 0x8240 bytes came back, and every one of
  the 521 replies carried the four-byte request header the driver checks.
- **The app's read is byte-identical to an independent raw read** taken outside
  it with a separate Python implementation. Same sha256.
- 21 factory channels decode: five on 2 m, sixteen on 70 cm, all unnamed, no
  tones, channels 1-16 High and 17-21 Low.
- **Decode agrees with CHIRP field for field** on these real bytes. The same
  33,344 bytes parsed with CHIRP's own `bitwise` engine give identical
  frequencies, tone words, `lowpower`, `wide`, `scan` and names for all 21.
- The exported CHIRP CSV round-trips: CHIRP parsed all 21 channels and
  re-exported the file byte for byte identically
  (`scripts/crosscheck-chirp-csv.py`).

The traffic is worth recording because it is exactly predictable: 2127 bytes
out (16-byte ident + 27 bytes of magics + 521 x 4-byte reads) and 35,461 in
(33 bytes of handshake replies + 521 x 68). Any deviation is a dropped frame.

### Getting there

The radio was unreachable for the first attempts: every byte sent came back
byte-identical, at all four baud rates and with the handshake lines both
asserted and cleared. That is a cable shorting transmit to receive, not a
radio, and the FTDI adapter was the same one that had read a DM-32UV minutes
earlier — so the fault was at the plug rather than the adapter. The 2.5 mm
connector was not fully seated. Reseating it fixed it, and the wire-level echo
test is what distinguished "the plug is not in" from "the firmware is wrong".

## Writing

**This radio cannot take a sparse write.** It erases a flash page before
programming and writes back only the block it was handed, so sending one block
wipes everything that shared that page.

This was found the hard way, on a real radio. A single 0x40 block written to
name channel 1 erased **channels 3 to 21**. The write looked perfect while it
happened - every frame acknowledged, every block read back and compared, and the
app reported "1 block written, all read back and matched" - because the block
that was sent genuinely was correct. Only a full read afterwards showed the rest
was gone. The radio was recovered from the backup taken minutes earlier, which
is the whole reason a backup is required before any write.

So this driver does what CHIRP does: **the entire image, every block, in order**,
every time. 521 blocks, roughly 17 seconds to write and as long again to verify.
`capabilities.writesWholeImage` marks it so the confirmation says "Send 521
blocks" rather than describing the size of the edit.

The other three radios here take a sparse write happily, which is what makes a
one-channel edit cost one block on them. Do not carry that design back here.

Frames are `W` (0x57) + a 16-bit big-endian address + length + the **obfuscated**
payload, acknowledged with 0x06 per block. The obfuscation applies on the way out
as well as the way in.

### Over Bluetooth

CHIRP's `UV5RMini` has BLE support, and the difference from the cable is one
constant and one rule:

- `BLE_UP_BLOCK_SIZE = 0x80` — **uploads** use 0x80 blocks where the cable uses
  0x40 (`baofeng_uv17Pro.py:2391`). Downloads are unchanged at 0x40, and this
  driver does not invent a 0x80 read.
- A block running past the end of its region is **padded with 0xFF**. None of
  the three regions divides by 0x80 — 0x8040, 0x0040 and 0x01C0 all leave half a
  block — so every region ends in a padded one. 262 blocks instead of 521.

Everything else is identical: same handshake, same frame layout, same
obfuscation, same per-block 0x06. The reason for the larger block is that every
one costs a round trip for its acknowledgement, and a BLE round trip is far
dearer than a 115200-baud one.

CHIRP decides it is on BLE by sniffing the serial device path for `/tmp/ttyBLE…`
(`platform.py:185`), which is a desktop workaround for having no other way to
tell. Here the transport says so directly: `Transport.kind` is `'serial'` or
`'bluetooth'`, and `uploadBlockSize()` in `protocol.ts` is the only thing that
reads it.

**Nothing about the Bluetooth path has been run against a radio.** The service
UUID cannot be guessed and nobody has captured one, so the browser's device
chooser has never had a radio to list. See `lib/transport/bluetooth-uuids.ts`,
which is the single place the numbers live and the single place to change them.

## Verified write session, 2026-08-20

| | |
|---|---|
| Radio | UV-5R Mini, answers `PROGRAMCOLORPROU`, reports `5RMINI  +L00000` |
| Pre-write state | `0b029cf245415be424fb5d3b4784a9ff50c6a582c1d8e9c45fb7599cdc4ce56f` |
| Write traffic | 37,555 bytes out, 35,982 in - 521 write frames plus 521 read-backs |

1. Read through the app; matched an independent raw read.
2. Named channel 1 `BOOF`. The diff reported 12 bytes, and the confirmation
   correctly said **521 blocks** because that is what the radio receives.
3. Wrote. An independent read found channel 1 renamed and **every other channel
   byte-identical** - the thing the earlier sparse write destroyed.
4. Restored, and the radio returned to `0b029cf2...` byte for byte.

### Two behaviours worth knowing

Clearing a channel name writes 12 bytes of 0xFF where the factory image had
0x00. Both decode to no name and the radio displays neither, but a cleared name
is not byte-identical to a never-set one.

A whole-image write puts back whatever the image holds at radio address 0x9018,
a byte the radio maintains itself and changes between sessions. CHIRP has the
same behaviour for the same reason. It is one byte of runtime state, not
configuration.

### Feature write session, 2026-08-20

Five channels were programmed at once to exercise every path that had only ever
been checked against synthesised records, then read back and parsed with
**CHIRP's own bitwise engine** rather than this codebase's decoder:

| Path | What CHIRP read back |
|---|---|
| Name | all five names round-tripped |
| CTCSS | `('Tone', 88.5)` on receive and transmit |
| DTCS normal | `('DTCS', 23, 'N')` |
| DTCS **reversed** | `('DTCS', 754, 'R')` |
| Positive shift | +0.600 MHz |
| Negative shift | -0.600 MHz |
| Narrowband | `wide=1`, which CHIRP reads as NFM |
| Low power | `lowpower=1` |
| Receive-only | transmit frequency filled, reported as inhibited |

D754 matters more than it looks: it sits above the 645 insertion point in the
105-code table, which is exactly where an off-by-one in that table would show.
It round-tripped.

The radio was restored to `0b029cf2...` byte for byte afterwards.

### Not verified

- The `5RM` variant. Its ident, region map, channel count and power table are
  transcribed and unit-tested, but no 5RM has been on the cable.
- Nothing outstanding for the channel path. Creating a channel in an empty slot
  was verified on hardware: 24 bytes changed, all inside the slot, and CHIRP
  read back `scramble 0, fhss 0, sqmode 0, bcl 0` with the four unknown bytes
  clear - the erased-flash bits are cleared rather than inherited.
- Anything outside the channel array and the settings block: the two VFO entries
  at image `0x8000` and `0x8020`, the ANI and PTT-ID region at `0xA000`, and the
  gap before `0x8000`. All are read and preserved, none is decoded, and
  `ownedRanges` claims none of them. See below.

## The rest of the image

CHIRP's `#seekto` values are offsets into the **downloaded image**, not radio
addresses. The image is the three regions concatenated, which is what puts
`settings_obj` where it is:

| Image offset | Radio address | Contents |
|---|---|---|
| `0x0000` | `0x0000` | 999 channel records, 32 bytes each |
| `0x7CE0`-`0x8000` | - | gap, not decoded |
| `0x8000` | `0x8000` | VFO A (`vfo_entry`, 32 bytes) |
| `0x8020` | `0x8020` | VFO B |
| `0x8040` | **`0x9000`** | `settings_obj`, the whole 64-byte region |
| `0x8080` | **`0xA000`** | `ani_obj` |
| `0x80A0` | `0xA020` | `pttid[20]`, 16 bytes each |

`vfo_entry` holds its frequency as **one decimal digit per byte** across eight
bytes, not as BCD: `04 03 05 06 02 05 00 00` is 435.625 MHz. That is how the
offset was confirmed against a real radio - a wrong offset gives a number, a
right one gives a frequency that exists.

Radio-wide settings are decoded into `Codeplug.settings` and written back, and
verified on hardware: squelch 3 to 5 changed **exactly one byte of 33,344**, at
image 0x8040, and the radio restored to its original sha256. `encode` patches
only the named keys, so the fields this build cannot name keep whatever the
radio had - which is why the round trip is still byte-exact when nothing was
edited. Exposing them in the interface is
[issue #2](https://github.com/thebentern/boofwang/issues/2).

## Bluetooth, verified 2026-08-21

The radio can be read over Bluetooth Low Energy instead of the cable, and has
been.

| | |
|---|---|
| Service | `0000ffe0-…` — HM-10 style transparent serial |
| Write | `0000ffe1-…` |
| Notify | `0000ffe1-…`, the same characteristic |
| Identify | `PROGRAMCOLORPROU`, acknowledged `06` |
| Read | 33,344 bytes in 35.9 s, about 928 B/s |

The protocol is unchanged. Same identify string, same three magics, same `0x52`
block reads, same `CO 7` obfuscation — only the carrier differs, which is why
the driver needed no Bluetooth-specific code above the port.

### The radio advertises a name and no services

This is the part that made the browser chooser unusable long after the protocol
worked, and it is worth separating from the section below.

`navigator.bluetooth.requestDevice` matches a service filter against the
device's **advertisement**. FFE0 is not in this radio's: it was found by a GATT
enumeration, which happens after connecting and says nothing about what is
broadcast. So `filters: [{ services: [ffe0] }]` listed nothing at all, with the
radio a foot away in wireless CPS mode - the empty chooser that is
indistinguishable from a radio switched off, arrived at from the opposite
direction to the one this project kept guarding against.

What it does advertise is a name. Chrome lists it as `walkie-talkie`, so that is
what the chooser filters on now, with the service kept as a second OR-ed filter
for a unit or firmware that does broadcast it. `namePrefix` is case-sensitive
and Web Bluetooth offers no case-insensitive form, so the casings are
enumerated rather than assumed.

The bridge has the same trap. `tools/ble-bridge/server.py` filters its scan on
the same advertised service and takes `--all` to stop doing so, which is how the
verified read below was taken. That is why the read could succeed while the
browser chooser had never once worked: they are different discovery paths, and
only one of them had been exercised.

### How the profile was established

By asking the radio, not by reasoning from convention. A GATT enumeration listed
three vendor services — `AE30`, `AE3A` and `FFE0` — and **no Nordic UART**,
which the first implementation had assumed. Sending the identify magic on each
writable characteristic and watching for the acknowledgement settled it: `FFE0`
replied `06` and nothing else did.

`AE30` is worth knowing about. Writing to `ae01` returns the bytes just written,
unchanged — it is a loopback, not a protocol channel. A driver pointed at it
sees its own frames come back, which is the echo failure this project has
already misdiagnosed twice on physical cables. It is kept in the profile table,
never tried automatically, so the next person to enumerate this radio and find
`AE30` first has something to read.

`PROGRAMBFNORMALU` got no reply, which independently agrees with the variant
detection: this is the UV-5R Mini rather than the 5RM that shares its name.

### What the two reads prove

`uv5rmini-5RMINI-ble.bin` is the same radio as `uv5rmini-5RMINI.bin`, read over
Bluetooth. 33,341 of 33,344 bytes are identical, including every one of the 999
channel records. The three that differ are all in the 64-byte `0x9000` settings
block:

| Address | Field | Cable | BLE |
|---|---|---|---|
| `0x9018` | `activeVfo` | 0 | 1 |
| `0x901A` | not modelled | 0x11 | 0x01 |
| `0x9022` | `bluetooth` | 0 | 1 |

Those are the radio's own state, not the transport's doing: the `bluetooth` flag
is set in precisely the read taken with the radio in wireless CPS mode. A
standing test decodes both images and compares them channel by channel, so a
transport that ever drops or duplicates a fragment fails CI rather than
producing a plausible codeplug.

### Still not verified

- **Whether every unit advertises the same name.** One radio has been seen, and
  it said `walkie-talkie`. A second saying something else would be invisible to
  the chooser's filters, which is why the empty-chooser card offers to list
  every device in range rather than leaving it at "try again".
- **Writing over Bluetooth.** Not implemented and not offered. Read first, prove
  the round trip, then write — the order every other radio here followed.
- The `0x80` upload block size and its `0xFF` padding are transcribed from
  CHIRP and exercised against a fake. No radio has been written to over BLE.
- Throughput is about a fortieth of the cable's. The transport's timeouts were
  tuned for 115200 baud and survived a full read, but a slower link or a busier
  adapter has not been tried.
