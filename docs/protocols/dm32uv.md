<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Baofeng DM-32UV — hardware notes

CHIRP has no driver for this radio. Everything boofwang knows comes from the
MIT-licensed [DM32-Protocol-Spec](https://github.com/infamy/DM32-Protocol-Spec)
plus what a real radio does. See [../provenance.md](../provenance.md).

## Verified session, 2026-08-19

| | |
|---|---|
| Reports itself as | `DP570UV` |
| Firmware | `DM32.01.01.040` (build 2022-06-27) |
| Adapter | FTDI FT232R, 115200 8N1 |
| Config region | `0x001000–0x0C8FFF`, 200 × 4 KiB pages |
| Allocated pages | **59** — 35 free (`0xFF`), 106 superseded (`0x00`) |
| Captured | 236 KiB, 32 s |

Confirmed by this session:

- The full handshake: `PSEARCH` → `06 DP570UV`, `PASSSTA` → `50 00 00`,
  `SYSINFO` → `06`, then the V-frame queries and the three-step PROGRAM entry.
- **The flash translation layer is real and unordered.** Logical block `0x07`
  sits at physical `0x001000` while `0x02` is at `0x0AA000`. Sorting blocks by
  id does not sort them by address. Nothing may be hardcoded.
- Every allocated logical id appears exactly once across the 200 pages.
- 45 channels, 4 zones, 6 talk groups and 8 encryption key slots decode
  correctly.
- **22 of the 59 allocated blocks have no documented meaning.** They are read
  and preserved byte for byte regardless.

## Corrections to the specification

The specification marks much of its record layout `DERIVED` from two captures of
a single unit. Two claims did not survive contact with a second radio.

**The zone count is one byte, not two.** Reading a 16-bit word at the zone
block's `+0x000` gives 1796 on a radio with four zones; the neighbouring byte is
something else.

**A full AES-256 key is not "right-aligned at +0x24".** The spec's sample shows
eight key bytes at `+0x24`–`+0x2B`, which is where the vendor software puts a
*short* key. On this radio all eight slots hold AES-256 keys occupying the whole
32-byte field from `+0x0C`. A decoder reading only the last eight bytes would
silently truncate a real key, so the field is carried verbatim.

The talk-group record formula in the spec is **correct** — 24 bytes each, the
first at offset 1 and the rest at `25 + (N-2)*24`. An earlier failure to decode
them was arithmetic on this side, not an error in the document.

## The idle heartbeat

Not in the specification, and it dominates the connection logic.

While out of programming mode the radio emits **`90 fe 98 fe` roughly every
three seconds**, unsolicited. It lands in whichever read happens to be waiting,
so the reported failure migrates from step to step as each one is fixed:
first `PSEARCH`, then `PASSSTA failed: received 90 fe 98`, then Mode 02 — each
message naming a step that was working perfectly.

Every handshake step therefore drains the line before it speaks. The
programming-mode sequence is the exception: its three steps are 10 ms apart by
design, and draining between them cost about two seconds, after which the radio
had left the window and answered nothing at all.

## Recovery between sessions

The radio has **no command to leave programming mode**; the specification's own
state machine exits on "close port (DTR reset)". Measured by opening a fresh
port at increasing gaps after a close:

| gap after close | result |
|---|---|
| 0.0 s, 0.5 s, 1.0 s, 2.0 s | no reply at all |
| 3.0 s | `06 44 50 35 37 30 55 56`, `PASSSTA 50 00 00` |

Retrying on the *same* open port never recovers, however long it waits — tried,
four attempts, identical failure. The close is the reset. A DTR pulse on open
was tested as an alternative explanation and ruled out: four sessions with and
without it all succeeded.

## Not verified

- **Writing anything.** `writeImage` and `encode` throw. Nothing has been sent
  to this radio beyond the handshake, V-frame queries and `0x52` reads.
- The meaning of 22 allocated blocks.
- Whether the alignment of a *short* key differs from a full one.
- End-to-end read through the browser: the handshake, V-frames and PROGRAM entry
  all succeed there, but the Mode 02 step still collides with the heartbeat
  because the development bridge adds about a second per round trip. Reading
  over a direct serial connection is reliable.
