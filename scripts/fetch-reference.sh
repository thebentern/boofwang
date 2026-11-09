#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Fetch the upstream sources boofwang's radio layouts are transcribed from, into
# the git-ignored reference/ directory. See docs/provenance.md.
#
# These are consulted while porting a driver; they are not redistributed here.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p reference
cd reference

CHIRP_RAW="https://raw.githubusercontent.com/kk7ds/chirp/master"

echo "Fetching CHIRP sources (GPL-3.0) ..."
for f in \
  chirp/drivers/uvk5.py \
  chirp/drivers/uv5r.py \
  chirp/drivers/uvk5_egzumer.py \
  chirp/drivers/baofeng_uv17Pro.py \
  chirp/drivers/baofeng_common.py \
  chirp/drivers/baofeng_wp970i.py \
  chirp/drivers/generic_csv.py \
  chirp/share/model_alias_map.yaml \
  chirp/chirp_common.py \
  chirp/import_logic.py \
  chirp/bitwise.py
do
  curl -sSLf "$CHIRP_RAW/$f" -o "$(basename "$f")" && echo "  $(basename "$f")"
done

echo "Fetching DM-32UV protocol specification (MIT) ..."
mkdir -p dm32
for f in 01-OVERVIEW 02-CONNECTION-SEQUENCE 03-COMMANDS 04-MEMORY-LAYOUT \
         05-DATA-STRUCTURES 06-ENCODING 07-BLOCK-INVENTORY
do
  curl -sSLf "https://raw.githubusercontent.com/infamy/DM32-Protocol-Spec/main/$f.md" \
    -o "dm32/$f.md" 2>/dev/null && echo "  dm32/$f.md" || echo "  (skipped $f.md)"
done
curl -sSLf "https://raw.githubusercontent.com/infamy/DM32-Protocol-Spec/main/LICENSE" -o dm32/LICENSE 2>/dev/null || true

# CHIRP's own test images for the WP970I family. Its test suite opens these
# with the real driver classes, which makes them the one capture of this memory
# format that is published under a license boofwang can redistribute - see
# docs/protocols/uv9r.md for which of them is committed as a fixture and why.
echo "Fetching CHIRP test images (GPL-3.0) ..."
mkdir -p chirp-images
for f in Baofeng_UV-9G.img Baofeng_BF-A58S.img; do
  curl -sSLf "$CHIRP_RAW/tests/images/$f" -o "chirp-images/$f" && echo "  chirp-images/$f"
done

# The only real UV-9R captures anyone has published: attached to CHIRP's
# tracker by the people who own the radios (issues 4511 and 9932). They are
# their uploaders' and not this project's to redistribute, so they are fetched
# for a local cross-check and never committed.
# test/lib/radios/uv9r/reference-captures.spec.ts runs against them when they
# are here and skips when they are not.
echo "Fetching UV-9R captures from CHIRP's issue tracker (not redistributed) ..."
mkdir -p chirp-tickets
CHIRP_ATTACH="https://chirpmyradio.com/attachments/download"
curl -sSLf "$CHIRP_ATTACH/3275/Baofeng_UV-9R_20170301.img" -o chirp-tickets/Baofeng_UV-9R_20170301.img \
  && echo "  chirp-tickets/Baofeng_UV-9R_20170301.img" || echo "  (skipped Baofeng_UV-9R_20170301.img)"
curl -sSLf "$CHIRP_ATTACH/7961/Baofeng_UV-9R%20Pro_Factory%20Image.img" -o chirp-tickets/Baofeng_UV-9R_Pro_Factory.img \
  && echo "  chirp-tickets/Baofeng_UV-9R_Pro_Factory.img" || echo "  (skipped Baofeng_UV-9R_Pro_Factory.img)"

# Assemble an importable `chirp` package so the cross-check scripts can load
# CHIRP's real drivers and compare our output against them:
#   scripts/crosscheck-chirp-csv.py   needs generic_csv
#   scripts/gen-egzumer-fixture.py    needs the whole uvk5_egzumer driver, which
#                                     is why settings.py, checksum.py and a
#                                     chirp.drivers package are pulled in too.
#   scripts/dump-wp970i-family.py     needs baofeng_wp970i and baofeng_common,
#                                     and baofeng_common imports the North
#                                     American band plan at module load.
echo "Assembling an importable chirp package ..."
mkdir -p chirp_pkg/chirp/drivers
for f in bitwise.py bitwise_grammar.py pyPEG.py chirp_common.py generic_csv.py uvk5.py uv5r.py; do
  [ -f "$f" ] && cp "$f" chirp_pkg/chirp/
done
for f in memmap.py util.py errors.py directory.py platform.py settings.py checksum.py \
         bitwise_grammar.py pyPEG.py bandplan.py bandplan_na.py bandplan_iaru_r2.py; do
  curl -sSLf "$CHIRP_RAW/chirp/$f" -o "chirp_pkg/chirp/$f" 2>/dev/null || true
done
for f in uvk5.py uvk5_egzumer.py uv5r.py baofeng_common.py baofeng_wp970i.py; do
  [ -f "$f" ] && cp "$f" chirp_pkg/chirp/drivers/
done
: > chirp_pkg/chirp/drivers/__init__.py
printf 'CHIRP_VERSION = "boofwang-crosscheck"\n' > chirp_pkg/chirp/__init__.py
echo "  chirp_pkg/chirp ($(ls chirp_pkg/chirp | wc -l | tr -d ' ') modules)"

echo
echo "Done. reference/ is git-ignored; see docs/provenance.md for licensing."
