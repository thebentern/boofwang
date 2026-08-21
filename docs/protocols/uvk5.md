<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Quansheng UV-K5 — hardware notes

Protocol and layout are transcribed from CHIRP's `chirp/drivers/uvk5.py`
(GPL-3.0); see [../provenance.md](../provenance.md). This file records what has
actually been confirmed against a radio, as opposed to what the source says.

## Verified sessions

### 2026-08-19 — read, stock firmware 2.01.32

| | |
|---|---|
| Radio | Quansheng UV-K5 |
| Firmware string | `2.01.32` (matches the `2.01.` prefix → stock layout) |
| Adapter | FTDI FT232R, `0403:6001`, bcdDevice `0x0600`, Apple `AppleUSBFTDI` |
| Result | Full 8 KB EEPROM read in 6.1 s, no retries |
| Image sha256 | `a0dfe2ab4ec058c911f84768cf858b6e6f52c5c389dc402a60b7acee6716a7c0` |
| Fixture | `test/fixtures/images/uvk5-2.01.32.bin` |

Confirmed by this session:

- 38400 baud, 8N1, no flow control, DTR and RTS deasserted before the first
  command.
- Hello (`14 05 04 00 6A 39 57 64`) answers on the first attempt with a `15 05`
  reply carrying the firmware string from offset 4.
- `1B 05 08 00 <off:u16le> <len:u8> 00 <magic>` reads 128 bytes per call; the
  whole `0x2000` takes 64 calls.
- No echo of transmitted frames on a working adapter.
- **The radio does not checksum its replies.** Every reply carries `0xFFFF`
  where a checksum over the payload would go — the hello reply carried `0xFFFF`
  while its payload actually checksums to `0x5608`. This is why CHIRP never
  verifies reply checksums. boofwang briefly did, described in a comment as an
  improvement, which rejected every genuine reply while passing every synthetic
  test, because the fakes computed a checksum the radio does not. It now accepts
  `0xFFFF` as "none supplied" and verifies only a real value.
- **The radio has no skip flag.** CHIRP declares `rf.valid_skips = []`; scan
  behaviour is scanlist membership alone. Deriving a skip from "in neither
  scanlist" put `S` on all 31 rows of an exported CSV, which would mark every
  channel scan-skipped on whatever radio imported it.

Decode was cross-checked by parsing the same image with CHIRP's own `bitwise`
engine and the `MEM_FORMAT` string from `uvk5.py`, then comparing field by
field. Frequency, offset, shift, AM flag, bandwidth, power, tuning step and both
tone codes agree on all 31 populated slots.

One result is worth recording because it looks like a bug and is not: the VFO
presets for 108–136 MHz **and** 136–174 MHz (slots 203–206) both have
`enable_am` set. CHIRP's parse of the same bytes agrees. A decoder that
"corrected" the 2 m preset to FM would be misreporting the radio.

### 2026-08-19 — write, same radio and firmware

The first write to a real radio, done through the app's own UI over the
development serial bridge.

| Step | Result |
|---|---|
| Read, backup saved automatically | 8 KB, sha256 `a0dfe2ab…6716a7c0` |
| Rename channel 1 `CH001` → `BOOFWANG`, write | Dialog predicted **1 block, 8 bytes**; the radio received exactly that |
| Independent read over raw serial | `0x0f50` = `42 4f 4f 46 57 41 4e 47` — NUL-padded, as the radio itself writes names |
| Diff against the pre-write image | **Exactly 8 bytes changed**, all inside the channel-1 name record. Calibration, every channel record, settings, DTMF and the boot logo untouched |
| Restore from backup | Radio returned to sha256 `a0dfe2ab…6716a7c0`, **zero bytes differing** |

Traffic for the write, from the bridge: 1612 bytes out, 10348 in — two
handshakes (one to connect, one inside `writeImage`), the 58-block pre-write
read, one 128-byte write, one verify read, and the reset.

Confirmed by this session:

- Writing only the differing blocks works: a one-character name change moves one
  block, not the whole radio.
- Per-block read-back verification passes on real hardware.
- The pre-write read is what makes restore possible at all — see below.
- The reset leaves the radio out of programming mode; it operated normally
  afterwards.

**Restoring needs its own path.** `writeImage` normally refuses when the radio
disagrees with the image an edit was based on, because that divergence is
unintended. A restore is the opposite: the radio is *expected* to differ, and
making it match again is the whole request. So the restore flow passes no base
image, and the driver writes whichever blocks differ from what it reads off the
radio. Without that, the safety check would have made recovery impossible — the
one operation that has to work when everything else has gone wrong.

## The egzumer custom firmware

Detected by the `EGZUMER ` prefix on the hello reply, and decoded as a layout of
its own. **No radio running this firmware has ever been connected to boofwang.**
Everything below was checked against CHIRP's `chirp/drivers/uvk5_egzumer.py` and
nothing below was checked against hardware.

### Verified against CHIRP, not against a radio

The check is stronger than reading the format string twice, and weaker than a
capture. `scripts/gen-egzumer-fixture.py` drives CHIRP's own egzumer driver to
write an 8 KB image and then to read it back;
`test/fixtures/images/uvk5-egzumer-synthetic.bin` is those bytes and
`test/fixtures/uvk5-egzumer-chirp-decode.json` is that reading. Neither side of
the comparison in `test/lib/radios/uvk5/egzumer.spec.ts` was written by
boofwang, so a transposed nibble or an off-by-one offset fails it.

