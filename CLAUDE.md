# boofwang

A browser-based CPS for two-way radios: read a radio's codeplug over Web Serial or
Web Bluetooth, edit it, write it back. Nuxt 4 + Vue 3 + Tailwind 4 + Nuxt UI v4,
`ssr: false`, static on GitHub Pages at boofwa.ng. GPL-3.0-or-later.

Four radios: Quansheng UV-K5, Baofeng UV-82, Baofeng UV-5R Mini, Baofeng DM-32UV.

**The thing to understand before changing anything:** these memory formats are not
documented by their manufacturers. They are worked out by reading other people's
implementations and watching real radios. A wrong byte can leave someone's radio
unable to boot or unable to transmit, and a wrong frequency can put them outside
their licence. Everything below exists because of that.

## Rules that prevent damage

Break these and someone's radio pays for it.

**`encode(doc, base)` — there is deliberately no `encode(doc)`.** Encoding always
takes the image that was read from the radio and patches a clone of it. Bytes this
codebase has never decoded survive because they are carried through, never
fabricated. On the DM-32UV that is 22 of 59 allocated blocks. The invariant is
`encode(decode(img), img) === img`, byte for byte, asserted against real hardware
captures. If you add a field, that test is what proves you did not disturb its
neighbours.

**`ownedRanges()` is a claim, and it is checked in both directions.** It returns the
byte ranges a driver says it understands. A change landing outside them is a
*blocker*, not a warning — `diffImages` collects them into `ImageDiff.unowned` and
the gate raises `unowned-bytes-changed`, whose message says "That is a defect in
boofwang, not in your codeplug." Never widen `ownedRanges` to silence that. It is
telling you the encoder is wrong.

**A write is never one click from idle.** Backup, then diff, then a typed
confirmation. `writeImage` throws `BackupRequiredError` when there is no backup or
it belongs to another radio. Where a driver can fingerprint the physical unit it
must — the DM-32UV compares the calibration block, because `identHash` covers only
model, firmware and build date and two identical radios are indistinguishable by it.

**Every block written is read back and compared before the next is sent.** An
acknowledgement says a frame arrived, not that it landed where it was meant to.

**Read-only regions are claimed by nobody.** That is what makes them unwritable.
Calibration is captured in every backup so a restore can put it back, and never sent.

**The gate explains; the driver enforces.** `evaluateWriteGate` exists to tell a
person why they are stuck. `writeImage` exists to be unbypassable. If they ever
disagree, the driver wins and the user sees an error rather than a well-worded
dialog. Never move a check out of the driver into the UI.

**Receive-only must survive every path.** A channel that quietly becomes
transmit-capable is the failure that puts a weather or public-safety frequency into
a radio someone can key up. It is visible in the table gutter, the Transmit column,
preset rows and the diff, and `channel-diff.ts` calls it out by name as `gain`.

**Key material is masked by default, revealed one slot at a time, and never leaves
in a summary or an export that is not the full codeplug.** A fixture once shipped
with fourteen real AES keys in it. Scan any new hardware capture before committing it.

**The offline cache holds one build, states which, and never activates itself.**
A browser can now keep a copy of boofwang indefinitely, so a stale copy writing an
old understanding of a radio's memory is a real failure mode - which is why the
build is named in the footer of every page and the About page says how old it is.
`sw/worker.js` caches exactly what the build emitted, adds nothing
opportunistically and never touches a cross-origin request, because the repeater
directories are live. A waiting update is offered, never applied: a reload
discards unwritten edits, so the offer is priced by the risk register and is
withdrawn entirely while a transfer is running.

## Structure

```
lib/        framework-agnostic core. No vue, pinia, nuxt or ~/ imports — ESLint
            enforces this, and a DOM-less vitest project catches the rest.
  codec/    binary struct DSL: explicit offsets, partial writes, coverage
  transport/ Web Serial and Web Bluetooth, framing, timeouts, fakes, trace recorder
  radio/    driver interface, registry, image model, write gate, diffing, transplant, fleet
  radios/   one directory per radio: protocol, layout, schema, driver
  model/    channels, tones, units, codeplug document
  io/       CHIRP CSV in and out, CHIRP .img, .bwp, raw .bin, summaries, presets
  validate/ shared rules
  storage/  IndexedDB backups
  version/  which build is running, and whether an update is worth a prompt
app/        Nuxt UI, rendered from RadioSchema rather than per-radio code
sw/         the offline cache. A classic worker script whose four constants
            `scripts/build-service-worker.mjs` fills in over a built site
test/       core (node), app, nuxt, electron, sw vitest projects
docs/protocols/  one per radio: what is confirmed, what is derived, what is unverified
reference/  vendored upstream sources. Git-ignored. `./scripts/fetch-reference.sh`
```

Adding a radio should mean a new directory under `lib/radios/` and one line in
`lib/radio/registry.ts`. If it forces a change under `app/`, the `RadioSchema` is
missing something — fix that instead.

