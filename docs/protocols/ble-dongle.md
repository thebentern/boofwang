<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# BLE-to-UART dongles (TIDRADIO BL-1 family) - notes

Not a radio: a Bluetooth peripheral that clips onto a radio's two-pin Kenwood
programming port and bridges GATT to the radio's own wired UART. The BL-1,
TDBL-1 and BL-2, and the TD-PTT fob with its Kenwood cable attached, are the
units this covers. The radio behind one is an ordinary cabled radio and does
not know anything changed - which is the one fact everything in this file
hangs off, and the reason `Transport` now answers two questions instead of
one: `kind` is the carrier the host is on, `radioLink` is what the radio
believes. A dongle is `kind: 'bluetooth', radioLink: 'serial'`.

## Verified read, 2026-09-01

A **Baofeng BT-A1D**, advertising as `BF_Writer_CD4`, carried a whole UV-5R
Mini codeplug into the browser. This is the first time a dongle has relayed a
radio's words here, and it is what `TIDRADIO_BL1_FF00.verified` now rests on.

| | |
|---|---|
| Dongle | Baofeng BT-A1D, advertised `BF_Writer_CD4`, service `BF98` |
| Radio | Baofeng UV-5R Mini, identified `5RMINI +L00000` |
| GATT used | service `FF00`, write `FF02`, notify `FF01` |
| `AE10` | left at its factory `5` - nothing was written to configure the dongle |
| Result | 1,000 slots, 21 programmed channels, backup taken, checks clear |

Three things this settles that guesswork could not:

- **FF02/FF01 is a transparent serial pipe.** The profile aimed there on the
  strength of two devices sharing the shape, and it was right.
- **The dongle needs no configuration.** No mode command, no rate command,
  `AE10` untouched at 5 - and the Mini clones at 115,200, so whatever 5
  selects is compatible with that or the dongle autobauds. The baud question
  that hung over this file for two days was a red herring.
- **The radio never knew.** It ran its ordinary wired protocol throughout,
  which is what `radioLink: 'serial'` exists to record.

### What it does not settle: the UV-82 stayed silent

The same dongle drew nothing at all from a UV-82 on the same day. So the
route is proven for one radio, not for the port shape, and the schema keeps
those apart: `dongle` says the jack fits, `dongleProven` says a codeplug has
actually come off that radio through one.

The difference between the two looks like **frame shape rather than baud**.
The UV-5R Mini's driver sends its identify magic as a single 16-byte write.
The classic UV-5R family - UV-82, UV-5G - dribbles seven bytes 10 ms apart,
because CHIRP found that radios miss a fast burst on their own UART. Against
this dongle that pacing draws nothing whatever, while single writes draw
replies; a bench probe saw the same split before boofwang did:

| Written to FF02 | Came back |
|---|---|
| 7 bytes, one at a time | nothing, ever |
| 7 bytes, one write | one byte |
| 16 bytes, one write | six bytes |

A GATT write is a message, not a stream, and a dongle forwarding whole
writes has no reason to reassemble seven of them. So `sendMagic` was changed
to send the magic in one write when the carrier is Bluetooth, keeping the
10 ms pacing on a cable.

**It did not work, and this is the paragraph that said to come back and say
so.** A UV-82 behind a BT-A1D was tried again with the magic going out as a
single seven-byte write - confirmed on the wire by a session trace, three
attempts at `50bbff20130105` - and the radio stayed as silent as it had been
with the bytes dribbled. Frame shape is not what stops it.

The change is kept, but on a narrower argument than the one that motivated
it: seven single-byte GATT writes are seven round trips down the slowest
link in the system to deliver seven bytes, and the Mini's driver has always
sent its magic whole. It is not a fix for anything, and nothing here should
be read as saying the classic family works through a dongle.

What is left standing is the plainest explanation, which was on the vendor's
own page the whole time: **the BT-A1D does not claim the UV-82.** Its
supported list is UV-5RM, UV-5RM Plus, UV-5RM Pro, UV-5RH, UV-5R, UV-5RX,
K5 Plus, V1D and BF-888S. The one radio it carried here is on that list; the
two it never carried - a UV-82 and a Quansheng UV-K5 - are not.

With the radio-off control in hand, the rate is no longer even a candidate:
nothing was ever coming back from the radio to be sampled at the wrong
speed. Whether the cable does not wire the UV-82's pins, or the dongle never
drives them, is not something this bench can distinguish and no longer
matters much - either way this adapter does not reach this radio.

