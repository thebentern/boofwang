# boofwang

A browser-based CPS for two-way radios: read a radio's codeplug over Web Serial or
Web Bluetooth, edit it, write it back. Nuxt 4 + Vue 3 + Tailwind 4 + Nuxt UI v4,
`ssr: false`, static on GitHub Pages at boofwa.ng. GPL-3.0-or-later.

The radios are whatever `lib/radio/registry.ts` registers - read `RADIO_IDS`
rather than a count written here. Today: Quansheng UV-K5, Baofeng UV-82,
Radioddity UV-5G, Baofeng UV-5R, Baofeng UV-5R Mini, Baofeng DM-32UV. Which of
them can be written, and what has been verified against hardware, is the
README's radio table. This line said "Four radios" long after the UV-5G was
registered, and `docs/play.md` records what that cost: a Play Store listing
submitted with the UV-5G missing, because this line was believed over the
registry.

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

**`ownedRanges()` is a claim, and the gate checks it.** It returns the byte ranges
a driver says it understands. A change landing outside them is a *blocker*, not a
warning — `diffImages` collects them into `ImageDiff.unowned` and the gate raises
`unowned-bytes-changed`, whose message says "That is a defect in boofwang, not in
your codeplug." Never widen `ownedRanges` to silence that. It is telling you the
encoder is wrong.

The other direction - a range claimed and not actually understood - is the silent
one, because nothing fails. Only the DM-32UV audits it
(`test/lib/radios/dm32uv/write-audit.spec.ts`). A new radio should.

**A write is never one click from idle.** Backup, then diff, then a typed
confirmation. `writeImage` throws `BackupRequiredError` when there is no backup or
it belongs to another radio. Where a driver can fingerprint the physical unit it
must — the DM-32UV compares the calibration block, because `identHash` covers only
model, firmware and build date and two identical radios are indistinguishable by it.

**Every block written is read back and compared before the write is called done,
and the read-back uses the block size the *read* path uses.** An acknowledgement
says a frame arrived, not that it landed where it was meant to. Not all of these
drivers verify between blocks - the UV-5R family and the UV-5R Mini send
everything and then verify, so the guarantee is the read-back and not the
ordering. And a read-back can lie: a UV-5R asked for sixteen bytes returns
another block's while echoing the address it was given, which the header check
for a slipped block cannot see.

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

The order matters, and it is radio-first rather than reference-first. Two of
these steps were once written in the wrong order, and both mistakes cost a
session.

1. **Probe before you transcribe.** The name on the box does not pick the
   reference class: four radios answer to "UV-5G" across two incompatible
   protocols, and that radio's first artefact was a probe rather than a driver -
   the bench unit ignored every UV-17 Pro ident and acknowledged the classic
   magic, which is what chose the driver. Transcribing from the wrong class
   yields something internally consistent that passes its own tests. Settle two
   more things here, because each shapes everything after it: how the radio
   leaves programming mode - the DM-32UV has no exit command and leaves only
   when the port closes - and whether its addresses are physical at all, since
   the DM-32UV's are logical page ids behind a translation layer that moves
   between sessions.
2. **Transcribe** the offsets, crediting the source in a comment, and add the
   radio to `docs/provenance.md` in the same change: the layout is someone
   else's licensed work and naming it is an obligation, not a courtesy. Never
   guess a field name for a byte nobody has explained; carry it through
   undecoded instead. A reference calling a block "allocated, never touched" is
   not evidence that it is empty. CHIRP `#seekto` values are image offsets, not
   radio addresses.
3. **Cross-check against the reference implementation's own parser**, not
   against a second reading of the same document, and **commit the result as a
   fixture**. `reference/` is git-ignored and CI has no CHIRP checkout, so a
   cross-check that is run and not committed dies with the session. Compare the
   reference's *predicates*, not only its tables - CHIRP matches basetypes by
   containment rather than prefix, and reading that as a prefix makes a real
   radio unrecognised. Where there is no parser to import, say so in the
   protocol note and lean harder on hardware: CHIRP has no DM-32UV driver. This
   step caught the UV-K5's 10 Hz scaling, the UV-82's inverted `wide` bit, the
   UV-5R Mini's 105-code DTCS table and the DM-32UV's BCD tones - every one of
   which looked correct until it was checked.
4. **Read it on hardware**, and record the session in
   `docs/protocols/<radio>.md`: exact byte counts on the wire, two reads that
   agree byte for byte, and the reads that *failed* as well as the ones that
   agreed. Rule out the plug and the driver picker before concluding anything
   about firmware - a connector not fully seated has presented as a protocol
   fault more than once. Name the carrier and the shell: a cable read in desktop
   Chrome verifies a cable in desktop Chrome. An independent reader outside the
   app is the strongest form of this, and is not always available.
