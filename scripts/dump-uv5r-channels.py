# SPDX-License-Identifier: GPL-3.0-or-later
"""
Dump every programmed UV-5R-family channel from an image, using CHIRP's parser.

The companion to dump-uv5r-settings.py: the image goes through CHIRP's
`bitwise` engine with the MEM_FORMAT out of uv5r.py, and CHIRP's own empty
test, transmit-inhibit test, tone decoding and power table - transcribed from
`BaofengUV5R.get_memory` and `_is_txinh` - are applied. What comes out is what
CHIRP would show a user, and a decoder that disagrees with it is wrong about a
radio somebody owns.

Keys are boofwang channel indices (slot + 1). A transmit-inhibited channel
reports `tx` as 0, which is how the fixtures spell "transmits nowhere".

Not run in CI: CI has no CHIRP checkout. The output is pinned as
test/fixtures/<radio>-chirp-decode.json and this script is how it is
re-derived.

Usage:
    ./scripts/fetch-reference.sh                      # once
    python3 scripts/dump-uv5r-channels.py IMAGE.bin > fixture.json
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, '..', 'reference', 'chirp_pkg')
REF = os.path.join(HERE, '..', 'reference')

if not os.path.isdir(os.path.join(PKG, 'chirp')):
    sys.exit("reference/chirp_pkg/chirp is missing. Run ./scripts/fetch-reference.sh first.")

sys.path.insert(0, PKG)
from chirp import bitwise, chirp_common  # noqa: E402

# `UV5R_DTCS` in uv5r.py: the standard table plus 645, sorted, which shifts
# every index above it.
UV5R_DTCS = tuple(sorted(chirp_common.DTCS_CODES + (645,)))
assert len(UV5R_DTCS) == 105


def mem_format():
    """CHIRP's own MEM_FORMAT string, lifted from uv5r.py without importing it."""
    src = open(os.path.join(REF, 'uv5r.py')).read()
    m = re.search(r'MEM_FORMAT\s*=\s*"""(.*?)"""', src, re.S)
    if not m:
        sys.exit("could not find MEM_FORMAT in reference/uv5r.py")
    m2 = re.search(r'_mem_params = \((0x[0-9A-Fa-f]+)', src)
    if not m2:
        sys.exit("could not find _mem_params in reference/uv5r.py")
    return m.group(1) % int(m2.group(1), 16)


def tone(word):
    """One tone word, decoded the way get_memory does: none, CTCSS, or DTCS."""
    word = int(word)
    if word in (0, 0xFFFF):
        return None
    if word >= 0x0258:
        return {'kind': 'ctcss', 'deciHz': word}
    if word >= 0x6A:
        return {'kind': 'dtcs', 'code': UV5R_DTCS[word - 0x6A], 'polarity': 'R'}
    return {'kind': 'dtcs', 'code': UV5R_DTCS[word - 1], 'polarity': 'N'}


def main(path):
    data = open(path, 'rb').read()
    mem = bitwise.parse(mem_format(), data)

    out = {}
    for i in range(128):
        _mem = mem.memory[i]
        # CHIRP's empty test: the record's first byte alone. The rest of an
        # unused record is stale data, not 0xFF.
        if _mem.get_raw()[:1] == b'\xff':
            continue

        raw_tx = b''.join(_mem.txfreq[j].get_raw() for j in range(4))
        txinh = raw_tx == b'\xff\xff\xff\xff'

        name = ''
        for char in mem.names[i].name:
            c = str(char)
            name += ' ' if c == '\xff' else c
        name = name.rstrip()

        out[str(i + 1)] = {
            'name': name,
            'rx': int(_mem.rxfreq) * 10,
            'tx': 0 if txinh else int(_mem.txfreq) * 10,
            'bw': 25000 if int(_mem.wide) else 12500,
            # CHIRP indexes UV5R_POWER_LEVELS by the two-bit field and falls
            # back to High on an out-of-range value.
            'power': ['High', 'Low'][int(_mem.lowpower)] if int(_mem.lowpower) < 2 else 'High',
            'skip': 'none' if int(_mem.scan) else 'skip',
            'rxtone': tone(_mem.rxtone),
            'txtone': tone(_mem.txtone),
        }

    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write('\n')
    print(f"{len(out)} channels", file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