Three hypotheses died here in three days: frame shape, then rate, then the
control that showed there was nothing to explain. The pattern in all three
is the same - a suggestive reading taken as evidence before the cheap
disconfirming test was run. The HCI capture remains the only route that
reads an answer off the vendor's own software rather than inferring one.

## The first device: `TIDRADIO PTTf816cb-A`, 2026-08-31

### The GATT, as read off the fob

| | |
|---|---|
| Device name | `TIDRADIO PTTf816cb-A` |
| Advertised service | `FF00` (so a service-filtered chooser CAN match it) |
| RSSI on the bench | -53 |

```
service ff00 (vendor)
  char ff01  [notify]
  char ff02  [write-without-response, write, read]
  char ff21  [notify]
  char ff22  [write-without-response, write]
service ae00 (vendor)
  char ae01  [write-without-response]
  char ae02  [notify]
```

So the family is **neither Nordic UART nor plain FFE0** - the two shapes this
file first guessed. It is an FF00 vendor service with two write/notify pairs,
plus an AE00 service echoing the UV-5R Mini's AE-family layout. The candidate
profiles now lead with the FF00 shape; the HM-10 FFE0 shape is kept behind it
because cheap dongles in this family vary and another unit may carry it.

### FF22 answers one byte per byte, which settles what it is

Two radios were held behind the dongle and sent their own identify magic
through it: a UV-K5 (38,400 baud) and then a UV-82 (9,600 - the family these
dongles are sold for). Neither answered. What FF22 does instead is the
finding, and it is unambiguous:

| Written to FF22 | Returned on FF21 |
|---|---|
| 4 bytes of junk `aa 55 a5 5a` | 4 bytes, `00 00 00 00` |
| UV-K5 hello, 16 bytes | 16 bytes, `9e 1c b2 ae db 20 4f c6 39 b2 1f 3b db c5 12 5d` |
| UV-82 magic, 1 byte at a time | 1 byte each time, `00` |
| UV-82 magic, 7 bytes at once | 7 bytes, `00 00 00 00 00 00 00` |

**Exactly one byte out per byte in, every time.** No radio protocol here does
that. A UV-82 answers a seven-byte magic with a single `06`; a UV-K5 answers
a sixteen-byte hello with a framed reply of about twenty-six starting `AB CD`.
A channel whose reply length always equals the request length is not carrying
a radio's words - it is a per-byte status channel.

That is the same class of trap as the UV-5R Mini's AE30/`ae01` loopback, and
it is recorded the same way: `TIDRADIO_FF22_PER_BYTE` in
`lib/transport/bluetooth-uuids.ts`, pointed at by nothing. A driver aimed at
FF22 would see a byte arrive for every byte it sent and report a protocol
error against bytes the radio never uttered - hours of misdiagnosis, exactly
as the AE30 note warns.

The returned bytes do vary with the radio attached (all `00` behind the
UV-82, varied but deterministic behind the UV-K5), so the dongle is sampling
something on its far side. It is simply not relaying a reply. The UV-K5's
16-byte blob was also tested for a fixed-key XOR - against an assumed `AB CD`
header and against an echo-XOR of the frame sent - with no repeating key at
period 1, 2, 4 or 8.

**FF02/FF01**, the pair actually shaped like a transparent serial link, stayed
silent to every one of those attempts, and FF02 reads back empty. **AE01**
was silent too. So the dongle profile aims at FF02/FF01: silence is the honest
failure mode, and a driver that times out saying the radio did not answer is
telling the truth, where one fed FF22's status bytes would not be.

### What this does not settle

The unit tested is a **TD-PTT fob** - a push-to-talk accessory that happens to
take the same Kenwood plug. Whether its cable even wires the programming pins
is unknown, and a PTT accessory has no reason to. So "this fob did not pass
serial" is not yet "BL-1 dongles do not pass serial".

## A second device: the Baofeng BT-A1D, 2026-08-31

Baofeng's own **BT-A1D Wireless Programming Adapter**, which advertises as
`BF_Writer_CD4` - note the trailing space in the advertised name, the kind of
detail a naive prefix filter breaks on - under vendor service **BF98**. It is
driven by Baofeng's **Ola Radio** app on Android and iOS.

**It was tested against a UV-82, which the vendor does not claim.** The
BT-A1D's published compatibility list is UV-5RM, UV-5RM Plus, UV-5RM Pro,
UV-5RH, UV-5R, UV-5RX, K5 Plus, V1D and BF-888S. No UV-82, and no Quansheng
UV-K5. So the silence recorded below is from a pairing the adapter was never
sold for, and is weak evidence about the adapter itself. The obvious retry is
a **UV-5R Mini**: it is on the list, and it is the radio whose driver here is
best verified.

