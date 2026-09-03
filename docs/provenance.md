# Provenance and licensing

boofwang is licensed under the **GNU General Public License, version 3 or later**
(`GPL-3.0-or-later`). Every source file we author carries an SPDX identifier,
enforced in CI by `scripts/check-headers.mjs`.

This file records where boofwang's knowledge of each radio comes from, because
a lot of it is derived from other people's work and the GPL obliges anyone
redistributing this code to be able to trace that.

## Upstream sources we derive from

| Source | Licence | What we take from it |
|---|---|---|
| [CHIRP](https://chirpmyradio.com/) ([kk7ds/chirp](https://github.com/kk7ds/chirp)) | GPL-3.0 | Memory layouts, protocol framing and field encodings for the Quansheng UV-K5 under both stock firmware (`chirp/drivers/uvk5.py`) and the egzumer custom firmware (`chirp/drivers/uvk5_egzumer.py`), for the Baofeng UV-5R Mini (`chirp/drivers/baofeng_uv17Pro.py`) and for the Baofeng UV-82 and Radioddity UV-5G (`chirp/drivers/uv5r.py`, which serves the whole UV-5R family); the CSV column model (`chirp/drivers/generic_csv.py`, `chirp/chirp_common.py`); the CTCSS/DTCS/tuning-step tables; and the stock channel configurations under `chirp/stock_configs/`. |
| [egzumer/uv-k5-firmware-custom](https://github.com/egzumer/uv-k5-firmware-custom) | Apache-2.0 | The firmware the `EGZUMER ` layout describes. No code is taken from it; boofwang's knowledge of its EEPROM comes from CHIRP's driver above. Listed because the layout is that project's design. |
| [infamy/DM32-Protocol-Spec](https://github.com/infamy/DM32-Protocol-Spec) | MIT | The entirety of what boofwang knows about the Baofeng DM-32UV: serial handshake, command set, the logical-block page map, record layouts and the encryption key slot format. There is no CHIRP driver for this radio; this specification is the only public documentation of it. |
| [sq5bpf/uvk5-reverse-engineering](https://github.com/sq5bpf/uvk5-reverse-engineering) | CC-BY-SA-4.0 | Jacek Lipkowski SQ5BPF's original analysis of the UV-K5: packet obfuscation table, CRC, command opcodes and the EEPROM map. |
| [eCFR](https://www.ecfr.gov/) — 47 CFR Part 95 | Public domain (US Government) | FRS, GMRS and MURS channel tables, power limits and bandwidth limits. |
| [NOAA/NWS](https://www.weather.gov/nwr/) | Public domain (US Government) | Weather radio channel frequencies. |

Because CHIRP is GPL-3.0, files in `lib/radios/uvk5/`, `lib/radios/uv82/`,
`lib/radios/uv5g/` and `lib/radios/uv5rmini/` that transcribe its layout tables
are derivative works of CHIRP. That is compatible with boofwang's own licence,
and this table is the attribution.

## Fetched at runtime, never bundled

boofwang can query these directories when the user asks it to. Nothing from them
is committed to this repository, nothing is cached beyond the browser session,
and every channel staged from one carries its source's attribution, which the
presets screen shows above the channel table.

`enabled` in `lib/data/registry.ts` is the off switch. A publisher who asks us
to stop is one line, not a refactor.

| Source | Reachable from | What it says about reuse | Verified |
|---|---|---|---|
| [BrandMeister](https://brandmeister.network/) | the browser - its API reflects the requesting origin | Publishes no data licence. The API is open and needs no account. | 2026-08-22: 1,833 talk groups and 33,167 repeaters, fetched from a browser page with no CORS error |
| [hearham](https://hearham.com/) | the desktop shell only - sends no CORS headers | **Publishes no data licence.** Its `/terms` is a privacy policy. Widely described elsewhere as free to use in applications, but the site itself has never said so. Used on that understanding, with credit, pending an answer from its owner. | 2026-08-22: 22,635 repeaters; no `Access-Control-Allow-Origin` on any response |
| [RadioID](https://radioid.net/) | the desktop shell only - sends no CORS headers | Lookups permitted. Mirroring, republishing, bulk export and competing directories need written permission. boofwang queries by callsign only and has no code path that walks the database. | 2026-08-22: per-callsign lookups answered without authentication |

The hearham row is a judgement call and is recorded as one. If its owner
objects, set `enabled: false` and the source disappears from both the reachable
and the unreachable list - withdrawn is not the same as unreachable, and nobody
should be told to install an app to reach something we have stopped offering.

## Deliberately not used

| Source | Why not |
|---|---|
| [NeonPlug](https://github.com/infamy/NeonPlug) | A browser-based CPS with overlapping goals, but the repository carries **no LICENSE file**, so all rights are reserved and none of its code may be copied. boofwang was written independently against the MIT-licensed protocol specification above. Verified 2026-08-18. |
| [RepeaterBook](https://www.repeaterbook.com/) | Its terms explicitly prohibit *"offline bundling, mirroring, redistribution"*, and its API requires a token that must not appear in browser JavaScript, sends no CORS headers, and requires a `User-Agent` a browser cannot set. No RepeaterBook data is bundled and none is fetched at runtime. Users import their own exports instead. |
| [RadioReference](https://www.radioreference.com/) | SOAP-only, no CORS, requires each end user's paid Premium credentials, and redistribution requires a paid commercial licence. |
| [myGMRS](https://mygmrs.com/) | No public API and no licence grant for its repeater database. |

## Local reference material

`scripts/fetch-reference.sh` downloads the upstream sources above into
`reference/`, which is git-ignored. They are consulted while transcribing
layouts; they are not redistributed as part of boofwang.

It also assembles `reference/chirp_pkg`, an importable `chirp` package, so that
a transcription can be checked against CHIRP's own parser rather than against a
second reading of the same source. The scripts that use it:
`scripts/crosscheck-chirp-csv.py` for the CSV export,
`scripts/dump-uv5r-settings.py` and `scripts/dump-uv5r-channels.py` for the
UV-5R-family fixtures, and
`scripts/gen-egzumer-fixture.py`, which drives CHIRP's egzumer driver to build
`test/fixtures/images/uvk5-egzumer-synthetic.bin` and the JSON of what CHIRP
reads back out of it. **That fixture is synthetic, not a hardware capture** —
see [protocols/uvk5.md](protocols/uvk5.md).

## Assets, and the licences that travel with them

Code provenance is above. These are the non-code things the build ships, which
had no entry here at all.

| Asset | Licence | What it asks |
|---|---|---|
| lucide icons | ISC | Retain the copyright notice. Bundled into the client for the names in `SCHEMA_ICONS`. |
| IBM Plex Sans, IBM Plex Mono | SIL Open Font License 1.1 | Self-hosted via `@fontsource`, shipped unmodified, name unchanged. |
| The boofwang icon | GPL-3.0-or-later, with the rest of this repository | Nothing. It is original work in the app's own palette, from no icon set and no vendor mark. |

The icon is worth stating plainly because it is the one asset somebody might
assume was borrowed. It was not, so no fair-use question arises - that doctrine
is for using someone else's work, and there is none here.

### Trademarks in the install prompt

`public/manifest.webmanifest` names five radio manufacturers in the description
a phone shows at install. Naming a radio to say what the software programs is
nominative use and is the defensible use, but the README's disclaimer was not
travelling with it: the manifest is often the only text a person reads before
installing. It now carries the same sentence, and the radio list matches the
drivers that ship, which it did not - the Radioddity UV-5G was missing.
