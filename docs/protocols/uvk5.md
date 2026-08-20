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
- Any firmware other than `2.01.32`, including the egzumer layout.
