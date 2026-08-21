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
  chirp/drivers/uvk5_egzumer.py \
  chirp/drivers/baofeng_uv17Pro.py \
  chirp/drivers/baofeng_common.py \
  chirp/drivers/generic_csv.py \
  chirp/chirp_common.py \
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

# Assemble an importable `chirp` package so the cross-check scripts can load
# CHIRP's real drivers and compare our output against them:
#   scripts/crosscheck-chirp-csv.py   needs generic_csv
#   scripts/gen-egzumer-fixture.py    needs the whole uvk5_egzumer driver, which
#                                     is why settings.py, checksum.py and a
#                                     chirp.drivers package are pulled in too.
echo "Assembling an importable chirp package ..."
mkdir -p chirp_pkg/chirp/drivers
for f in bitwise.py bitwise_grammar.py pyPEG.py chirp_common.py generic_csv.py uvk5.py; do
  [ -f "$f" ] && cp "$f" chirp_pkg/chirp/
done
for f in memmap.py util.py errors.py directory.py platform.py settings.py checksum.py \
         bitwise_grammar.py pyPEG.py; do
  curl -sSLf "$CHIRP_RAW/chirp/$f" -o "chirp_pkg/chirp/$f" 2>/dev/null || true
done
for f in uvk5.py uvk5_egzumer.py; do
  [ -f "$f" ] && cp "$f" chirp_pkg/chirp/drivers/
done
: > chirp_pkg/chirp/drivers/__init__.py
printf 'CHIRP_VERSION = "boofwang-crosscheck"\n' > chirp_pkg/chirp/__init__.py
echo "  chirp_pkg/chirp ($(ls chirp_pkg/chirp | wc -l | tr -d ' ') modules)"

echo
echo "Done. reference/ is git-ignored; see docs/provenance.md for licensing."
