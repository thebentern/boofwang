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
| [CHIRP](https://chirpmyradio.com/) ([kk7ds/chirp](https://github.com/kk7ds/chirp)) | GPL-3.0 | Memory layouts, protocol framing and field encodings for the Quansheng UV-K5 under both stock firmware (`chirp/drivers/uvk5.py`) and the egzumer custom firmware (`chirp/drivers/uvk5_egzumer.py`), and for the Baofeng UV-5R Mini (`chirp/drivers/baofeng_uv17Pro.py`); the CSV column model (`chirp/drivers/generic_csv.py`, `chirp/chirp_common.py`); the CTCSS/DTCS/tuning-step tables; and the stock channel configurations under `chirp/stock_configs/`. |
| [egzumer/uv-k5-firmware-custom](https://github.com/egzumer/uv-k5-firmware-custom) | Apache-2.0 | The firmware the `EGZUMER ` layout describes. No code is taken from it; boofwang's knowledge of its EEPROM comes from CHIRP's driver above. Listed because the layout is that project's design. |
| [infamy/DM32-Protocol-Spec](https://github.com/infamy/DM32-Protocol-Spec) | MIT | The entirety of what boofwang knows about the Baofeng DM-32UV: serial handshake, command set, the logical-block page map, record layouts and the encryption key slot format. There is no CHIRP driver for this radio; this specification is the only public documentation of it. |
| [sq5bpf/uvk5-reverse-engineering](https://github.com/sq5bpf/uvk5-reverse-engineering) | CC-BY-SA-4.0 | Jacek Lipkowski SQ5BPF's original analysis of the UV-K5: packet obfuscation table, CRC, command opcodes and the EEPROM map. |
| [eCFR](https://www.ecfr.gov/) — 47 CFR Part 95 | Public domain (US Government) | FRS, GMRS and MURS channel tables, power limits and bandwidth limits. |
| [FCC ULS bulk downloads](https://www.fcc.gov/wireless/data/public-access-files-database-downloads) | Public domain (17 U.S.C. §105) | Derived per-state public-safety frequency data. |
| [NOAA/NWS](https://www.weather.gov/nwr/) | Public domain (US Government) | Weather radio channel frequencies. |

Because CHIRP is GPL-3.0, files in `lib/radios/uvk5/` and `lib/radios/uv5rmini/`
that transcribe its layout tables are derivative works of CHIRP. That is
compatible with boofwang's own licence, and this table is the attribution.

## Deliberately not used

| Source | Why not |
|---|---|
| [NeonPlug](https://github.com/infamy/NeonPlug) | A browser-based CPS with overlapping goals, but the repository carries **no LICENSE file**, so all rights are reserved and none of its code may be copied. boofwang was written independently against the MIT-licensed protocol specification above. Verified 2026-08-18. |
| [RepeaterBook](https://www.repeaterbook.com/) | Its terms explicitly prohibit *"offline bundling, mirroring, redistribution"*, and its API requires a token that must not appear in browser JavaScript, sends no CORS headers, and requires a `User-Agent` a browser cannot set. No RepeaterBook data is bundled and none is fetched at runtime. Users import their own exports instead. |
| [RadioReference](https://www.radioreference.com/) | SOAP-only, no CORS, requires each end user's paid Premium credentials, and redistribution requires a paid commercial licence. |
| [myGMRS](https://mygmrs.com/) | No public API and no licence grant for its repeater database. |
| [hearham.com](https://hearham.com/) | Free to use in applications, but publishes no SPDX licence and sends no CORS headers. Would need written permission before bundling. |

## Local reference material

`scripts/fetch-reference.sh` downloads the upstream sources above into
`reference/`, which is git-ignored. They are consulted while transcribing
layouts; they are not redistributed as part of boofwang.

It also assembles `reference/chirp_pkg`, an importable `chirp` package, so that
a transcription can be checked against CHIRP's own parser rather than against a
second reading of the same source. Two scripts use it:
`scripts/crosscheck-chirp-csv.py` for the CSV export, and
`scripts/gen-egzumer-fixture.py`, which drives CHIRP's egzumer driver to build
`test/fixtures/images/uvk5-egzumer-synthetic.bin` and the JSON of what CHIRP
reads back out of it. **That fixture is synthetic, not a hardware capture** —
see [protocols/uvk5.md](protocols/uvk5.md).
