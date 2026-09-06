---
name: add-radio
description: Add support for a new two-way radio to boofwang - a new driver under lib/radios/, its schema, protocol, layout, tests, fixtures and protocol notes. Use whenever someone wants boofwang to read or write a radio it does not yet support, names a model that is not one of the five implemented ones (UV-K5, UV-82, UV-5G, UV-5R Mini, DM-32UV), asks to enable writing on a read-only radio, asks what a new radio would take, or asks to add a firmware variant to an existing driver. Covers identifying which radio you actually have, the capability triage that decides scope, the codec and layout, the wiring checklist, the round-trip and fixture tests, hardware verification, and the adversarial review that must happen before the first write.
---

# Adding a radio to boofwang

A wrong byte can leave someone's radio unable to boot or unable to transmit, and
a wrong frequency can put them outside their license. Everything in this skill
exists because of that. Read `CLAUDE.md` before you start - this skill is the
procedure, that file is the law.

Two real additions are the worked examples. Read both diffs before you write
anything:

```bash
git show 6b1fb42 --stat   # UV-5G: 24 files, zero under app/
git show b993fa6 --stat   # DM-32UV: 19 files, and it did touch app/
```

The UV-5G is what a clean addition looks like. The DM-32UV touched `app/`
because it brought a capability the `RadioSchema` had no word for. That
difference is the whole subject of phase 1.

## Three rules you cannot design around

**`encode(doc, base)` patches a clone of the image the radio gave you.** There
is deliberately no `encode(doc)`. Bytes nobody has decoded survive because they
are carried through, never fabricated. The invariant is
`encode(decode(img), img) === img`, byte for byte, asserted against a real
hardware capture. That test is what proves a new field did not disturb its
neighbors.

**`ownedRanges()` is a claim, checked in both directions.** A change landing
outside the ranges a driver claims is a blocker (`unowned-bytes-changed`), not a
warning. Never widen `ownedRanges` to make it pass. It is telling you the
encoder is wrong.

**Reading is offered for unknown firmware; writing waits for evidence.** A
backup is exactly what an unsupported radio needs. Ship the driver read-only,
then enable writing only after hardware verification and an adversarial review.
More than one existing driver had a real defect found that way, before hardware.

## Phase 0 - settle which radio this is, before writing code

Names do not identify radios. Four different radios are sold as some spelling of
"UV-5G", across two protocols that share nothing. The name could not decide; the
ident magic could.

Write a throwaway probe script before a driver. Send each candidate ident magic
and see which one the radio acknowledges. Record the answer, the magic that
worked, and the magics that did not, in `docs/protocols/<radio>.md`. Everything
downstream - which existing driver to copy, which reference to transcribe - falls
out of this answer, and getting it wrong means transcribing the wrong memory map.

If the radio turns out to be a sibling of one already supported, do not copy the
driver. Parameterize the existing one. `lib/radios/uv5g/driver.ts` is 25 lines
because `createUv5rFamilyDriver` was factored out of the UV-82 rather than
duplicated - which mirrors CHIRP, where `RadioddityUV5GRadio` is a bare subclass
of `BaofengUV5R`.

## Phase 1 - capability triage decides your scope

Answer these before estimating anything. Each "yes" adds files and obligations.
See `references/capabilities.md` for the full matrix with the files each row
adds.

| Question | If yes |
|---|---|
| Does an existing driver already speak this protocol? | Parameterize it, do not copy. Your directory holds the magic, schema and classifier only. |
| Is it reachable only by cable? | `transports: ['serial']`. Nothing else to do. |
| Does it have a Bluetooth module of its own? | Add a service UUID to `lib/transport/bluetooth-uuids.ts` and a scan filter. `transports` gains `'bluetooth'`. You must enumerate a real radio to get the UUID. |
| Does a clip-on BLE-to-serial dongle fit its jack? | `capabilities.dongle: 'k2'` - and that is a claim about the jack only. `dongleProven` is a separate claim about this radio, and needs a codeplug actually read through one. |
| Is it DMR? | `features.dmr`, plus talk groups, contacts, rx groups, radio IDs. Adds a page map and address-book handling. Largest driver in the repo by far. |
| Does it store encryption keys? | `features.encryption`. Triggers the masking rule and the fixture key scan. A fixture once shipped with fourteen real AES keys in it. |
| Does it have a boot or startup image? | The `RadioSchema` has no word for this. The DM-32UV's lives in `app/composables/useBootImage.ts` with the radio id hardcoded. That is the one known schema gap - a precedent to fix, not to copy. |
| Does it have more than one firmware layout? | `SettingGroup.layouts` gates settings per layout, and `rfFor(doc)` varies the RF profile. See the UV-K5's stock and egzumer pair. |
| Does it erase a flash page before programming? | `capabilities.writesWholeImage: true`. A sparse write wipes everything sharing that page. It erased 19 channels on a real UV-5R Mini before that was understood. |
| Can a single channel be marked receive-only? | `rf.txInhibit`. `false` means an RX-only channel must be **refused**, never programmed as transmit-capable. |
| Can you fingerprint the physical unit? | Implement `unitFingerprint` from factory per-unit data such as calibration. Return `null` only if there is genuinely nothing, and callers must read that as "cannot tell". |

**If a capability forces a change under `app/`, stop.** The `RadioSchema` is
missing something. Fix the schema so the UI stays a pure function of it, then
come back. The only existing exception is the boot image, and it is a defect.

## Phase 2 - transcribe, then cross-check against a parser

