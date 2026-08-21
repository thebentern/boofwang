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

## Adding and removing channels — verified session, 2026-08-20

The encode loop was bounded by the stored channel count and the count itself was
not writable, so a channel created past the end was silently dropped and a
deleted one silently stayed. The UI offered both actions on this radio and
neither did anything.

The count is a uint16 LE at `0x000`-`0x001` of block `0x12` (reference `:37`,
attested both ways: the read capture's `19 00` = 25 and the OEM CPS write
capture's `80 00` = 128 against exactly 128 records written). Bytes `0x002`-`0x00F`
are fill — `0x00` in the read capture, `0xFF` in the CPS write capture — so
`ownedRanges()` claims `[0, 2)` and `[0x10, 0xFFF)` and deliberately leaves the
fourteen bytes between them alone.

Slots are positional: an empty one still consumes a channel number. So a
deletion erases the record to `0xFF` and leaves the count where it was, rather
than re-packing. The reference implementation does re-pack, which renumbers every
later channel while zone and scan-list entries go on pointing at absolute
channel numbers — that is a codeplug corruption, not a tidy-up. Adding a channel
past the end fills the intervening slots with `0xFF` so the radio reads them as
empty rather than as whatever the flash happened to hold.

Verified on the radio: channel 46 added on a 45-channel codeplug, one channel in
the middle deleted, in the same write. The count word reached the radio, the
header fill either side of it was untouched, the added channel read back, the
deleted one did not, and the channel after the deletion kept its name — no
renumbering. Restored to `224771c0…` afterwards.

### Channel numbering is absolute

Both the decoder and the encoder walked the channel-bank blocks the radio
happened to have, skipping the absent ones without advancing the channel number.
The reference's entry-offset formula (`05-DATA-STRUCTURES.md:53-58`) is absolute:

```
if N <= 84:   block = 0x12                              offset = 0x010 + (N - 1) * 48
else:         block = 0x12 + 1 + floor((N - 85) / 85)   offset = ((N - 85) mod 85) * 48
```

This radio has channel-bank blocks `0x12`, `0x13`, `0x14`, then `0x18` — `0x15`
through `0x17` are not allocated. Walking what exists put channel 255 in `0x18`,
which the radio reads as channel 510. Nothing surfaced it because the encode
loop stopped at the stored count of 45, all inside `0x12`; adding channels made
it reachable.

A gap in the bank means those channel numbers are unusable on that radio, not
that the later ones shuffle down. Writing a channel into a block the radio has
not allocated is refused by name, because a silently misplaced channel takes
every zone and scan-list entry pointing at either number with it.

## The structures that were never read — 2026-08-20

Five more decoded, mapped from the reference and then falsified against this
radio's own 241,664 bytes. Three would have been decoded wrongly by following
the spec alone.

| Structure | Block | Shape | The trap |
|---|---|---|---|
| Scan lists | `0x11` | 1-byte count, 57-byte records | the count is **one** byte; `0x001` is already the `S` of "Scan List 1", so a 16-bit read reports 21,250 lists |
| RX groups | `0x0F` | 17-byte header, 109-byte records | the first four bytes are an **occupancy bitmask**, not a count — read as an integer this radio claims 31 groups and has 5 |
| Radio IDs | `0x67` | 16-byte header, 16-byte records | the DMR ID is **u24le at the top of the record**, not after the name |
| Settings | `0x04` | one sparse struct in a 4 KiB page | perhaps a tenth of the page is named with confidence; `ownedRanges` is computed from the struct and comes to under 200 bytes |
| Talk group index | `0x0B` | counts, bitmask, two sorted tables | called a "Quick Access Contact List" and is not an address book — decoded, never written |

### Writing the address book — verified session, 2026-08-20

The reason it stayed read-only was never the decode: it was recovery. Contacts
were not in `writeTargets`, so a restore could not put them back, and writing
4 MB of somebody's contacts with no way back is not a trade worth making. Both
halves are now done.

The region is raw — real physical addresses, no logical id, no translation
layer — so it needed a write path of its own: no page-map lookup, no tail-byte
check, and no rescan after writing, because nothing can relocate it. A rescan is
200 one-byte probes, and on a radio with 50,000 contacts that would be one per
page.

Preserved because nobody has explained them: the twelve bytes between the count
and entry 0, byte `0x13` of every record, the tail of each page past the last
entry, and byte `0xFFF`, which here is data rather than a block id. `0x13` reads
`0xF0` on all 147 entries of this radio and in the reference's own sample — 148
for 148 — so a record that was erased gets that rather than the `0xFF` an erased
region is filled with, which would otherwise make it the only record on the
radio that differs.

One page more than the contacts fill is read, always at least one. The encoder
can only write pages the reader brought back, so without the spare there is
nowhere to put a contact the user adds — and a radio with an empty address book
had no page at all, which silently dropped every one.

Verified on the radio: contact 147 renamed and given a callsign, written,
independently read back, then restored. Both hashes came back exactly —
`1b47540a…` for the 59 config pages and `0937de53…` for the four contact pages.
Editing the *last* contact is deliberate: it sits on the final page, so a walk
that straddled the 4 KiB boundary would put it somewhere else entirely.

### The address book, on this radio

Verified against real data, which is the part a fixture cannot give: this radio
holds **147 contacts**, and the region it reports is `0x278000`–`0x634FFF` with a
cap of 50,000 — not the `0x6DBFFF` the reference captured, which is why the
extent is queried per session rather than assumed.

All 147 decode with printable names, callsigns, cities and 24-bit IDs, and none
implausible. The page walk is exercised for real at every boundary: entry 43 is
the last on page 0 and entry 44 the first on page 1, and this radio's
`KE5JGW / 3105231`, `KF5CGR / 3105247`, `KF5CGR / 3105248` run straight across
it. The flat `index * 92` formula in circulation reads garbage from entry 44
onward, so that continuity is the check that matters.

The 16-byte city field truncates on the radio's own terms — "North Little Rock"
is stored as "North Little Roc" — and is carried through as found rather than
tidied.

The **DMR address book** is not a block at all. It lives in a raw region found
per session by V-frame `0x0F` (`0x278000`–`0x6DBFFF`, ~4.4 MiB here), with no
logical id at `0xFFF` and no translation layer — real physical addresses that
stay put. It is read count-first, so a radio with no contacts costs one
four-byte read rather than seven minutes. Entries are 92 bytes and **do not
straddle a page**: 44 per page, 44 × 92 = 4048, and the flat `index * 92`
formula in circulation is wrong twice over. Read only, and it is dropped from a
raw `.bin` export because a flat file has nowhere to record where it came from.

### Zone membership is writable; scan list membership is not

Zone membership was settled by this radio, as recorded above. Scan list
membership was not, and the disagreement is worth writing down because both
sides have direct evidence.

| Reading | Members at | Slots | Evidence |
|---|---|---|---|
| A | `+0x18` | 16 | this radio: `0x0B` = 16 and 9, and the non-zero words from `+0x18` are 16 and 9 |
| B | `+0x1A` | 15 | the reference's OEM CPS write capture: all nine lists store `0x0000` at `+0x18` |

Every populated record on this radio matches A on the count and misses B by
exactly one. Under B, record 1's count of 16 exceeds the 15 slots B allows at
all. Under A, the vendor's own software wrote "channel 0" as the first member of
every list it ever saved.

Writing the wrong one shifts every channel in the list, so neither is written.
The name is unambiguous and is. Settling it needs one deliberate edit **on the
radio's own keypad** — change a scan list's membership to something
non-sequential, read the block back, and see which offset moved.

### Channel keys

`DM32_KEY_FUNCTIONS` is transcribed from `05-DATA-STRUCTURES.md:2253-2271`. An
earlier version claimed the same provenance without it: it agreed for the first
fourteen values and invented every one after. Because the settings schema builds
its dropdown as `map((label, value) => …)`, the index *is* the byte written, so
a wrong label was a wrong byte. This radio's `0x088`/`0x089`/`0x08D`/`0x08F` =
`0x1c`/`0x19`/`0x11`/`0x10` read as Keypad Lock, Monitor, Zone Down, Zone Up —
the Zone Down/Zone Up pair on the two programmable keys is the tell.

### Radio IDs are addressed by slot

A radio ID's index *is* its physical slot, and channel byte `0x2B` points at it.
The bank is written back slot by slot, never repacked: packing it densely would
silently repoint every channel after a gap, and an entry the count did not reach
got copied down and left in place, so the bank held the same ID twice. The count
covers the highest occupied slot rather than how many entries there are.

## Not verified
- **Zone membership.** `encodeZones` writes the name only. A zone's channel list
  is a set of indices, and what the radio does with one pointing at an emptied
  slot has not been established.
- **Scan list membership.** See the two readings above; the name is written and
  the membership is not.
- **Growing the address book past the pages that were read.** One spare page is
  brought back, so up to 44 contacts can be added; beyond that the write is
  refused by name rather than truncating. Reading the whole 4.4 MiB region to
  avoid that would cost about seven minutes on every read.
- **Block `0x0B`**, the radio's own talk-group index. Decoded, never written:
  regenerating it means keeping two counts, a bitmask and two sorted tables in
  step, and no observed radio has ever had them out of step. Renaming a talk
  group therefore leaves the radio's own name-ordering stale until it rebuilds
  it — cosmetic, and disclosed rather than fixed.
- Contacts beyond the address book, roaming zones and roaming channels.
- The meaning of 22 allocated blocks.
- Whether the alignment of a *short* key differs from a full one. Only AES-256,
  which fills the whole 32-byte field, has been written.
- The bandwidth polarity at `0x19` bit 7 is still `DERIVED` in the reference.
  Every channel on this radio holds `0x19 = 0x00`, so it cannot settle it.
