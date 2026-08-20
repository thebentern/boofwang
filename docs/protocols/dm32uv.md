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
- 45 channels, 4 zones, 6 talk groups and 22 encryption key slots decode
  correctly.
- **22 of the 59 allocated blocks have no documented meaning.** They are read
  and preserved byte for byte regardless.

## Corrections to the specification

The specification marks much of its record layout `DERIVED` from two captures of
a single unit. Three claims did not survive contact with a second radio.

**The zone count is one byte, not two.** Reading a 16-bit word at the zone
block's `+0x000` gives 1796 on a radio with four zones; the neighbouring byte is
something else.

**There are 22 key slots, not eight.** Block `0x10` holds 22 consecutive `0x2C`
records at `+0x300`, ids 1–22, every one type `0x04` (AES-256) and named
`Encrypt 1` … `Encrypt 22`, followed by zeroed records. The table occupies 968
bytes, not 352.

This one was expensive. `KEY_SLOTS = 8` was taken from the specification and
never checked, and because both the fixture's redaction pass and the test that
guards against checked-in key material derived their bounds from it, **fourteen
real AES-256 keys were committed to this repository while a green test asserted
that none were**. The guard is now written against the raw bytes of block `0x10`
and knows nothing about the layout constants; a second check looks for any
32-byte run of near-distinct bytes anywhere in the block. Nothing that reads key
slots should assume a constant is right when hardware can be asked.

**A full AES-256 key is not "right-aligned at +0x24".** The spec's sample shows
eight key bytes at `+0x24`–`+0x2B`, which is where the vendor software puts a
*short* key. On this radio every slot holds an AES-256 key occupying the whole
32-byte field from `+0x0C`. A decoder reading only the last eight bytes would
silently truncate a real key, so the field is carried verbatim.

**An unused slot is 44 zero bytes**, not the `0x00`-then-`0xFF` filler the
erase pattern suggests. Records 23 onward in the key table are entirely zero.
The encoder now leaves an already-empty slot untouched rather than writing any
erase pattern over it, because fabricating those bytes would break
`encode(decode(image)) === image` for every radio with a partly-used key table.

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

### Why this failed only in the browser

The 10 ms programming-mode window is shorter than a browser timer. A background
or hidden tab clamps `setTimeout` to roughly **1 Hz**, so a `setTimeout(10)`
measured **999 ms** — long enough for the radio to leave the window and for the
next heartbeat to arrive, producing `PASSSTA failed: 90 fe 98` on a sequence
that was correct. The same code over a direct connection from Node was fine,
which is exactly what made it look like a hardware or timing fault in the radio.

The fix is `app/plugins/unthrottled-timers.client.ts`: sleeps are serviced by a
dedicated Worker, whose timers are not clamped. The same `setTimeout(10)` then
measures **12 ms**, and full 236 KiB reads through the browser are reliable.

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

## Writing key slots — verified session, 2026-08-20

The first bytes ever written to this radio by boofwang, and the restore that
put them back. Both went through the browser and the development bridge, using
the same `writeImage` a user gets.

The change was deliberately the smallest one that still exercises the whole
path: the **name** of AES key slot 8, `Encrypt 8` → `BOOFWANG` → `Encrypt 8`.
Only the key area is writable today, and a name is the one field in it that can
be checked byte for byte without handling key material.

| step | result |
|---|---|
| pending diff, computed before sending | **9 bytes**, logical block `0x10` only, **0 unowned** |
| sent | one 4 KiB page (`57` + 3-byte LE address + `00 10` + 4096 bytes) |
| driver verdict | `1 block, 4096 bytes. Every block was read back and matched.` |
| bridge traffic | 6570 bytes out, 15170 bytes in |
| restore traffic | 6570 bytes out, 15170 bytes in — identical |

Verified **outside the app**, with a raw Python serial read of all 59 blocks,
against the pre-write capture:

| | sha256 of the 59 concatenated blocks |
|---|---|
| before | `224771c0a05098907be1dcf6418c90b24d61205a738840a6a91233442adc8bc4` |
| after the write | `dd22d3669314c77ed0006e5d41048f656a6cd56d63d0a684b14fae70ed2a5bf8` |
| after the restore | `224771c0a05098907be1dcf6418c90b24d61205a738840a6a91233442adc8bc4` |

Byte-level diff of the write: **exactly 9 bytes changed**, all of them at block
`0x10` offsets `0x435–0x43D` — slot 8's name field, `Encrypt 8` → `BOOFWANG\x00`.
All 58 other blocks were byte-identical, and every slot's key material was
untouched. The restore returned all 59 blocks to their original bytes with
**zero** differences.

The whole cycle was run again after an adversarial review changed the write
path substantially — the key table grew from 8 slots to 22, the backup became
bound to the physical unit, and the handshake stopped waiting for eight bytes
before checking for an echoing cable. Same result: 9 bytes, one block, and the
radio back to `224771c0…` afterwards.

Two things this establishes beyond "the write worked":

- **The read-modify-write merge does what it claims.** A 9-byte edit inside a
  4 KiB page left the other 4087 bytes alone, including bytes in blocks whose
  meaning is still unknown.
