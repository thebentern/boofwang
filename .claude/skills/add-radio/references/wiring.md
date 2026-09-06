# The wiring checklist

The goal is a new directory under `lib/radios/` and one line in the registry. In
practice a handful of files carry a per-radio entry. This list was derived by
grepping the repo for each existing radio id and by reading the two real
addition commits (`git show 6b1fb42 --stat`, `git show b993fa6 --stat`).

## Always

| File | Entry |
|---|---|
| `lib/model/codeplug.ts` | Add the id to the `RadioId` union. Do this first - everything keys off it, and a missing id surfaces as type errors in a dozen unrelated files. |
| `lib/radio/registry.ts` | Three entries: `DRIVER_FACTORIES` (with a comment saying what is enabled and why, pointing at the protocol doc), `SCHEMAS`, and `RADIO_IDS`. |
| `lib/radios/<id>/driver.ts` | The `RadioDriver`, behind a `create<Id>Driver(options)` factory taking `{ enableWrite }`. |
| `lib/radios/<id>/protocol.ts` | Wire format, magic, framing, block commands. |
| `lib/radios/<id>/schema.ts` | The `RadioSchema`. Base declares `status: 'read-only'` and `write: false`; the driver overrides both when `enableWrite` is passed. |
| `lib/radios/<id>/layout.ts` | The structs. Omitted only when a sibling driver's layout is reused, as the UV-5G reuses the UV-82's. |
| `docs/protocols/<id>.md` | What is confirmed, what is derived, what is unverified. |
| `docs/provenance.md` | Any new source, and the per-directory note listing which directories transcribe which reference. |
| `README.md` | A row in the radio table. Do not overclaim. |
| SPDX headers | `// SPDX-License-Identifier: GPL-3.0-or-later` in the first 400 bytes of every `.ts`, `.mjs` and `.js` under `lib/`, `mobile/`, `scripts/`, `sw/` and `test/`, plus the four root configs. `.vue` files do not carry one. Run `node scripts/check-headers.mjs`. |

## When the schema names an icon

`nuxt.config.ts` - every `i-lucide-…` name must be in the `SCHEMA_ICONS` array.
`fallbackToApi` is `false`, so an undeclared icon renders as nothing at all, and
a test enforces the list.

## When the radio has a CHIRP equivalent

| File | Entry |
|---|---|
| `lib/io/chirp-img.ts` | `<id>: { vendor, model, rclass }` so a CHIRP `.img` carries the right metadata. |
| `lib/io/open-image.ts` | A layout resolver, so an opened `.img` is matched to this radio. The UV-5G's is `uv5gLayoutFor(metadata, memoryLength)`. |

## When the radio has Bluetooth of its own

| File | Entry |
|---|---|
| `lib/transport/bluetooth-uuids.ts` | A `BluetoothProfile` in `KNOWN_PROFILES`, with `verified` set honestly. |
| `lib/transport/bluetooth-scan-filter.ts` | Whatever the chooser needs to list it. |

## When a dongle route is offered

`capabilities.dongle: 'k2'` in the schema, and the id joins `DONGLE_RADIOS` in
`test/lib/radio/transports.spec.ts`.

## What typecheck will find for you

`DRIVER_FACTORIES` and `SCHEMAS` in the registry are
`Record<RadioId, … | null>` - exhaustive, so adding an id to the union makes
`pnpm typecheck` demand both entries. That is why `lib/model/codeplug.ts` goes
first: the compiler then walks you through the rest.

`CHIRP_IDENTITY` in `lib/io/chirp-img.ts` is a `Partial<Record<RadioId, …>>`,
so it will **not** be flagged. Remember it yourself.

## What comes for free

These enumerate radios through `RADIO_IDS` or `IMPLEMENTED_DRIVERS` and pick a
new one up with no edit: `lib/radio/transplant.ts`, `app/pages/index.vue` and
`app/components/connect/DriverList.vue`. Cross-model copy, the port picker and
the driver list all work as soon as the registry knows about you.

`lib/storage/db.ts` is generic over `RadioId`, so backups need nothing.

## Cross-radio tests that enumerate every id

These fail as soon as a new id exists, which is the point - they are the
conformance suite. Found by grepping the repo for every existing id.

| File | What it checks |
|---|---|
| `test/lib/radio/settings-schema.spec.ts` | Per radio **and per layout**, every settings key the UI can render names a field the decoder actually produces. Add a `Case` and a fixture image entry. |
| `test/lib/radio/transports.spec.ts` | Transport and dongle declarations. `DONGLE_RADIOS` is a literal list. |
| `test/lib/radio/bulk-edit.spec.ts` | Bulk edit across every implemented driver. |
| `test/lib/validate/rules.spec.ts` | Shared validation rules against every schema. |
| `test/lib/validate/references.spec.ts` | Channel-reference handling across every driver. |
| `test/app/ui-features.spec.ts` | Iterates a literal list of all five ids; also asserts every DMR panel is gated on a schema feature rather than "a codeplug is open". |
| `test/lib/radio/place.spec.ts` | A literal list, currently four ids. Decide whether yours belongs and say why in a comment if it does not. |
| `test/lib/transport/native-serial-port.spec.ts` | Each driver's `serial` options. |
| `test/lib/io/open-image.spec.ts` | Opening a CHIRP `.img` resolves to the right radio. |

## Shared model tables

Nothing to register for an ordinary analog radio - `lib/model/tones.ts` exports
`CTCSS_DECIHZ` and `DTCS_CODES` and your schema points at them or at a subset.

`EncryptionType` in `lib/model/codeplug.ts` is a closed union
(`none`, `custom`, `arc4`, `aes128`, `aes256`). A radio with a key type outside
it needs the union widened plus entries in `KEY_BYTES` and `KEY_TYPE_LABELS` in
`lib/model/encryption.ts`, both exhaustive records.

## Per-radio tests you add

`test/lib/radios/<id>/` - at minimum `hardware-fixture.spec.ts` and
`write.spec.ts`, plus `settings.spec.ts` if the radio has a settings table. See
`references/tests-and-fixtures.md`.

`test/hardware/<id>.spec.ts` for the real-radio session, gated behind
`BOOFWANG_HW`.

## Fixtures

`test/fixtures/images/<id>-<firmware>.bin` and, where the image is not one flat
region, `<id>-<firmware>.index.json`. Plus
`test/fixtures/<id>-chirp-decode.json` and `<id>-chirp-settings.json` if you
cross-checked against CHIRP, which you should have.

## What must stay empty

`app/`. The UV-5G addition touched zero files there. If yours does, the
`RadioSchema` is missing something. The only existing exception is the DM-32UV
boot image, hardcoded in `app/composables/useBootImage.ts` and
`app/pages/startup-image.vue`, and that is a known defect rather than a
precedent.

## Before staging

Another agent may be working in this repository. Check `git status` and stage
only the paths you touched. Never `git add -A`.
