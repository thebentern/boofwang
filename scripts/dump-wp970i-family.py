# SPDX-License-Identifier: GPL-3.0-or-later
"""
Dump a WP970I-family image the way CHIRP's own driver reads it.

The UV-5R-family scripts lift MEM_FORMAT out of uv5r.py and re-apply CHIRP's
tests by hand. This one goes a step further, because it can: it imports
`chirp.drivers.baofeng_wp970i`, builds the real driver class - UV9R, UV9G or
any sibling - over the image, and asks it. `get_memory` decides emptiness,
transmit inhibit, shift against split, tone modes and power; `get_settings`
decides what the settings mean; and the settings struct is read through the
driver's own parsed memory object. None of it was written by boofwang, which
is the point: a decoder that disagrees with this output is wrong about a radio
somebody owns.

Three outputs, selected by the first argument:

    decode       channels, keyed by boofwang index (slot + 1), with each
                 side's tone reconstructed from CHIRP's tmode, cross mode and
                 polarity.
    settings     the settings struct as CHIRP's bitwise engine reads it, the
                 power-on message, and every value get_settings presents.
    decode-many  channels and settings struct for several images, keyed by
                 file name, each with the sha256 of its memory - for captures
                 that may be checked against but not committed.

Not run in CI: CI has no CHIRP checkout. Outputs are committed as fixtures
and this script is how they are re-derived.

Usage:
    ./scripts/fetch-reference.sh                                   # once
    python3 scripts/dump-wp970i-family.py decode UV9G IMAGE > fixture.json
    python3 scripts/dump-wp970i-family.py settings UV9G IMAGE > fixture.json
    python3 scripts/dump-wp970i-family.py decode-many UV9R \\
        reference/chirp-tickets/*.img reference/chirp-images/Baofeng_BF-A58S.img \\
        > test/fixtures/uv9r-reference-chirp-decode.json

IMAGE may be a CHIRP .img (the metadata trailer is dropped), a bare 0x2008
image, or the 0x2010 image older CHIRP builds saved with the model name
appended after the ident.
"""
import builtins
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, '..', 'reference', 'chirp_pkg')

if not os.path.isfile(os.path.join(PKG, 'chirp', 'drivers', 'baofeng_wp970i.py')):
    sys.exit("reference/chirp_pkg/chirp/drivers/baofeng_wp970i.py is missing. Run ./scripts/fetch-reference.sh first.")

sys.path.insert(0, PKG)
# CHIRP's modules use gettext's `_` as a builtin, which its application entry
# point installs. Nothing here translates anything, so identity will do.
builtins._ = lambda s: s

from chirp import memmap  # noqa: E402
from chirp.drivers import baofeng_wp970i as W  # noqa: E402

CHIRP_MAGIC = b'\x00\xffchirp\xeeimg\x00\x01'
MEM_SIZE = 0x2000
IMAGE_SIZE = MEM_SIZE + 8


def load_image(path):
    data = open(path, 'rb').read()
    at = data.rfind(CHIRP_MAGIC)
    mem = data if at < 0 else data[:at]
    if len(mem) == MEM_SIZE + 16:
        # Older CHIRP appended the model name after the ident when the radio's
        # firmware window was blank. It is not radio memory.
        mem = mem[:IMAGE_SIZE]
    if len(mem) != IMAGE_SIZE:
        sys.exit(f"{path}: {len(mem)} bytes of memory, expected {IMAGE_SIZE}")
    return mem


def radio_for(cls_name, mem):
    cls = getattr(W, cls_name)
    r = cls(None)
    r._mmap = memmap.MemoryMapBytes(bytes(mem))
    r.process_mmap()
    return r


def tone_sides(m):
    """Each side's tone, rebuilt from what get_memory reported."""
    def ctcss(hz):
        return {'kind': 'ctcss', 'deciHz': int(round(hz * 10))}

    def dtcs(code, pol):
        return {'kind': 'dtcs', 'code': int(code), 'polarity': pol}

    pol = m.dtcs_polarity or 'NN'
    if m.tmode == '':
        return None, None
    if m.tmode == 'Tone':
        return ctcss(m.rtone), None
    if m.tmode == 'TSQL':
        return ctcss(m.ctone), ctcss(m.ctone)
    if m.tmode == 'DTCS':
        return dtcs(m.dtcs, pol[0]), dtcs(m.rx_dtcs, pol[1])
    if m.tmode == 'Cross':
        txmode, rxmode = m.cross_mode.split('->', 1)
        tx = ctcss(m.rtone) if txmode == 'Tone' else dtcs(m.dtcs, pol[0]) if txmode == 'DTCS' else None
        rx = ctcss(m.ctone) if rxmode == 'Tone' else dtcs(m.rx_dtcs, pol[1]) if rxmode == 'DTCS' else None
        return tx, rx
    raise SystemExit(f"channel {m.number}: tmode {m.tmode!r} is not one this script knows")


