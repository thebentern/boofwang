# Capability triage - what your radio needs, and what each thing costs

Answer these before estimating. The five implemented radios span the whole
range: `lib/radios/uv5g/driver.ts` is 25 lines,
`lib/radios/dm32uv/driver.ts` is about 2,900.

## The five, side by side

Values below are the base schema. Read them from the files rather than trusting
this table if they disagree.

| | UV-K5 | UV-82 | UV-5G | UV-5R Mini | DM-32UV |
|---|---|---|---|---|---|
| Baud | 38400 | 9600 | 9600 | 115200 | 115200 |
| Channels | 200 | 128 | 128 | 1000 | 4000 |
| Transports | serial | serial | serial | serial, bluetooth | serial |
| Dongle jack | k2 | k2 | k2 | k2, proven | none |
| DMR | no | no | no | no | yes |
| Encryption | no | no | no | no | 22 slots |
| Whole-image write | no | no | no | yes | no |
| Multiple layouts | stock, egzumer firmware | no | no | 2 sibling radios | no |
| Driver size | 654 | 765 | 25 | 703 | 2881 |

The DM-32UV is the only radio that touches `app/`, and only for its boot image.

## How write enablement actually works

The base schema always declares `status: 'read-only'` and
`capabilities.write: false`. The driver factory overrides both when its caller
passes `enableWrite: true`:

```ts
// lib/radios/uv82/driver.ts
const schema = options.enableWrite
  ? { ...model.schema, status: 'beta', capabilities: { ...model.schema.capabilities, write: true } }
  : model.schema
```

`lib/radio/registry.ts` is where `enableWrite: true` is passed, with a comment
saying what the write path can reach and pointing at the protocol doc. Ship your
radio without it. Add it in the commit that records the verified write session.

## The triage

### Does an existing driver already speak this protocol?

Parameterize, do not copy. The UV-5G is a `Uv5rFamilyModel` handed to
`createUv5rFamilyDriver`, supplying only the ident magic, the schema and a
firmware classifier. If your radio differs on the wire, that difference belongs
in the shared model type, not in a forked driver.

Adds: `driver.ts`, `protocol.ts`, `schema.ts`. Nothing else.

### Cable only

`transports: ['serial']`. Set `serial` on the driver from the radio's clone
rate. Nothing more.

### Its own Bluetooth module

`transports: ['serial', 'bluetooth']`. You must enumerate a real radio to get
the service UUID - `requestDevice` filters the chooser on exactly that number,
so a guess opens a chooser that lists nothing, which is indistinguishable from a
radio that is switched off. This project has already misdiagnosed that twice.

Adds: entries in `lib/transport/bluetooth-uuids.ts` and
`lib/transport/bluetooth-scan-filter.ts`, tests under `test/lib/transport/`, and
a BLE section in the protocol doc.

Writing over Bluetooth is a separate claim. Omit `writeTransports` only once a
write has survived the link. Until then list the carriers that are verified.

### A clip-on BLE-to-serial dongle fits the jack

`capabilities.dongle: 'k2'`. This says the two-pin Kenwood plug fits and nothing
more. The radio behind a dongle is an ordinary cabled radio - it never knows the
cable became a radio link - which is why this is deliberately not an entry in
`transports`.

`dongleProven: true` is the separate, stronger claim that a codeplug has come
off **this** radio through one. A Baofeng BT-A1D read a whole UV-5R Mini and
drew nothing at all from a UV-82 on the same day, so one flag cannot speak for
both. See `docs/protocols/ble-dongle.md`.

### DMR

`features.dmr: { colorCodes: [lo, hi], timeslots: 1 | 2 }`, plus whichever of
`talkGroups`, `contacts`, `rxGroups`, `scanLists`, `radioIds` and `messages` the
radio actually has. Each is a feature flag, not an observation about the current
codeplug: a radio with no message memory must not be offered the control.

Adds: an address book, usually a page map, and by far the most protocol-doc
work. The DM-32UV has `pagemap.ts` and `image.ts` on top of the usual files.