That list also settles a question this file had open. The adapter spans the
UV-5R at 9,600 and the UV-5RM at 115,200, so it must select a rate per radio
rather than fixing one - which makes `AE10`, the four-byte register below, a
near-certain mode or rate selector that the Ola app writes before it talks.
Its factory 5 is simply what ships, not a rate that suits everything.

```
service ff00
  ae01 [write-without-response]      ae02 [notify]
  ff02 [write-without-response]      ff01 [indicate]
  ae04 [notify]                      ae10 [write, read]
service ae3a
  ae3b [write-without-response]      ae3c [notify]
```

Three things this device settled:

**AE01 -> AE02 is a literal echo.** Four junk bytes came back
`aa 55 a5 5a`; the seven-byte UV-82 magic came back `50 bb ff 20 13 01 05`.
That is the AE30/`ae01` loopback documented for the UV-5R Mini, on entirely
different hardware - the same vendor BLE stack, and the same trap. This is
the second device on which probing every writable characteristic for an echo
before trusting one has paid for itself.

**Both devices carry FF02 (write) and FF01 (notify/indicate) in an FF00
service.** That commonality is why the shipped profile aims there. On this
writer FF02 does draw a reply on FF01, unlike the fob.

**It advertises BF98, not FF00** - and that difference shipped as a bug. The
first release of the dongle profile filtered the chooser on FF00, which is
where the characteristics live but is only discoverable *after* connecting.
The writer broadcasts BF98 and the name `BF_Writer_CD4`, neither of which the
filter named, so the chooser opened empty with the dongle a foot away: the
exact failure the header of `bluetooth-uuids.ts` warns about, committed by
trusting a GATT enumeration as an advertisement. `BluetoothProfile` now
separates `service` (looked up after connecting) from `advertisedServices`
(what the chooser may filter on), and a test pins the two apart.

**What FF01 returns is not the radio, and that is now settled.** Writing to
FF02 produces a variable number of single-byte notifications - `f8`, `f0`,
`fc`, `e0`, `c0`, `ff` - which look exactly like a UART sampling a line at
the wrong rate. That reading is wrong, and it took three controls to prove
it:

| Control | Result |
|---|---|
| Radio attached and on, magic sent | bytes, 5 of 5 attempts |
| Radio **unplugged** from the dongle | **silence, 0 of 5** |
| Radio attached but **switched off**, magic sent | **bytes, 5 of 5** |

The middle row is what fooled us: the traffic depends on the radio being
plugged in, which reads like the radio answering. The last row settles it. A
radio that is switched off cannot answer a handshake, and it produced the
same `fc` / `f8` / `ff` family as a live one. So the bytes are the dongle's
UART sampling a line that the radio's *presence* biases - a pull-up and some
noise tripping a start bit - and not the radio's voice at any rate.

Everything built on those bytes fell with them. `AE10` was swept 1 to 12
against both pacings, 0 excluded, on the theory that the radio was answering
at the wrong speed; nothing ever returned `06`, and now it is clear nothing
could have. **The UV-82 has never answered through this dongle.**

The lesson is about the control rather than the dongle: "the output changes
when I unplug the radio" is not "the radio is transmitting". The cheap
distinguishing test - leave it plugged in and switch it off - should have
come first, and would have saved two sweeps and a driver change.

**AE10 is a four-byte register that reads back what is written, factory value
5** - and it is not to be swept blindly. Writing `0` to it took the dongle off
the air completely: no reconnect, no advertisement, until it was
power-cycled. Whatever it selects, `0` is not a rate. Do not walk this
register looking for a baud index; get the values from a capture instead.

### Where two devices leave it

Neither the PTT fob nor the writer has carried a radio's words, and blind
probing has now reached its end: it cost this dongle a power cycle and
produced a baud theory the byte counts did not actually support. An HCI snoop
of the vendor app doing one real read answers every remaining question at
once - which characteristic carries the payload, what is written to `AE10`
first, and what a reply looks like when it is the radio talking rather than a
line being sampled. That is step 4 below, and it is the only step left worth
spending time on.

## The baud question, still open and still not the whole story

A cable's rate is set host-side by `SerialOpenOptions.baudRate`. A dongle has
a real UART on its far side at some rate the dongle fixes, and there is no
way to ask for one over this API - `BluetoothPort.open()` ignores `baudRate`,
and whether these dongles autobaud, take a rate command, or are fixed is
unknown. The radios do not all clone at the same rate:

