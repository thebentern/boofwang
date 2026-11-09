<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Baofeng UV-9G - notes

The UV-9R's family behind its own magic. CHIRP's `UV9G` is a sibling subclass
of `WP970I` in `baofeng_wp970i.py` (GPL-3.0); the memory map, the protocol and
every rule are the [UV-9R's](uv9r.md), and this file records only what is
different. See [../provenance.md](../provenance.md).

**boofwang has never been connected to a UV-9G.** The decoder is checked
against CHIRP's own `UV9G` class on CHIRP's own UV-9G test image, which is the
committed fixture. Writing is enabled on the same terms as the UV-9R's, which
[uv9r.md](uv9r.md) sets out - CHIRP's maintainer reports uploading a UV-9G
too - and every item on that file's "Not verified" list applies here.

## What differs from the UV-9R

- **The magic** is `MSTRING_UV9G`, `50 BB FF 20 12 05 25`: one byte from the
  Radioddity UV-5G's `50 BB FF 20 12 06 25`, and a different family. The
  connect screen's choice is what picks which magic is sent.
- **The ident** in CHIRP's capture is `aa 44 46 04 00 04 70 dd` - the UV-5G
  bench unit's, byte for byte. That UV-5G refuses the first magic after it has
  sat idle, every time, so a UV-9G may well do the same; the family's
  `identify` already tries each magic three times.
- **The power table** is CHIRP's `UV9G` one: High 5 W, Med 1 W, Low 0.5 W, on
  the same two-bit selector.
- **The band plan is GMRS**, in the order `bandFor` searches: the 462 and
  467 MHz transmit windows first, then CHIRP's `VALID_BANDS` - 130-180 and
  400-521 MHz - as receive-only spans. Transmitting outside the windows draws
  the regulatory warning and never an error.

That last one is the license's rule and is labeled as such, because it is not
the radio's. CHIRP's `UV9G` sets `_gmrs = False` with the comment "sold as GMRS
radio but supports full band TX/RX", and the capture's band limits are
136-174 and 400-520 MHz, both enabled. The Radioddity UV-5G's GMRS plan rests on
a firmware that is sold as refusing to transmit outside GMRS; nothing here
rests on that. CHIRP's `get_memory` does carry GMRS rules for a UV-9G - thirty
fixed channels, interstitials forced narrow and low - but they run only when
`_gmrs` is true, so they apply neither in CHIRP nor here.

## CHIRP's capture

| | |
|---|---|
| File | `tests/images/Baofeng_UV-9G.img` in kk7ds/chirp, less its metadata trailer |
| Image | 8,200 bytes: 0x2000 memory, then the 8 ident bytes |
| sha256 | `a0dce8c1a129e80644dde542489ebc9da6f95b01f7c1e0cebafde520dd1f2c30` |
| Ident | `aa 44 46 04 00 04 70 dd` |
| Firmware window | `???????`, then 0xFF |
| 6+power-on message | `180122N` |
| Power-on message | `BAOFENG` / ` UV-9G ` |
| Metadata | `rclass: DynamicRadioAlias`, `model: UV-9G`, `chirp_version: 0.3.0dev` |

The factory codeplug, 65 channels: GMRS 1-22 simplex, REPTR 1-8 as +5 MHz
shifts into the 467 MHz window, DIY 1-24 - the eight repeater pairs again,
three times over - and NOAA 1-11 receive-only with `FF FF FF FF` in the
transmit frequency. All 65 agree with CHIRP field for field, all 50 settings
fields agree, and the image round-trips byte for byte.

Two details worth keeping:

- **The interstitials ship on the middle selector.** GMRS 8-14 are narrow and
  stored with power selector 1, which CHIRP calls 1 W on this radio. Part 95
  allows 0.5 W on those channels. Only the selector is stored and nothing here
  can measure the radio's output, so the label is CHIRP's and the discrepancy is
  recorded rather than resolved.
- **A bare `.bin` of this radio opens as a UV-9R.** Both are 8,200 bytes, so the
  size cannot separate them, and the UV-9R is the one `RAW_LAYOUTS` lists. A
  `.bwp` or a CHIRP `.img` carries the identity: metadata naming the `UV9G`
  class, or `DynamicRadioAlias` with the model `UV-9G` as CHIRP's own file has,
  opens as a UV-9G.

## Not verified

Everything on [the UV-9R's list](uv9r.md#not-verified), and:

- Whether this radio's firmware refuses to transmit outside GMRS. CHIRP says it
  does not.
- What the middle selector puts out on the 467 MHz interstitials.
- Whether the first contact after idle is refused, as the UV-5G's is.

The bench sessions are `test/hardware/uv9g.spec.ts`, run the way
[uv9r.md](uv9r.md#the-bench-session-that-would-settle-it) describes.
