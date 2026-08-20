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

## Not verified

- Writing. `writeImage` and `encode` throw.
- The `5RM` variant. Its ident, region map, channel count and power table are
  transcribed from CHIRP and exercised by unit tests, but no `5RM` has been on
  the cable — only the UV-5R Mini.
- Tones, repeater shifts and named channels on real hardware: this unit is
  factory default, so every channel is simplex, unnamed and tone-less. Those
  paths are covered by synthesised records cross-checked against CHIRP.
- Anything outside the channel array. Settings, VFOs and the two small tail
  regions are read and preserved but not decoded.