| Radio | Clone baud | Dongle route offered |
|---|---|---|
| Baofeng UV-82 | 9,600 | yes, untested |
| Radioddity UV-5G | 9,600 | yes, untested |
| Quansheng UV-K5 | 38,400 | yes, untested, doubtful |
| Baofeng UV-5R Mini | 115,200 | yes, untested, doubtful |
| Baofeng DM-32UV | 115,200 | no - see below |

These dongles are sold for the classic 9,600-baud Baofeng family, so the
UV-82 and UV-5G are the plausible wins. A rate mismatch produces silence or
garbage, which looks exactly like a radio that is switched off.

The rate was tested both ways on the PTT fob - a UV-K5 at 38,400 and a UV-82
at 9,600 - and FF02 was silent behind both. A mismatch cannot explain silence
at two different rates, so on that fob the rate is not what is stopping it:
either FF02 carries nothing until something uncaptured tells it to, or its
cable does not wire the programming pins in the first place. On the
`BF_Writer` the same question is still open, because what FF01 returns there
has not been shown to be the radio at all.

The DM-32UV shares the same two-pin jack - the plug is not the reason it is
excluded. Its protocol leaves programming mode on a port close (a DTR reset)
and recovery needs a real reopen after a settle; a dongle's far-side UART
never closes between app sessions and carries no DTR, so the one documented
way out of a wedged session cannot run. See its schema comment and
docs/protocols/dm32uv.md.

## The FFE0 ambiguity on the UV-5R Mini

An FFE0-variant BL-1 is service-identical to the UV-5R Mini's own BLE module
(`UV5RM_BLE`). UUIDs alone cannot tell "the radio's module" from "a dongle on
the radio's port", and the two need different upload block sizes - 0x80 for
the module, 0x40 through the dongle.

Today this is harmless by construction: the Mini's connect button uses only
its own verified profile, the dongle candidates are offered only for radios
without a module, reads are byte-identical on both axes, and every
Bluetooth-carrier write is refused. It becomes real the day dongle writes are
considered, and the answer will have to come from a capture - a
distinguishing name, a second service, anything the enumeration shows that
UUID FFE0 alone does not.

## Capture method, for whoever has the hardware

1. **Enumerate before trusting anything.** nRF Connect on a phone, or
   `chrome://bluetooth-internals`, with the dongle powered and clipped to a
   radio. Record the advertisement (name, service UUIDs) and the full GATT
   table. The advertised name decides whether the chooser filters can ever
   match; the service list decides which candidate profile is real.
2. **Probe for a loopback before recording any UUID.** Write a few bytes to
   each writable characteristic and watch for them coming back unchanged.
   The UV-5R Mini's AE30/`ae01` did exactly that and cost hours - a driver
   pointed at a loopback sees its own frames and reports the echoing-adapter
   fault. A dongle is at least as likely to expose one.
3. **Send a real radio its own identify magic through the dongle** on each
   surviving characteristic and watch for the acknowledgement - the method
   that settled the Mini's profile. A UV-82 or UV-5G behind the dongle
   answers `06` to its seven-byte magic if the pipe and the rate are right.
4. **Capture the vendor app doing real work - this is the step that is now
   blocking, and no public reverse engineering of these adapters exists to
   borrow from.** Bench probing got as far as it can: the devices answer, but
   with wrappers a single sample cannot decode. Turn on Android developer
   options and the Bluetooth HCI snoop log, drive the vendor app - **Ola
   Radio** for the Baofeng BT-A1D - through one read and one write of a radio
   on the adapter's own supported list, then `adb bugreport` and open
   `btsnoop_hci.log` in Wireshark. Line the app's writes up against its
   notifies with a known plaintext and the wrapper falls out: what it writes
   to `AE10` first, which characteristic carries the payload, and whether the
   framing is an XOR, a length/opcode header, or a mode command that precedes
   transparent traffic. Everything else in this file is waiting on that.
5. **Then, in one commit:** fill the real UUIDs and advertised name into the
   profiles, flip `verified`, and record here the byte counts of the read
   and the write that proved them. `?ble=uart:service,write,notify` exists
   so all of this can be tried against a production build before any code
   changes - the `uart:` prefix is what keeps the radio on its cable block
   size while chasing.

Writing through a dongle stays refused by the write gate for every radio
that has no BLE module of its own - the carrier is Bluetooth, their
`writeTransports` falls back to a `transports` of `['serial']`, and no radio
behind a dongle has taken a write. The enabling sequence is the UV-5R Mini's:
read first, prove the round trip, then let the radio's schema write over
Bluetooth, with the wire byte counts recorded. The Mini itself is through that
sequence and is no longer blocked; a dongle carrying it inherits that, because
the gate keys on the carrier and the schema, not on which wireless device is in
the middle.