### Encryption keys

`features.encryption: { slots, types, nameLength }`.

This triggers hard rules. Key material is masked by default, revealed one slot
at a time, and never leaves in a summary or in an export that is not the full
codeplug. Scan any new hardware capture for real keys before committing it - a
fixture once shipped with fourteen real AES keys in it. The committed DM-32UV
fixture has every key field zeroed, and a test asserts they never come back.

The per-channel key selector must check the channel's own frequency and refuse
to save an encrypted channel on a service where that is unlawful, naming the
rule. Encryption is permitted only under a license that authorizes it, typically
Part 90, and prohibited on amateur radio, GMRS, FRS and MURS.

### A boot or startup image

The `RadioSchema` has no word for this. The DM-32UV's support lives in
`app/composables/useBootImage.ts` and `app/pages/startup-image.vue` with the
radio id hardcoded in both. That is the one place the schema-driven rule is
broken today.

If your radio needs one, the right move is to add a schema feature and move the
DM-32UV onto it, not to add a second hardcoded id. Say so in the commit either
way.

### More than one firmware layout

`SettingGroup.layouts` gates a settings group to particular layouts, and
`rfFor(doc)` lets the RF profile vary. The UV-K5 needs both: egzumer receives
where stock does not, offers single sideband, and has twenty-four tuning steps
against stock's six.

Adds: a second layout file, a `variants.ts`, and per-layout cases in
`test/lib/radio/settings-schema.spec.ts` - the check is per radio **and per
layout**, because a group declared for one says nothing about the other.

Two different things both end up in `layout`. The UV-K5's is firmware: one
radio, two EEPROM arrangements, chosen by the firmware string. The UV-5R Mini's
is hardware: `layout` records which of two sibling radios answered the ident,
each with its own region table and channel count, and `writeImage` refuses when
the image's variant is not the one on the cable. Decide which you have before
you name the field.

### It erases a flash page before programming

`capabilities.writesWholeImage: true`, and the driver sends every block. A
sparse write wipes everything sharing the erased page. This erased 19 channels
on a real UV-5R Mini before it was understood. The confirmation has to say the
whole image is going, because telling someone "1 block" while sending the whole
radio describes their edit rather than the write.

### Receive-only channels

`rf.txInhibit` is `false` or `{ mechanism }`. Mechanisms in use today: a
per-channel transmit-forbid flag (DM-32UV), transmit frequency set to zero
(UV-82, UV-5G), transmit frequency filled with `0xFF` or `0x00` (UV-5R Mini),
and the transmit frequency parked at 0 MHz via a minus shift whose offset equals
the RX frequency (UV-K5).

`false` means an RX-only channel cannot be honored and must be refused - throw
`TxInhibitUnsupportedError`, never program it as transmit-capable. A channel
that quietly becomes transmit-capable is the failure that puts a weather or
public-safety frequency into a radio someone can key up. It must stay visible in
the table gutter, the Transmit column, preset rows and the diff, and
`lib/radio/channel-diff.ts` calls it out by name as `gain`.

### A write that cannot reach the whole codeplug

`capabilities.writeScope` - a plain sentence about what a write actually
reaches. Used by the restore screen and the write gate, deliberately not by the
connect screen's chip, which grew to thirteen clauses and opened with the word
"Read" on a driver that writes.

Without it, editing something outside the scope looks like it worked and the
write then reports "nothing has changed", which is both false and unhelpful.

### Per-unit fingerprinting

Implement `unitFingerprint` wherever the radio exposes factory per-unit data.
The DM-32UV compares its calibration block. Without it, a user with two
identical radios could write one while the only backup belonged to the other,
because `identHash` covers only model, firmware and build date.

Return `null` only when there is genuinely nothing unit-specific, and remember
callers must read `null` as "cannot tell", never as "matches".

### Read-only regions

Regions marked `readOnly` are claimed by nobody, which is what makes them
unwritable. Calibration is captured in every backup so a restore can put it
back, and is never sent.