## The gate

All of these must pass before anything is committed:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm vitest run
pnpm build
node scripts/check-headers.mjs
```

`exactOptionalPropertyTypes` is on: write `...(x === undefined ? {} : { k: x })`
rather than assigning `undefined`.

No test in the default run requires a radio. Drivers run against captured hardware
images in `test/fixtures/images/` and scripted fake ports. There is a fourth vitest
project, `hardware`, gated behind `BOOFWANG_HW` (with `BOOFWANG_HW_PORT`), and
`BOOFWANG_FIXTURE` gates fixture regeneration. None of them run in the normal gate.

Every file under `lib/`, `test/` and `scripts/` carries
`// SPDX-License-Identifier: GPL-3.0-or-later` as its first line. `.vue` files do not.

## How a radio gets added

1. **Transcribe** the offsets from the vendored reference, crediting the source in a
   comment. Never guess a field name for a byte nobody has explained.
2. **Cross-check against the reference implementation's own parser**, not against a
   second reading of the same document. `reference/chirp_pkg` is importable, so the
   same bytes can go through CHIRP's `bitwise` engine and be compared field by field.
   This is what caught the UV-K5's 10 Hz scaling, the UV-82's inverted `wide` bit,
   the UV-5R Mini's 105-code DTCS table and the DM-32UV's BCD tones — every one of
   which looked correct until it was checked.
3. **Verify on hardware**, and record it in `docs/protocols/<radio>.md`: the exact
   byte counts on the wire, a read taken with an independent reader outside the app,
   and a write followed by a restore back to the original sha256.
4. **Only then enable writing.** Reading is offered for unknown firmware — a backup
   is exactly what an unsupported radio needs — but writing waits for evidence.

Run an adversarial review before the first write to any new radio. Two of the four
drivers had a real defect found that way, before hardware.

## Interface

The design system is one file: `app/assets/css/main.css`. Tokens are CSS custom
properties, also exposed as Tailwind colours, with both themes first-class — radios
get programmed in dim rooms and in daylight. Read the file for current values rather
than hardcoding hexes.

**The risk register is the spine.** Every action belongs to exactly one level, and the
level decides icon, colour, button weight and what the confirmation costs:

| Level | Means | Confirmation |
|---|---|---|
| safe | Changes nothing on the radio | none, one click |
| caution | Changes the radio, recoverably | diff, then a typed token |
| destructive | Discards something with no way back | names what is lost, then a typed token |

`RiskAction` holds it so it cannot drift per screen. Colour is never the only
carrier — the icon and the verb change too.

Icons are `<UIcon name="i-lucide-…" />` and every name must be in `SCHEMA_ICONS` in
`nuxt.config.ts`. `fallbackToApi` is `false`, so an undeclared icon renders as
nothing at all, and a test enforces the list.

Fonts are self-hosted. The site has no external asset hosts, and radios get
programmed where there is no network.

## Writing

**Comments explain why, never what.** They carry reasons, hazards, provenance and
recorded failures — "this looked right until it was checked against X" is the most
valuable comment in the codebase. A comment restating the line below it is noise.
Prose wraps at 80 columns. Use a spaced hyphen, not an em-dash.

**Commit subjects** are an imperative sentence in sentence case, no prefix, no
trailing period. Bodies are paragraphs explaining why, not bullet lists of what
changed, and they end by naming what was verified with real numbers — or by saying
plainly what was not verified. Record your own wrong turns. No Claude attribution
and no `Co-Authored-By` trailers.

**Interface copy** is sentence case, never title case. The product is always
lowercase `boofwang`, even sentence-initially. **No em-dashes in `app/`** — use a
full stop, a comma, a colon, or a middot for field separators. British spelling in
prose, American in identifiers and CSS.

Errors state what happened, as facts. Never "failed to", never an apology. A
developer-facing error carries the actual bytes. Uncertainty is stated in the
product rather than hidden — but state it once, in the right place. A warning that
appears in four places is one nobody reads in any of them.

**Never claim more than is true.** Not in the UI, not in the README, not in a commit
message. The README once said CHIRP CSV could be read when nothing could read one,
and a driver list once said "verified" about a radio nobody had plugged in.

## Provenance

Derived from CHIRP (GPL-3.0, offsets transcribed and credited per file), the DM-32
Protocol Specification (MIT), and UV-K5 reverse-engineering notes (CC-BY-SA-4.0).
`docs/provenance.md` is the record.

**Nothing is taken from NeonPlug.** It has no LICENSE file, so all rights are
reserved. It may be read as a lead to verify against hardware. It may not be copied.

`reference/` is fetched, never redistributed, and git-ignored.

## Working here

Another agent or process may be working in this repository at the same time. Check
`git status` before staging, and **never `git add -A`** — it will sweep in someone
else's half-finished work and put it behind your commit message. Stage the paths you
touched.

Read the gate output. `pnpm vitest run | tail -3` prints timings, not the summary.
