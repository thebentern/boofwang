# boofwang

Browser-based codeplug editor and programmer for two-way radios, over the
[Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API).
Static site, no server, no account. Codeplugs stay on the machine.

Live at [boofwa.ng](https://boofwa.ng).

## Radios

| Radio | Memory | Read | Write | Hardware-verified |
|---|---|---|---|---|
| Quansheng UV-K5 | 200 channels, analog, 8 KB EEPROM | Yes | Yes | Read, write, restore |
| Baofeng UV-82 | 128 channels, analog, 6 KB image | Yes | Yes | Read, write, restore |
| Baofeng UV-5R Mini | 999 channels, analog, 33 KB image | Yes | Yes | Read, write, restore |
| Baofeng DM-32UV | 4000 channels, DMR, zones/talkgroups/AES keys | Yes | Key slots only | Read, write, restore |

CHIRP has no DM-32UV driver. Baofeng's own CPS is Windows-only.

Per-radio protocol notes, including exactly what has and has not been exercised
against hardware, are in [`docs/protocols/`](docs/protocols/).

Two different radios are sold as "UV-5R Mini" and "5RM"/"UV-5RM". They differ in
ident string, region map, channel count and power table. Both are implemented;
the handshake selects between them. Only the UV-5R Mini has been tested on
hardware.

DM-32UV writes cover channel records, zones and their channel lists, talk
groups, scan list names, RX groups, DMR radio IDs, radio settings and the
encryption key slots, the per-channel talk group, and the DMR address book in
its own memory region. Channels and contacts can be added and removed. Its pages
relocate between sessions and 22 of its 59 allocated blocks are undocumented, so
every other byte is read, preserved and never sent back.

## File formats

| Format | Read | Write |
|---|---|---|
| `.bwp` — boofwang codeplug; records radio identity and a SHA-256 | Yes | Yes |
| CHIRP `.img` | Yes | Yes |
| CHIRP CSV | Yes | Yes |
| Raw `.bin` | Yes | Yes |

CSV output is byte-identical to CHIRP's own, checked by loading it with
`chirp.generic_csv.CSVRadio` and diffing CHIRP's re-export
(`scripts/crosscheck-chirp-csv.py`).

`.img` files carry CHIRP's metadata trailer and open in CHIRP. The DM-32UV is
excluded, because CHIRP cannot open a radio it has no driver for.

## Development

Requires [pnpm](https://pnpm.io/). Node 24.11.1 is pinned in `.npmrc` via
`use-node-version`.

```bash
pnpm install
pnpm dev            # http://localhost:3000
pnpm test
pnpm typecheck
pnpm lint
pnpm build          # static output in .output/public
```

No test requires a radio. Drivers are exercised against captured hardware
images in `test/fixtures/images/` and a scripted fake serial port.

Upstream references the drivers are transcribed from (CHIRP sources, the DM-32UV
protocol specification) are not redistributed here. Fetch them into the
git-ignored `reference/` directory:

```bash
./scripts/fetch-reference.sh
```

## Serial bridge (development only)

Web Serial requires a person to answer a native port chooser, so an automated
session cannot obtain a port. `tools/serial-bridge` supplies a `SerialPortLike`
backed by a localhost WebSocket instead of `navigator.serial`.

```bash
pnpm bridge                       # one terminal
pnpm dev                          # another
# http://localhost:3000/?bridge
```

Everything below the `SerialPortLike` seam is the shipping code path: transport
framing, timeouts, protocol, driver, decode and UI. It does not exercise the
`navigator.serial` glue in `app/composables/useWebSerial.ts`.

Constraints: binds to 127.0.0.1, rejects non-localhost origins, is never started
by the app or the build, and the client side requires both a dev build and an
explicit `?bridge` query parameter.

## Layout

```
lib/          framework-agnostic core; no Vue or Nuxt imports, runs in plain Node
  codec/      binary struct DSL: explicit offsets, partial writes, coverage reporting
  transport/  Web Serial framing, timeouts, teardown, fakes, trace recorder
  radio/      driver interface, registry, image model, write gate, diffing
  radios/     one directory per radio: protocol, layout, schema, driver
  model/      channels, tones, units, codeplug document
  io/         CHIRP CSV, CHIRP .img, .bwp, raw .bin
  storage/    IndexedDB backups
  platform/   browser capability checks
app/          Nuxt 4 UI, rendered from radio schemas rather than per-radio code
```

The `lib/` boundary is enforced by an ESLint `no-restricted-imports` rule and by
a Vitest project running in a DOM-less Node environment.

### Encoding invariant

`driver.encode(doc, base)` takes the bytes read off the radio as its base and
overwrites only the ranges the driver declares it understands. There is no
`encode(doc)`. Bytes the codebase does not model survive a read/edit/write cycle
because they are never allocated fresh.

Tested directly: `encode(decode(image), image)` is byte-identical to `image`,
for every fixture.

## Safety

- A backup of the connected radio is required before any write, enforced in the
  driver rather than the UI. `writeImage` throws `BackupRequiredError` when one
  is absent or belongs to a different radio.
- Where a driver can fingerprint the physical unit, the backup must match that
  unit and not merely the model and firmware. The DM-32UV uses its calibration
  block; identifiers derived only from firmware cannot distinguish two identical
  radios.
- Every write is preceded by a byte diff. A change outside the ranges the driver
  claims to own blocks the write; it indicates a defect in the encoder.
- Every block written is read back and compared before the next is sent.
- **Every write is followed by a full independent read of the whole radio**, and
  the result diffed against the pre-write image. Nothing else catches damage
  outside the blocks that were sent. A UV-5R Mini erased 19 channels while every
  frame was acknowledged, every block read back and matched, and the round-trip
  invariant stayed byte-identical - because the block that was sent was correct
  and the damage was everywhere else. That radio now receives its whole image on
  every write; the other three take a sparse write and have each been proven to
  by exactly this check.
- Read-only regions are marked in the image and never transmitted. The UV-K5's
  calibration block is one.
- Receive-only channels are decoded as such and preserved. The UV-K5 has no
  transmit-inhibit bit; CHIRP expresses it by parking the transmit frequency at
  zero, and boofwang reads and writes that convention.
- Transmitting into a receive-only allocation is a blocking error, not a
  warning.
- Unrecognised firmware is read-only but still readable, so an unsupported radio
  can still be backed up.
- Encryption key material is masked by default and revealed one slot at a time.
  The keys page states the legal position: encryption is prohibited on amateur
  (47 CFR 97.113(a)(4)), GMRS/FRS (95.1731, 95.587) and MURS (95.2731).

The write gate is a single pure function, `evaluateWriteGate`, called by both
the UI and the transfer flow. Its blocking conditions are: writing unsupported
for the radio or firmware, image/radio mismatch, missing or foreign backup,
encode failure, changed bytes outside owned ranges, validation errors, and
nothing to write.

## Licence

GPL-3.0-or-later. See [`LICENSE`](LICENSE) and
[`docs/provenance.md`](docs/provenance.md).

Independent project. Not affiliated with or endorsed by Baofeng, Quansheng, or
the CHIRP project.
