# SPDX-License-Identifier: GPL-3.0-or-later
"""
Verify a boofwang CSV export against CHIRP itself.

boofwang claims its CSV export is byte-identical to CHIRP's. That claim is only
worth making if it is checked against the real thing, so this loads an exported
file with `chirp.generic_csv.CSVRadio`, reports what CHIRP parsed, re-saves it
with CHIRP, and diffs the result against the input.

Not run in CI: CI has no CHIRP checkout. The expected output is pinned as a
golden string in test/lib/io/chirp-csv.spec.ts, and this script is how that
string is re-derived when the exporter changes.

Usage:
    ./scripts/fetch-reference.sh                       # once, to get CHIRP sources
    python3 scripts/crosscheck-chirp-csv.py FILE.csv
"""
import sys
import os
import difflib

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, '..', 'reference', 'chirp_pkg')

if not os.path.isdir(os.path.join(PKG, 'chirp')):
    sys.exit(
        "reference/chirp_pkg/chirp is missing.\n"
        "Run ./scripts/fetch-reference.sh first (it assembles an importable CHIRP package)."
    )

sys.path.insert(0, PKG)
from chirp import generic_csv  # noqa: E402


def main(path):
    radio = generic_csv.CSVRadio(None)
    radio.load(path)

    live = [m for m in radio.memories if not m.empty]
    print(f"CHIRP parsed {len(live)} channel(s) from {path}\n")
    hdr = (f"{'#':>3} {'name':<10} {'freq':>11} {'dup':<5} {'offset':>9} {'tmode':<7} "
           f"{'rtone':>6} {'ctone':>6} {'dtcs':>4} {'rx':>4} {'pol':<3} {'cross':<12} "
           f"{'mode':<4} {'step':>6} {'skip':<4} power")
    print(hdr)
    print('-' * len(hdr))
    for m in live:
        print(f"{m.number:>3} {m.name:<10} {m.freq:>11} {m.duplex or '':<5} {m.offset:>9} "
              f"{m.tmode or '':<7} {m.rtone:>6} {m.ctone:>6} {m.dtcs:>4} {m.rx_dtcs:>4} "
              f"{m.dtcs_polarity:<3} {m.cross_mode:<12} {m.mode:<4} {m.tuning_step:>6} "
              f"{m.skip or '':<4} {m.power}")

    out = path + '.chirp-reexport.csv'
    radio.save(out)

    with open(path, 'rb') as f:
        ours = f.read()
    with open(out, 'rb') as f:
        theirs = f.read()

    print()
    if ours == theirs:
        print("PASS: CHIRP re-exported this file byte for byte identically.")
        os.unlink(out)
        return 0

    print("FAIL: CHIRP's re-export differs from the input.")
    for line in difflib.unified_diff(
        ours.decode('utf-8', 'replace').splitlines(),
        theirs.decode('utf-8', 'replace').splitlines(),
        'boofwang', 'chirp', lineterm='', n=1,
    ):
        print(line)
    print(f"\nCHIRP's version was left at {out}")
    return 1


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    raise SystemExit(main(sys.argv[1]))
