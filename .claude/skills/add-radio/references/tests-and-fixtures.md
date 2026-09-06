# Tests, fixtures and hardware gating

## The vitest projects

`vitest.config.ts` defines six: `core` (node, no DOM, enforces that `lib/` is
framework-agnostic), `app`, `nuxt`, `electron`, `sw`, and `hardware`.

`hardware` is included in the config but every spec in it skips itself unless
`BOOFWANG_HW` is set, so it is inert in CI. Its `testTimeout` is 30 minutes.

**No test in the default run may require a radio.** Drivers run against captured
hardware images in `test/fixtures/images/` and scripted fake ports.

## What a new radio must have

### `test/lib/radios/<id>/hardware-fixture.spec.ts`

The committed capture is the shape you say it is, the ident bytes are the ones
the radio actually sent, and the decode agrees with the reference parser field
for field. The UV-5G's checks the image size, the eight ident bytes, the
firmware string window, that the ident magic is the one no other CHIRP model
shares, that the firmware classifier fails closed on garbage, and then compares
all 41 channels against `uv5g-chirp-decode.json` - name, rx, tx, bandwidth,
power, skip and both tones.

### `test/lib/radios/<id>/write.spec.ts`

Two halves.

The round-trip invariant, on real radio bytes:

```
encode(decode(image), image) is byte-identical across every region
```

Then the gate, driven through a `FakeSerialPort`: it refuses when the build is
not cleared to write and says so by name, refuses without a backup, refuses an
image from a different radio before touching the port, writes nothing when the
radio already holds the image, and restores a drifted byte through the
read-first path and verifies it.

### `test/lib/radios/<id>/settings.spec.ts`

If the radio has a settings table. Must include "round-trips the whole image
byte for byte" with settings decoded, because a settings transcription can look
right, round-trip perfectly, and still be reading the wrong bytes - which is
what the CHIRP cross-check catches and this test does not.

### Cross-radio suites you must extend

- `test/lib/radio/settings-schema.spec.ts` - add a `Case` (id, layout, image)
  and a fixture entry. It checks **per radio and per layout** that every
  settings key the UI can render names a field the decoder actually produces. A
  key matching nothing is invisible: the control renders, `encodeSettings` skips
  it, the write reports success, and the radio does not change.
- `test/app/ui-features.spec.ts` - iterates every radio id.
- `test/lib/radio/transports.spec.ts` - transport and dongle declarations.
- `test/lib/transport/native-serial-port.spec.ts` - each driver's `serial`.
- `test/lib/io/open-image.spec.ts` - if you added a CHIRP `.img` resolver.

## Fixtures

`test/fixtures/images/<id>-<firmware>.bin` is the capture. Where the image is
not one flat region, `<id>-<firmware>.index.json` records the region table:

```json
{
  "ident46": "...",
  "ident4d": "5RMINI  +L00000",
  "regions": [{ "start": 0, "size": 32832 }, ...],
  "sha256": "31672672aad2...",
  "bytes": 33344,
  "note": "Factory-default codeplug read from a real Baofeng UV-5R Mini over an FTDI cable. No names, no DTMF identities and no high-entropy data: every channel is unnamed and the printable-string scan finds nothing."
}
```

The `note` is where you record the key-material scan result. Write it honestly.

`test/fixtures/<id>-chirp-decode.json` and `<id>-chirp-settings.json` hold what
CHIRP's own `bitwise` engine produced from the same bytes. Generate them with a
script under `scripts/` and commit the script too, so the numbers are
re-derivable - the UV-5G's is `scripts/dump-uv5r-channels.py`.

## Scan every capture for key material before committing it

A fixture once shipped with fourteen real AES keys in it. The guard that missed
them asked the decoder how many key slots there were, the decoder said eight,
and the other six sat in the file underneath a green test.

So the DM-32UV now has three independent checks, and the pattern is worth
copying if your radio stores keys:

1. Every decoded key is all zeros.
2. **Layout-blind**: walk every record position the block can physically hold,
   ignoring the decoder's slot count, and assert the key field is zero at all of
   them.
3. **Entropy**: no 32-byte run anywhere in the key table has 28 or more distinct
   bytes. Real AES-256 keys are 32 bytes with almost no repeats; structured
   codeplug data is not.

Also scan for names, DTMF identities and any printable string that identifies a
person, and say in the fixture `note` what you looked for.

## Running things

```bash
pnpm vitest run
```

```bash
pnpm vitest run test/lib/radios/<id>
```

Hardware, with a radio on a cable:

```bash
BOOFWANG_HW=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX pnpm vitest run test/hardware
```

Over the BLE bridge, `BOOFWANG_HW_PORT` is the address the bridge lists, and
`pnpm bridge` or `pnpm bridge:ble` must be running.

`BOOFWANG_FIXTURE` gates fixture regeneration. None of these run in the normal
gate.

`pnpm vitest run | tail -3` prints timings, not the summary. Read the whole
output.

## Turn a hardware session into a regression test

`lib/transport/recording-transport.ts` wraps a real transport and records a
`Trace`. Record during the verified session, then replay it through
`scriptedResponder` so the exchange that proved the driver works keeps proving
it without the radio.