- **Recovery works.** The radio can be put back, which is the property that
  makes the rest of it safe to use.

Still true of every write: the page is re-read live, its tail id is re-checked,
only `ownedRanges()` is merged onto it, and the page is read back and compared
after sending. A relocation between the diff and the write is followed rather
than assumed away.

## Channels, zones and talk groups — verified session, 2026-08-20

Baseline `224771c0a05098907be1dcf6418c90b24d61205a738840a6a91233442adc8bc4`
(59 blocks, 241,664 bytes), taken and re-taken with a raw Python reader that
shares no code with boofwang.

`writeImage` resolved a single region — block `0x10` — while `encode()` had been
widened to patch channel, zone and talk group records. Those bytes were produced
and dropped, and the report still said "verified". It now walks every block the
driver claims, least dangerous first: talk groups, zone names, channels, then
key slots.

Three of the channel bit maps were wrong, and the round-trip invariant could not
see any of them because the decoder and the encoder shared the same wrong bits.

| Byte | Was | Is | Attested by |
|---|---|---|---|
| `0x18` | forbid-TX bit 1, power bit 0 | forbid-TX bit 3, power bits 2-1, lone worker bit 0 | reference `:300-308`; this radio's `LR DMR` = `0x1c` |
| `0x19` | whole byte, bandwidth bit 0 | bandwidth bit 7, scan add bit 6, scan list bits 5-2, bits 1-0 preserved | reference `:309-317` |
| `0x1D` | timeslot bit 3, colour code 3 bits | timeslot bit 4, colour code low nibble | reference `:392-406`, OEM CPS `TS1`=`0x01` / `TS2`=`0x11` |

The `0x18` fault was not cosmetic. This radio's `LR DMR`, `AR DMR`, `USA DMR` and
`Test DMR` all hold `0x18 = 0x1c` — bit 3 set, transmit forbidden — and boofwang
displayed all four as transmit-enabled. Marking a channel receive-only set bit 1,
which the radio ignores, and moved the power level to an undefined value.

Two write passes, each read back with the Python reader and diffed byte by byte:

**Pass 1** — 3 blocks, 12,288 bytes sent, 40 bytes actually different:

| Block | Bytes | Change |
|---|---|---|
| `0x12` | 15 | `MURS-1` → `HWTEST MURS`; `0x18` `0x04`→`0x02` (power High→Medium, forbid-TX untouched); `TAC 1` `0x1D` `0x00`→`0x1d` (colour code 13, timeslot 2) |
| `0x5c` | 10 | zone 1 `Tactical` → `HWZONE`, channel list untouched |
| `0x44` | 15 | talk group 1 renamed, its number and call type bytes preserved |

**Pass 2** — the remaining writable fields:

| Channel | Change | Bytes |
|---|---|---|
| `GMRS 1` | receive-only | `0x18` `0x00`→`0x08` — bit 3, power untouched |
| `LR DMR` | transmit re-enabled | `0x18` `0x1c`→`0x14` — bit 3 cleared, power still 2 |
| `GMRS 2` | 462.60000 MHz, 25 kHz | RX and TX BCD both moved; `0x19` `0x00`→`0x80`, scan bits still 0 |
| `MURS-1` | CTCSS 127.3 both ways | `0x21-0x24` `ff ff ff ff` → `73 12 73 12` |
| `Blue Dot` | DCS 754 inverted / 023 normal | `54 c7 23 80` — polarity in the high byte |
| key slot 1 | AES-256 replaced | `0x30c-0x32b`, 32 bytes, nothing else in the page |

No page relocated in either pass. No byte outside `ownedRanges()` moved. A
receive-only channel kept the transmit pair the radio had stored — `txFrequency()`
returns null for a receive-only channel, and the old `?? rxFreq` fallback had been
overwriting the stored pair with the receive frequency.

Restored from the baseline after each pass; an independent read returned
`224771c0…` byte for byte both times, including the real AES-256 key.

`test/hardware/dm32uv.spec.ts` runs this cycle self-restoring:

```
pnpm bridge
BOOFWANG_HW=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX pnpm vitest run --project hardware
```

Each operation is its own connection. There is no command to leave programming
mode: the radio resets when the port closes and needs `REOPEN_SETTLE_MS` before
it will answer a handshake, so a read and a write in one session fails at the
second `PROGRAM` with `0x90`.

## Not verified

- **Adding or removing channels.** The channel-count header at the start of block
  `0x12` is outside `ownedRanges()`, so existing records can be edited but the
  count cannot change.
- **Zone membership.** `encodeZones` writes the name only. A zone's channel list
  is a set of indices, and what the radio does with one pointing at an emptied
  slot has not been established.
- Settings, contacts, RX groups, scan lists and radio IDs — never decoded.
- The meaning of 22 allocated blocks.
- Whether the alignment of a *short* key differs from a full one. Only AES-256,
  which fills the whole 32-byte field, has been written.
- The bandwidth polarity at `0x19` bit 7 is still `DERIVED` in the reference.
  Every channel on this radio holds `0x19 = 0x00`, so it cannot settle it.