5. **Give the UI its verbs before the write session.** A session can only
   exercise the paths the interface can reach, and the UV-5R Mini's
   erased-flash clearing path stayed unverified on hardware until a create verb
   existed to reach it. Editing an existing channel is the safest path and the
   least informative; create and delete run the code that damages radios. The
   radio should appear in the connect chooser with the right capability markers,
   be selectable, and reach the channel table and settings form, at no cost
   under `app/`. If it does cost one the `RadioSchema` is usually missing
   something, but not always - check rather than assume. Read the connect screen
   in both themes.
6. **Write it on hardware, and expect the session to discover the write shape.**
   A diff-driven write is this codebase's default and it is not universal. The
   UV-5R Mini erases a flash page and writes back only the block it was handed,
   so a sparse write wipes its neighbours. The UV-5R is the opposite: a byte
   programs once and will not reprogram, so a sparse write cannot shorten a name
   and leaves the tail of the old one behind. Both need `writesWholeImage`, and
   both were found by writing, which is why this cannot be settled beforehand.
   What the reference sends is the best prior: CHIRP writes contiguous ranges,
   never a diff.

   Save the pre-write image to a file first. Then edit one field - a real
   change, not a rename to the name the slot already holds - write, read back in
   a *fresh session*, confirm only the intended bytes moved, restore **with no
   base image** so the recovery path is the one exercised, and confirm the
   original sha256. A write that was acknowledged is not a write that landed, a
   read-back inside the writing session is not a fresh read, and a read-back at
   the wrong block size is not a read-back at all.
7. **Commit that session as a runnable spec**, gated behind its own flag so a
   habitual read run never turns into a write, and forcing nothing: build the
   driver the registry builds and assert it is already willing. A spec that
   forces `caps.write` proves the wire works and says nothing about whether the
   product ever gets there.
8. **Enable writing in the registry, not in the schema.** Every schema ships
   read-only and the registry line is what turns writing on, which is the seam
   that stops a driver built for a test or a file import from reaching a radio.
   Writing is not one switch: it is per carrier - `writeTransports`, and
   omitting it means *every* carrier in `transports` - and per firmware variant.
   Reading is still offered for firmware nobody recognises, because a backup is
   exactly what an unsupported radio needs, but "the driver is shared with a
   radio that works" is not evidence, and neither is "the cable works" for
   Bluetooth. Two radios in this family share every byte of their memory map and
   disagree about whether a byte can be rewritten. Where a firmware string is
   ambiguous, settle it against the radio's own bytes rather than the string:
   `writeImage` refuses when `encode(decode(live), live)` moves a byte, which
   catches a tri-power radio reporting a two-power name.
9. **Commit the capture, scanned.** Scan for identity, not only for keys:
   channel names, the power-on message, DTMF and ANI codes. Diffing a suspicious
   region against a capture already public is the cheapest way to tell a factory
   default from somebody's identity. Then say which decode paths the capture
   does *not* reach - a factory-fresh radio cannot exercise receive-only
   markers, which is why the UV-5R keeps the UV-5G's capture beside its own.
10. **Sweep for the claims the new radio falsifies**, because enabling a write
    turns sentences false all over the tree. `RADIO_IDS` is the roster and
    everything else is a copy of it: the README radio table, the install prompt
    in `public/manifest.webmanifest`, `docs/provenance.md`, and the lists no
    schema derives - `BLUETOOTH_RADIOS` and `DONGLE_RADIOS` in
    `transports.spec.ts`, the images and cases in `settings-schema.spec.ts`, the
    read-only expectation in `ui-features.spec.ts`, `RadioId`, `CHIRP_IDENTITY`
    and the raw-layout tables. A Play Store listing shipped with the UV-5G
    missing because a count in this file was believed over the registry, and the
    install prompt lost the UV-5R the same way one radio later.

Run an adversarial review before hardware, not only before the first write. Its
best catches have been read defects and fail-open classifiers, which a write
session is too late to find. Every driver reviewed that way has had a real
defect found in it.

A radio is not "added" until these exist: a driver and one registry line, a
committed capture with its cross-check fixture, a hardware spec that can be
re-run, a `docs/protocols/<radio>.md` carrying both a dated verified session and
an explicit list of what was *not* established, and the sweep in step 10. The
gate stays green for a radio missing every one of those, so nothing but this
list will tell you. Half of it - reading verified, writing assumed, the UI never
opened - is how a driver list comes to say "verified" about something nobody has
written to.

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
