# SPDX-License-Identifier: GPL-3.0-or-later
"""
Dump every UV-5R-family settings field from an image, using CHIRP's own parser.

The point is not to read the bytes - boofwang can do that - but to have a second
opinion that came from somewhere else. `MEM_FORMAT` and the `bitwise` engine are
CHIRP's, so what comes out here is what CHIRP would show a user, and a decoder
that disagrees with it is wrong about a radio somebody owns.

Not run in CI: CI has no CHIRP checkout. The output is pinned as a fixture and
this script is how it is re-derived.

Usage:
    ./scripts/fetch-reference.sh                      # once
    python3 scripts/dump-uv5r-settings.py IMAGE.bin > fixture.json
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(HERE_FILE := __file__))
PKG = os.path.join(HERE, '..', 'reference', 'chirp_pkg')
REF = os.path.join(HERE, '..', 'reference')

if not os.path.isdir(os.path.join(PKG, 'chirp')):
    sys.exit("reference/chirp_pkg/chirp is missing. Run ./scripts/fetch-reference.sh first.")

sys.path.insert(0, PKG)
from chirp import bitwise  # noqa: E402


def mem_format():
    """CHIRP's own MEM_FORMAT string, lifted from uv5r.py without importing it."""
    src = open(os.path.join(REF, 'uv5r.py')).read()
    m = re.search(r'MEM_FORMAT\s*=\s*"""(.*?)"""', src, re.S)
    if not m:
        sys.exit("could not find MEM_FORMAT in reference/uv5r.py")
    # CHIRP leaves the power-on message offset as a runtime placeholder and
    # substitutes `_mem_params` in `process_mmap`. The UV-82 does not override
    # it, so the base class's value is the one that applies.
    m2 = re.search(r'_mem_params = \((0x[0-9A-Fa-f]+)', src)
    if not m2:
        sys.exit("could not find _mem_params in reference/uv5r.py")
    return m.group(1) % int(m2.group(1), 16)


def plain(value):
    """A bitwise value as JSON, without guessing at its meaning."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return str(value)


def main(path):
    data = open(path, 'rb').read()
    mem = bitwise.parse(mem_format(), data)

    out = {'bytes': len(data), 'source': os.path.basename(path)}

    for block in ('settings', 'wmchannel'):
        section = getattr(mem, block)
        fields = {}
        for name in sorted(set(re.findall(r'\b(\w+)\s*[;:]', str(section)))):
            try:
                fields[name] = plain(getattr(section, name))
            except AttributeError:
                continue
        out[block] = fields

    # The struct members bitwise exposes, taken from the struct itself rather
    # than a hand-written list, so a field nobody thought of still shows up.
    settings = mem.settings
    named = {}
    for name in dir(settings):
        if name.startswith('_'):
            continue
        try:
            named[name] = plain(getattr(settings, name))
        except Exception:
            continue
    out['settings_all'] = named

    for block in ('poweron_msg', 'sixpoweron_msg', 'firmware_msg'):
        try:
            section = getattr(mem, block)
            out[block] = {'line1': str(section.line1), 'line2': str(section.line2)}
        except AttributeError:
            pass

    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    print()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
