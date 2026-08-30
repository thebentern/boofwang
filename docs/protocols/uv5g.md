<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Radioddity UV-5G - notes

Offsets transcribed from CHIRP's `uv5r.py` (GPL-3.0). See
[../provenance.md](../provenance.md). The memory map, block protocol and every
quirk are the [UV-82's](uv82.md); this file records only what is different and
what was verified on this radio.

## Four radios answer to "UV-5G"

The single most important fact about this radio is its name, which it shares
with three others on two incompatible protocols:

| Sold as | CHIRP class | Protocol |
|---|---|---|
| Radioddity UV-5G | `RadioddityUV5GRadio` | classic UV-5R: 9600 baud, plain blocks |
| Baofeng UV-5G Pro | `BaofengUV5GPro` | classic UV-5R, plus air band |
| Radioddity UV-5G Plus | `UV5GPlus` | UV-17 Pro: 115200 baud, obfuscated |
| Baofeng UV-5G Mini | `UV5GMini` | UV-17 Pro, near-identical to the UV-5R Mini |

The name cannot decide; the ident magic can. The bench unit ignored every
UV-17 Pro family ident (`PROGRAMGMRS5RMIU`, `PROGRAMCOLORPROU`,
`PROGRAMBFGMRS05U`, `PROGRAMBFNORMALU`) and acknowledged the classic
`50 BB FF 20 12 06 25` - `UV5R_MODEL_UV5G`, which no other CHIRP model uses.
That is what settled which driver this radio gets, and it is the whole reason
the probe was run before any code was written.

## Verified read, 2026-08-30

| | |
|---|---|
| Radio | Radioddity UV-5G, firmware `HN5RV011` |
| Ident | `aa 44 46 04 00 04 70 dd` |
| Adapter | FTDI FT232R, 9600 8N1 |
| Image | 6,472 bytes (8 ident + 0x1800 main + 0x140 aux) |
| Baseline sha256 | `e6727a8649c57f59f9b3ddec876c96d389de856c1dde02809737512be522a586` |

Two consecutive reads through the driver's protocol path were byte-identical,
and a third read taken with an independent Python implementation outside the
app produced the same sha256. The capture is the committed fixture, parsed
with CHIRP's own `bitwise` engine to derive the expectations in
`uv5g-chirp-decode.json` and `uv5g-chirp-settings.json`; all 41 factory
channels and 50 settings fields agree with CHIRP field for field.

One read out of three stalled mid-block about ten blocks in - 27 of 64 payload
bytes arrived, then silence - and succeeded on retry with an identical image.
Recorded here because the next person to see a partial block should try again
before suspecting the radio.

## What differs from the UV-82

- **The ident magic**: `50 BB FF 20 12 06 25` against the UV-82's
  `50 BB FF 20 13 01 05`.
- **The firmware window holds the version once.** `block1[48:62]` of the aux
  area reads `HN5RV011` followed by 0xFF padding, where the bench UV-82 held
  `N822413N822413` - the version doubled. The parser stops at the first
  non-printable byte, so both spellings read the same way.
- **Basetypes are matched by containment, not prefix.** CHIRP's `model_match`
  tests `type in rid`, and this radio is why boofwang follows it here:
  `HN5RV011` contains `N5RV` but starts with no entry of `BASETYPE_UV5R`. The
  same strings mean tri-power radios behind *other* magics (`N5RV` is also in
  `BASETYPE_F8HP`, `N5R2` in `BASETYPE_UV82HP`); behind this magic they are
  the plain two-level firmware, which is why the classifier never reports
  tri-power.
- **The band plan is GMRS.** The schema lists the two transmit windows
  (462.5500-462.7250 and 467.5500-467.7250 MHz) ahead of the 130-176 and
  400-520 MHz receive spans, because every consumer takes the first band that
  contains a frequency. Transmit outside the windows draws the regulatory
  warning, never an error - the licence is the operator's, and the refusal to
  transmit there is the firmware's. That refusal is the vendor's Part 95E
  claim; boofwang has no way to test it from the bench and does not try.
- **No single-PTT switch.** The byte is decoded and carried through like every
  other, but the control is not offered: `f2b.singleptt` selects between the
  UV-82's two PTT buttons, and this radio has one.

## The factory codeplug is the GMRS story in bytes

As shipped: GMRS 1-22 simplex, REPTR 1-8 as +5 MHz splits into the 467 window,
and NOAA 1-11 receive-only. Three details worth keeping:

- The eleven NOAA channels carry `FF FF FF FF` in the transmit frequency - the
  one receive-only marker CHIRP recognises, straight from the factory. The
  fixture therefore exercises the decode path that matters most without any
  synthetic patching.
- GMRS 8-14, the 467 MHz interstitials, ship narrow and low power, which is
  the only legal way to use them. boofwang carries that through but cannot
  stop an edit from changing it; the radio's own firmware is the enforcement.
- A bare `.bin` of this radio is indistinguishable from a UV-82's by size -
  both are 6,472 bytes - so `RAW_LAYOUTS` deliberately omits this radio and a
  raw dump opens as a UV-82. A `.bwp` or CHIRP `.img` carries the identity and
  opens correctly; CHIRP `.img` metadata naming `RadioddityUV5GRadio` is
  honoured.

## Verified write session, 2026-08-30

The write path is the UV-82's, block for block. The full cycle, verified at
each step by reading the radio with a separate Python implementation outside
the app:

1. **Baseline.** Read through the driver, byte-identical to the committed
   fixture - the radio had not changed since it was captured.
2. **Edit.** Channel 2 renamed `GMRS1` to `BOOF`. The diff came to one
   16-byte block.
3. **Write.** One block sent to radio address `0x1010`, acknowledged, read
   back and compared.
4. **Independent check.** A raw read found **exactly 5 differing bytes out of
   6,472**, all in slot 2's name field at image `0x1018`-`0x101C`:
   `47 4d 52 53 31` -> `42 4f 4f 46 ff`. Nothing else moved.
5. **Restore.** The fixture written back through the read-first restore path -
   one block again - and the radio returned to `e6727a86...`, byte for byte,
   confirmed by both the driver and the independent reader.

The committed bench spec, `test/hardware/uv5g.spec.ts`, runs the same cycle
end to end against whatever the radio holds, and passed in 64 seconds.

## First contact can be refused

The one defect this radio surfaced was in boofwang, not in it. After the unit
had sat idle for half an hour, the first magic of a session was answered with
`0xfe` - every time, across separate sessions - by a radio that then
acknowledged the very next attempt without complaint. The first exchange
evidently wakes it rather than reaching it.

The family's `identify` now drains the line and tries the magic up to three
times, a second apart, which is the same structure CHIRP's `_ident_radio`
has. The echo check is unchanged and still fails on the first attempt: a
shorted adapter answers every retry identically, and retrying against it is a
slower way to learn the same thing.
