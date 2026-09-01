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

## Two devices enumerated, neither verified

Two units have been put on a bench against real radios - a TIDRADIO TD-PTT
fob and a `BF_Writer` programming adapter - and between them they settled
some of the original guesses and broke others. Nothing is `verified: true`,
and the reason is now specific rather than "nobody has looked": **no radio
has answered a handshake through either one.** Every piece of interface copy
derives its caveat from the `verified: false` flag, so proving one right will
remove the caveats by itself.

What the two devices agree on is the shape the shipped profile aims at: an
FF00 vendor service carrying FF02 to write and FF01 to listen. What neither
has done is carry a radio's words.

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

**What FF01 returns is not yet a radio.** Writing to FF02 produces a variable
number of single-byte notifications - `f8`, `f0`, `fc`, `e0`, `c0` - and the
count does not track the reply a radio would send: a sixteen-byte UV-K5 hello
drew six of them, sixteen zero bytes drew eight, and the UV-82's magic drew
two where a real `06` is one byte. Runs of ones followed by zeros are what a
UART yields sampling a line at the wrong rate or an idle one, so this is
consistent with a bridge that is wired but not carrying the radio - and
equally consistent with a floating pin. One bench cannot tell those apart.

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

Writing through a dongle stays refused by the write gate either way - the
carrier is Bluetooth, and `writeTransports` means carriers a write has
survived on. The enabling sequence is the UV-5R Mini's, unchanged: read
first, prove the round trip, then add the carrier to `writeTransports` and
pass `allowBluetoothWrite` in the same commit, with the wire byte counts
recorded.