def decode(r):
    out = {}
    for n in range(128):
        try:
            m = r.get_memory(n)
        except Exception as e:
            # Recorded, not skipped: a channel CHIRP cannot read is a fact about
            # the reference, and the fixture is where a test can see it. A
            # power selector of 3 is the known case - see gen-uv9r-fixture.py.
            out[str(n + 1)] = {'error': f'{type(e).__name__}: {e}'}
            continue
        if m.empty:
            continue
        raw = r._memobj.memory[n]
        if m.duplex == 'off':
            tx = 0
        elif m.duplex == 'split':
            tx = m.offset
        elif m.duplex == '+':
            tx = m.freq + m.offset
        elif m.duplex == '-':
            tx = m.freq - m.offset
        else:
            tx = m.freq
        txtone, rxtone = tone_sides(m)
        extra = {s.get_name(): str(s.value) for s in m.extra}
        out[str(n + 1)] = {
            'name': m.name,
            'rx': m.freq,
            'tx': tx,
            'duplex': m.duplex,
            'bw': 25000 if m.mode == 'FM' else 12500,
            'power': str(m.power),
            'lowpower': int(raw.lowpower),
            'skip': 'skip' if m.skip == 'S' else 'none',
            'rxtone': rxtone,
            'txtone': txtone,
            'bcl': extra.get('bcl'),
            'pttid': extra.get('pttid'),
            'scode': extra.get('scode'),
        }
    return out


def plain(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return str(value)


def settings(r, mem):
    s = r._memobj.settings
    names = [n for n in dir(s) if not n.startswith('_')]
    struct = {}
    for name in sorted(names):
        try:
            v = getattr(s, name)
        except Exception:
            continue
        if callable(v):
            continue
        try:
            # Arrays come back as lists of bitwise values.
            struct[name] = [int(x) for x in v]
        except TypeError:
            struct[name] = plain(v)

    ui = {}

    def walk(group):
        for el in group:
            if hasattr(el, 'value') and hasattr(el, 'get_name'):
                v = el.value
                entry = {'value': str(v)}
                options = getattr(v, 'get_options', None)
                if options:
                    entry['index'] = list(options()).index(str(v))
                    entry['options'] = len(list(options()))
                ui[el.get_name()] = entry
            else:
                walk(el)

    walk(r.get_settings())

    msg = r._memobj.poweron_msg
    return {
        'source': os.path.basename(sys.argv[3]),
        'class': sys.argv[2],
        'bytes': len(mem),
        'sha256': hashlib.sha256(bytes(mem)).hexdigest(),
        'settings': struct,
        'poweron_msg': {'line1': str(msg.line1), 'line2': str(msg.line2)},
        'get_settings': ui,
    }


def decode_many(cls_name, paths):
    """Several images keyed by file name, each with the hash of its memory."""
    out = {}
    for path in paths:
        mem = load_image(path)
        out[os.path.basename(path)] = {
            'sha256': hashlib.sha256(bytes(mem)).hexdigest(),
            'class': cls_name,
            'channels': decode(radio_for(cls_name, mem)),
            'settings': settings_struct(radio_for(cls_name, mem)),
        }
    return out


def settings_struct(r):
    s = r._memobj.settings
    struct = {}
    for name in sorted(n for n in dir(s) if not n.startswith('_')):
        try:
            v = getattr(s, name)
        except Exception:
            continue
        if callable(v):
            continue
        try:
            struct[name] = [int(x) for x in v]
        except TypeError:
            struct[name] = plain(v)
    return struct


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == 'decode-many':
        json.dump(decode_many(sys.argv[2], sys.argv[3:]), sys.stdout, indent=1, sort_keys=True)
        sys.stdout.write('\n')
        return
    if len(sys.argv) != 4 or sys.argv[1] not in ('decode', 'settings'):
        sys.exit(__doc__)
    mem = load_image(sys.argv[3])
    r = radio_for(sys.argv[2], mem)
    out = decode(r) if sys.argv[1] == 'decode' else settings(r, mem)
    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
