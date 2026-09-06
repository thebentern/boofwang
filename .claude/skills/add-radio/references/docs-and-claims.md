# Documentation, provenance and not overclaiming

Never claim more than is true. Not in the UI, not in the README, not in a commit
message. The README once said CHIRP CSV could be read when nothing could read
one, and a driver list once said "verified" about a radio nobody had plugged in.

## `docs/protocols/<id>.md`

One per radio. Opens with an SPDX comment, then a title, then where the offsets
came from and a link to `../provenance.md`.

```markdown
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Radioddity UV-5G - notes

Offsets transcribed from CHIRP's `uv5r.py` (GPL-3.0). See
[../provenance.md](../provenance.md). The memory map, block protocol and every
quirk are the [UV-82's](uv82.md); this file records only what is different and
what was verified on this radio.
```

Sections, from the real files. Not all apply, and add whatever your radio makes
you learn.

**Which radio this actually is.** If the name is ambiguous, this goes first. The
UV-5G's opens with a table of the four radios sold under that name across two
incompatible protocols, and states that the name cannot decide but the ident
magic can.

**Verified read, `<date>`.** A table: radio and firmware, ident bytes, adapter
and line settings, image size with its composition, baseline sha256. Then prose
saying how many reads agreed, and that an independent reader outside the app
produced the same hash.

**What differs from `<sibling>`,** when the driver is shared.

**Verified write session, `<date>`.** What was changed, how many blocks were
sent, what an independent read showed moved and at which addresses, and the
restore back to the baseline sha256.

**Quirks.** Anything the radio did that the reference does not describe.
Recorded so the next person does not hunt for a bug that is not there. The
UV-5G's records that first contact after idle is refused with `0xfe`, and that
one read in three stalled mid-block and succeeded on retry.

**Not verified.** Required. Every protocol doc has one. Say what was not
exercised and, where you can, what would settle it. The DM-32UV's says plainly
why one block stays unrun.

Record your wrong turns. "This looked right until it was checked against X" is
the most valuable sentence in the file.

## `docs/provenance.md`

Add a row to the upstream sources table: source, license, and specifically what
is taken from it. Then update the sentence naming which `lib/radios/` directories
are derivative works of which source - it lists them explicitly.

Credit the source in a comment in every file that carries transcribed offsets,
not just in this table. `reference/` is fetched, never redistributed, and
git-ignored.

**Nothing is taken from NeonPlug.** It has no LICENSE file, so all rights are
reserved. It may be read as a lead to verify against hardware. It may not be
copied.

## README

One row in the radio table:

```
| Radioddity UV-5G | 128 channels, analog GMRS, 6 KB image | Yes | Yes | Read, write, restore |
```

The last column is a factual list of what has been done on hardware, not a
grade. "Read" alone is the honest entry until a write has happened.

## The schema `status` field

`'planned'` before there is a driver, `'read-only'` until a write has been
verified on hardware, `'beta'` once it has, `'stable'` once it has been
exercised broadly. The base schema declares `read-only`; the driver factory
overrides it to `beta` when the registry passes `enableWrite: true`.

## Interface copy

Sentence case, never title case. The product is always lowercase `boofwang`,
even sentence-initially. No em-dashes anywhere in `app/` - use a full stop, a
comma, a colon, or a middot for field separators. American spelling throughout,
in prose, identifiers and CSS: it is a license, a color code, and you program a
radio.

Errors state what happened, as facts. Never "failed to", never an apology.
Uncertainty is stated in the product rather than hidden, but state it once, in
the right place. A warning that appears in four places is one nobody reads in
any of them.

## Comments

Comments explain why, never what. They carry reasons, hazards, provenance and
recorded failures. A comment restating the line below it is noise. Prose wraps
at 80 columns. Use a spaced hyphen, not an em-dash.

## The commit

Subject: an imperative sentence in sentence case, no prefix, no trailing period.

Body: paragraphs explaining why, not bullet lists of what changed. Record your
own wrong turns. End by naming what was verified with real numbers - or by
saying plainly what was not verified.

The UV-5G commit is the model. Read it in full:

```bash
git show 6b1fb42
```

No Claude attribution and no `Co-Authored-By` trailers in this repository.