Transcribe offsets from the vendored reference in `reference/` (fetch it with
`./scripts/fetch-reference.sh`; it is git-ignored and never redistributed).
Credit the source in a comment in every file that carries transcribed offsets.
Never guess a field name for a byte nobody has explained - leave it undecoded and
let `encode(doc, base)` carry it through.

Then cross-check against the reference implementation's own parser, not against a
second reading of the same document. `reference/chirp_pkg` is importable, so the
same bytes can go through CHIRP's `bitwise` engine and be compared field by
field. Write the comparison out as a JSON fixture
(`test/fixtures/<radio>-chirp-decode.json`) and assert against it.

This step is not optional and it is not ceremony. It caught the UV-K5's 10 Hz
scaling, the UV-82's inverted `wide` bit, the UV-5R Mini's 105-code DTCS table
and the DM-32UV's BCD tones. Every one of them looked correct until it was
checked.

Details of the codec DSL and how a layout yields `ownedRanges` are in
`references/codec-and-layout.md`. The wire protocol, framing and the fakes that
let you test without hardware are in `references/protocol-and-transport.md`.

## Phase 3 - wire it up

The target is a new directory under `lib/radios/` and one line in
`lib/radio/registry.ts`. In practice a handful of other files carry a per-radio
entry. `references/wiring.md` is the exhaustive checklist with the entry format
for each. The ones nobody remembers:

- `lib/model/codeplug.ts` - the `RadioId` union. Everything else keys off it, so
  a missing id shows up as a type error in a dozen unrelated files.
- `lib/radio/registry.ts` - three entries: `DRIVER_FACTORIES`, `SCHEMAS` and
  `RADIO_IDS`. The comment above each factory says what is enabled and why.
- `nuxt.config.ts` - every `i-lucide-…` name your schema uses must be in
  `SCHEMA_ICONS`. `fallbackToApi` is `false`, so an undeclared icon renders as
  nothing at all. A test enforces the list.
- `lib/io/chirp-img.ts` and `lib/io/open-image.ts` - so a CHIRP `.img` from this
  radio opens.
- SPDX header as the first line of every `.ts` you add under `lib/`, `test/` and
  `scripts/`. `.vue` files do not carry one. `node scripts/check-headers.mjs`
  checks `lib/`, `mobile/`, `scripts/`, `sw/` and `test/`.

## Phase 4 - tests before hardware

By analogy across the five radios, a new one needs at minimum:

- `test/lib/radios/<id>/hardware-fixture.spec.ts` - the committed capture is the
  right shape, the ident is what the radio sent, and the decode agrees with the
  reference parser field for field.
- `test/lib/radios/<id>/write.spec.ts` - the round-trip invariant
  `encode(decode(image), image)` byte-identical across every region, plus the
  write gate refusing without a backup, refusing another radio's image, and
  writing nothing when the radio already holds the image.
- `test/lib/radios/<id>/settings.spec.ts` - if the radio has a settings table.
- An entry in `test/lib/radio/settings-schema.spec.ts`, which checks per radio
  **and per layout** that every settings key the UI can render names a field the
  decoder actually produces. A key that matches nothing is invisible: the control
  renders, the encoder skips it, the write reports success, the radio does not
  change.

No test in the default run may require a radio. Drive the protocol with the fake
port. Hardware tests live in `test/hardware/` behind `BOOFWANG_HW`.
`references/tests-and-fixtures.md` has the commands, the fixture formats and the
key-material scan you must run before committing a capture.

## Phase 5 - verify on hardware, and write down what you did not verify

Record in `docs/protocols/<radio>.md`, with real numbers:

1. The exact byte counts on the wire.
2. A read taken with an independent reader outside the app, matching sha256.
3. A write, then a restore back to the original sha256, confirmed independently.

Then list what was **not** exercised. Every existing protocol doc has a "Not
verified" section, and the DM-32UV's says plainly why one block stays unrun.
`references/docs-and-claims.md` has the section template.

## Phase 6 - adversarial review, then enable writing

Run an adversarial review before the first write to any new radio. Ask a
reviewer to try to refute the encoder: which byte could move that nobody
noticed, which field fails closed, which comment claims something the reference
does not say. The UV-5G's review caught a classifier that failed open on an
unreadable version number, and a comment falsely claiming CHIRP reads a `0x00`
transmit fill as inhibited.

Only then flip `enableWrite: true` in the registry, and say in the comment
exactly what the write path can reach.

## Phase 7 - claims

Never claim more than is true. The README once said CHIRP CSV could be read when
nothing could read one, and a driver list once said "verified" about a radio
nobody had plugged in. Update the README radio table, `docs/provenance.md` for
any new source, and the schema `status` field - `read-only` until a write has
been verified on hardware, `beta` before it has been exercised broadly.

## The gate

All of these pass before anything is committed:

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build && node scripts/check-headers.mjs
```

Read the output. `pnpm vitest run | tail -3` prints timings, not the summary.
Another agent may be working in this repository - check `git status` and stage
only the paths you touched. Never `git add -A`.

Commit subject is an imperative sentence in sentence case, no prefix, no trailing
period. The body explains why, records your wrong turns, and ends by naming what
was verified with real numbers - or by saying plainly what was not.

## References

- `references/capabilities.md` - the full capability matrix and what each row costs
- `references/contracts.md` - every member of `RadioDriver` and `RadioSchema`
- `references/codec-and-layout.md` - the binary codec DSL, layouts, `ownedRanges`
- `references/protocol-and-transport.md` - the wire, serial and BLE, the fakes
- `references/wiring.md` - the exhaustive per-radio touchpoint checklist
- `references/tests-and-fixtures.md` - test obligations, fixtures, hardware gating
- `references/docs-and-claims.md` - protocol doc template, provenance, status