Before any of that, every field offset was located mechanically: each one was
set through CHIRP's `bitwise` parser on an otherwise zeroed image and the byte
that moved recorded. The results are the offsets in
`lib/radios/uvk5/egzumer-layout.ts`.

What that establishes, field by field:

| | |
|---|---|
| Calibration starts at | `0x1E00`, not stock's `0x1D00` — 256 more programmable bytes |
| Channel table | `channel[214]` at 0, same shape and same address as stock |
| Byte `0x0B` of a record | `modulation:4, shift:4`, where stock has `enable_am` at bit 4 and a two-bit shift. Modulation 0/1/2 is FM/AM/USB, narrowed by the bandwidth bit |
| Byte `0x0D` of a record | PTT-ID is **three** bits, not two: egzumer adds Apollo Quindar as a fifth value |
| Tuning steps | 24 entries, not 6, and not in ascending order — index 6 is 8.33 kHz |
| Attribute table | 207 entries at `0x0D60`, not 200. The seven above memory 200 are not decoded; CHIRP never reads them either |
| Band nibble | Written from `BANDS_NOLIMITS`, with CHIRP's "band 1 below 50 MHz" rule. Not the band plan the radio displays — see the note in the layout |
| Band plan and VFO names | `BANDS_WIDE` (18 MHz–1.3 GHz) or `BANDS_STANDARD`, chosen by `BUILD_OPTIONS.ENABLE_WIDE_RX` at `0x1FF1`, which is inside the calibration region and therefore read but never written |
| Settings | `0x0E70`–`0x0F48`, plus twenty FM presets at `0x0E40`. Decoded and offered as controls |

### Deliberately left undecoded

- **The eight VFO channel pointers at `0x0E80`.** They decode into the codeplug,
  but no control is offered. CHIRP keeps `MrChannel`, `FreqChannel` and
  `NoaaChannel` consistent with `ScreenChannel` whenever one changes, and a
  control editing one in isolation would leave the radio pointing two ways.
- **The power-on password at `0x0E98`.** Decoded as a 32-bit number, not
  offered: a raw integer field is the wrong way to ask for a six-digit code.
- **The seven attribute entries above memory 200**, at `0x0E28`–`0x0E2E`.
- **The DTMF contact list at `0x1C00`.** Byte-identical to stock's, which is
  also undecoded. Sixteen names and numbers, preserved verbatim.
- **The calibration region itself**, `0x1E00` up. Read for a backup, hashed for
  the unit fingerprint, never written. CHIRP offers to upload it behind a
  warning; boofwang does not offer it at all.
- **The eighteen extra tuning steps in the channel editor.** A channel found on
  one keeps it — the step index round-trips — but the editor's list is stock's
  six, because a stock radio offered "8.33 kHz" would silently store 6.25.
- **Apollo Quindar in the PTT-ID control.** Decodes and round-trips; the editor
  offers stock's four values, because the fifth does not fit in stock's field.

### Not verified, and what would settle it

- **Writing.** `canWrite` is `false` for this firmware. `writeImage` refuses on
  the variant even with the driver's write gate open and a matching backup, and
  `test/lib/radios/uvk5/egzumer.spec.ts` asserts that against a fake radio that
  throws if it is ever sent a write command. Turning it on needs the same
  evidence stock needed: a hardware capture in `test/fixtures/images/`, a
  round-trip over those real bytes, and a write/verify/restore recorded here.
- **Whether CHIRP's format string is right about the radio.** Nothing short of a
  radio can establish that, and everything above inherits the assumption.
- **Any of it on a build with `ENABLE_WIDE_RX` off.** The synthetic image has it
  on, so the standard band plan is transcribed but never exercised.

A read of a real egzumer radio, attached to
[issue #3](https://github.com/thebentern/boofwang/issues/3), would settle most
of this.

## Adapters

The USB-serial chip matters more than anything else in the chain.

| Adapter | Result |
|---|---|
| FTDI FT232R `0403:6001` | **Works.** Configures at 38400 and talks to the radio first time. |
| Prolific PL2303 `067b:2303`, bcdDevice `0x0300` | **Does not work.** macOS binds `AppleUSBPLCOM` and creates the device node, but `tcsetattr` fails with `EINVAL` for even a no-op change, so no application can set the baud rate. Under Web Serial it returned every transmitted frame back verbatim. Wire-level testing showed no short between transmit and receive, so the loopback originated in the adapter rather than the cabling. Counterfeit PL2303 chips are common; a CH340 or FTDI cable is the remedy. |

`LoopbackDetectedError` exists because of the second row: an echoed command is a
structurally perfect frame — right header, right footer, valid CRC — so it has
to be caught by comparing the reply against what was just sent.

## Not yet verified on hardware

- **Writing anything.** `writeImage` and `encode` deliberately throw. Nothing
  has been sent to a radio beyond hello and read commands.
- DTCS tones, cross tone modes, split duplex, and the transmit-inhibit encoding
  (minus shift with the offset equal to the receive frequency). The test radio
  had none of these programmed, so they rest on synthetic fixtures and on
  CHIRP's source.
- Any firmware other than `2.01.32`. The egzumer layout now decodes, but only
  against CHIRP — see the section above.
- **Which layout a bare `.bin` is in.** Stock and egzumer images are both 8,192
  bytes and a raw dump carries no identity, so one opens as stock. A `.bwp`
  records the layout, and a CHIRP `.img` carries the hello string in its
  metadata, so both open correctly.
