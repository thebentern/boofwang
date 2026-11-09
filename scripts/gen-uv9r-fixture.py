# SPDX-License-Identifier: GPL-3.0-or-later
"""
Build the synthetic UV-9R test image, CHIRP's reading of it, and what CHIRP
writes for a set of edits.

Nobody working on boofwang has a UV-9R, and the one real UV-9R capture that
exists is a stranger's upload to CHIRP's tracker, which is not this project's
to redistribute. So there is no hardware capture to commit, and this script
does not pretend to be one. What it produces is honest in a different way, the
way scripts/gen-egzumer-fixture.py is: a memory image whose bytes were written
by CHIRP's own `UV9R` driver through CHIRP's own `bitwise` engine, plus a
record of what that same driver reads back out.

It exists for the paths a factory image never reaches. The UV-9G capture CHIRP
publishes has no Low channel, no inverted DTCS, no cross tone mode, no split
and no zero transmit filling; this image has every one, and a handful of
states no CHIRP `set_memory` call can produce - a power selector of 3, a name
with 0xFF in the middle, a stale record behind an empty marker - poked in
through `bitwise` so that `get_memory` is asked about them too. One of those
answers was not the expected one: `get_memory` cannot read a power selector
of 3 at all, and the fixture says so rather than leaving the slot out.

Three outputs:

    test/fixtures/images/uv9r-chirp-synthetic.bin   0x2008 bytes
    test/fixtures/uv9r-chirp-decode.json            get_memory, per channel
    test/fixtures/uv9r-chirp-edits.json             set_memory's bytes for
                                                    each edit, so the encoder
                                                    can be held to them

What it cannot do is show that `MEM_FORMAT` matches a real radio. Only a radio
can do that. See docs/protocols/uv9r.md.

Not run in CI: CI has no CHIRP checkout. Outputs are committed.

Usage:
    ./scripts/fetch-reference.sh                    # once
    python3 scripts/gen-uv9r-fixture.py
"""
import builtins
import copy
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
PKG = os.path.join(ROOT, 'reference', 'chirp_pkg')

if not os.path.isfile(os.path.join(PKG, 'chirp', 'drivers', 'baofeng_wp970i.py')):
    sys.exit("reference/chirp_pkg/chirp/drivers/baofeng_wp970i.py is missing. Run ./scripts/fetch-reference.sh first.")

sys.path.insert(0, PKG)
builtins._ = lambda s: s

from chirp import chirp_common, memmap  # noqa: E402
from chirp.drivers import baofeng_wp970i as W  # noqa: E402

# The decode half is the dump script's, loaded rather than copied, so the two
# fixtures cannot disagree about how a channel is reported.
_spec = importlib.util.spec_from_file_location('dump_wp970i', os.path.join(HERE, 'dump-wp970i-family.py'))
DUMP = importlib.util.module_from_spec(_spec)
sys.argv = [sys.argv[0], 'decode', 'UV9R', '-']  # the dump module reads nothing at import
_spec.loader.exec_module(DUMP)

BIN_OUT = os.path.join(ROOT, 'test', 'fixtures', 'images', 'uv9r-chirp-synthetic.bin')
DECODE_OUT = os.path.join(ROOT, 'test', 'fixtures', 'uv9r-chirp-decode.json')
EDITS_OUT = os.path.join(ROOT, 'test', 'fixtures', 'uv9r-chirp-edits.json')

MEM_SIZE = 0x2000
# What a 2017 UV-9R and a 2018 UV-9R Pro both sent (CHIRP issues 4511, 9932).
IDENT = bytes([0xAA, 0x30, 0x79, 0x04, 0x00, 0x05, 0x20, 0xDD])

HIGH, MED, LOW = W.UV9R.POWER_LEVELS


def radio(data):
    r = W.UV9R(None)
    r._mmap = memmap.MemoryMapBytes(bytes(data))
    r.process_mmap()
    return r


def mem(number, name, freq, power=HIGH, mode='FM', duplex='', offset=0, skip='', **tone):
    m = chirp_common.Memory()
    m.number = number
    m.name = name
    m.freq = freq
    m.power = power
    m.mode = mode
    m.duplex = duplex
    m.offset = offset
    m.skip = skip
    for k, v in tone.items():
        setattr(m, k, v)
    return m


def build():
    # 0xFF is what this radio's memory holds where nothing was ever written,
    # so every slot this script does not touch is genuinely empty.
    r = radio(b'\xff' * MEM_SIZE + IDENT)

    plan = [
        mem(0, 'SIMPLEX', 146_520_000),
        mem(1, 'RPT-', 147_000_000, MED, 'NFM', '-', 600_000, tmode='Tone', rtone=100.0),
        mem(2, 'RPT+', 442_000_000, LOW, duplex='+', offset=5_000_000, tmode='TSQL', ctone=123.0),
        mem(3, 'DTCSN', 446_000_000, tmode='DTCS', dtcs=23, rx_dtcs=23, dtcs_polarity='NN'),
        mem(4, 'DTCSRN', 446_500_000, tmode='DTCS', dtcs=754, rx_dtcs=754, dtcs_polarity='RN'),
        mem(5, 'XTONE', 147_120_000, tmode='Cross', cross_mode='Tone->Tone', rtone=100.0, ctone=123.0),
        mem(6, 'X-DTCS', 147_180_000, tmode='Cross', cross_mode='->DTCS', rx_dtcs=411, dtcs_polarity='NR'),
        mem(7, 'XT2D', 147_240_000, tmode='Cross', cross_mode='Tone->DTCS', rtone=88.5, rx_dtcs=23,
            dtcs_polarity='NN'),
        mem(8, 'XD2T', 147_300_000, tmode='Cross', cross_mode='DTCS->Tone', dtcs=155, ctone=141.3,
            dtcs_polarity='RN'),
        mem(9, 'X-TONE', 147_360_000, tmode='Cross', cross_mode='->Tone', ctone=67.0),
        # 645 is the code this family's table has and the standard list lacks.
        mem(10, 'XD-', 147_420_000, tmode='Cross', cross_mode='DTCS->', dtcs=645, dtcs_polarity='NN'),
        mem(11, 'XDD', 147_480_000, tmode='Cross', cross_mode='DTCS->DTCS', dtcs=23, rx_dtcs=754,
            dtcs_polarity='NR'),
        # Different VALID_BANDS: a split.
        mem(12, 'XBAND', 146_000_000, duplex='split', offset=446_000_000),
        mem(13, 'NOAA1', 162_550_000, duplex='off'),
        mem(14, 'SKIPME', 145_500_000, skip='S'),
        mem(15, 'BCL', 145_600_000),
        mem(16, '1234567', 145_700_000),
        mem(17, 'abc', 145_800_000, mode='NFM'),
        mem(18, 'ZEROTX', 147_555_000),
        mem(19, 'GAP', 147_600_000),
        mem(20, 'PWR3', 147_650_000),
        mem(21, 'FFFF', 147_700_000),
        mem(22, 'STALE', 147_750_000),
        mem(23, 'LOW', 151_820_000, LOW, 'NFM'),
        # The same VALID_BANDS entry, 100 MHz apart: CHIRP calls this a shift.
        mem(24, 'BIGSHFT', 420_000_000, duplex='split', offset=520_000_000),
        mem(127, 'LAST', 462_562_500, tmode='TSQL', ctone=254.1),
    ]
    for m in plan:
        r.set_memory(m)

    o = r._memobj
    # BCL on, PTT ID "Both", S-code "15": the per-channel extras.
    o.memory[15].bcl = 1
    o.memory[15].pttid = 3
    o.memory[15].scode = 14
    # A zero transmit filling, which `_is_txinh` reads as receive-only and
    # `set_memory` never writes.
    for j in range(4):
        o.memory[18].txfreq[j].set_raw(b'\x00')
    # 0xFF in the middle of a name, which `get_memory` reads as a space.
    o.names[19].set_raw(b'AB\xffCD\xff\xff' + b'\xff' * 9)
    # A power selector the table has no entry for. `get_memory` means to fall
    # back to High here, and does not: its `except IndexError` handler formats
    # `_mem.power`, a field this struct does not have, so the handler itself
    # raises AttributeError and the channel cannot be read at all. This looked
    # like a fallback until this script asked CHIRP; the decode fixture records
    # the error, so a test can see the reference's actual behavior.
    o.memory[20].lowpower = 3
    # The other spelling of "no tone".
    o.memory[21].rxtone = 0xFFFF
    o.memory[21].txtone = 0xFFFF
    # Empty by its first byte alone, with a whole record left behind it - how
    # the factory leaves a hundred slots on every UV-9R capture.
    o.memory[22].set_raw(b'\xff' + o.memory[22].get_raw()[1:])

    # A settings block worth reading: every field CHIRP names, set to a value
    # its own list accepts, and most of them away from zero so a slipped offset
    # cannot hide behind a run of zeros.
    s = o.settings
    for name, value in dict(
        squelch=4, step=2, save=2, vox=3, abr=5, tdr=1, beep=0, timeout=7, voice=2, dtmfst=3,
        screv=2, pttid=1, pttlt=12, mdfa=2, mdfb=0, bcl=1, autolk=1, sftd=0, wtled=1, rxled=2,
        txled=3, almod=1, band=0, tdrab=2, ste=0, rpste=3, rptrl=4, ponmsg=1, roger=1, rogerrx=2,
        tdrch=0, displayab=0, fmradio=0, alarm=1, reset=0, menu=1, singleptt=0, vfomrlock=1,
        workmode=0, keylock=1,
    ).items():
        setattr(s, name, value)
    o.poweron_msg.line1 = 'CHIRP  '
    o.poweron_msg.line2 = 'SYNTH  '

    # Not boofwang's to read, but `get_settings` refuses an image whose VFO
    # frequencies, band limits or service squelch tables are erased - it
    # raises on 0xFF where it expects BCD - so they hold what a radio would.
    def digits(arr, value, n):
        for i, ch in enumerate(str(value).rjust(n, '0')):
            arr[i] = int(ch)

    for vfo, freq in ((o.vfo.a, 14652000), (o.vfo.b, 44600000)):
        digits(vfo.freq, freq, 8)
        digits(vfo.offset, 600, 6)
        vfo.rxtone = 0
        vfo.txtone = 0
        vfo.band = 0
        vfo.sftd = 0
        vfo.scode = 0
        vfo.step = 2
        vfo.widenarr = 0
        vfo.txpower3 = 0
    for band, lo, hi in ((o.limits.vhf, 136, 174), (o.limits.uhf, 400, 520), (o.limits.vhf2, 200, 260)):
        band.enable = 1
        band.lower = lo
        band.upper = hi
    for table, start in ((o.squelch.vhf, 0x12), (o.squelch.uhf, 0x10)):
        for i in range(10):
            setattr(table, f'sql{i}', 0 if i == 0 else start + i)

    return r._mmap.get_packed()


# Each edit in boofwang's own terms, which is what the TypeScript side applies,
# and the same edit as a change to CHIRP's Memory, which is what produces the
# expected bytes.
EDITS = [
    ('shorter name', 0, {'name': 'BOOF'}),
    ('Med to Low', 1, {'power': 'Low'}),
    ('repeater to receive-only', 2, {'txAllowed': False}),
    ('DTCS to plain tone', 3, {'tone': {'tx': {'kind': 'ctcss', 'deciHz': 885}, 'rx': None}}),
    ('skip off', 14, {'skip': 'none'}),
    ('split to simplex', 12, {'tx': {'kind': 'simplex'}}),
    ('wide to narrow', 4, {'bandwidthHz': 12500}),
    ('zero-filled receive-only, power changed', 18, {'power': 'Low'}),
    ('extras changed', 15, {'busyChannelLockout': '0', 'pttId': '1', 'scode': '3'}),
]


def apply(m, change):
    """The CHIRP side of one edit."""
    for k, v in change.items():
        if k == 'name':
            m.name = v
        elif k == 'power':
            m.power = {'High': HIGH, 'Med': MED, 'Low': LOW}[v]
        elif k == 'txAllowed':
            assert v is False
            m.duplex, m.offset = 'off', 0
        elif k == 'tone':
            tx, rx = v['tx'], v['rx']
            assert tx and tx['kind'] == 'ctcss' and rx is None, 'only the edit used above'
            m.tmode, m.rtone = 'Tone', tx['deciHz'] / 10
        elif k == 'skip':
            m.skip = '' if v == 'none' else 'S'
        elif k == 'tx':
            assert v == {'kind': 'simplex'}
            m.duplex, m.offset = '', 0
        elif k == 'bandwidthHz':
            m.mode = 'FM' if v >= 25000 else 'NFM'
        elif k in ('busyChannelLockout', 'pttId', 'scode'):
            name = {'busyChannelLockout': 'bcl', 'pttId': 'pttid', 'scode': 'scode'}[k]
            setting = next(s for s in m.extra if s.get_name() == name)
            if name == 'bcl':
                setting.value = bool(int(v))
            elif name == 'pttid':
                setting.value = W.LIST_PTTID[int(v)]
            else:
                setting.value = W.LIST_SCODE[int(v)]
        else:
            raise SystemExit(f'unknown edit {k}')


# New channels in slots that were empty, described the same way. The two kinds
# of empty a real radio has: erased flash, 0xFF throughout, and a stale record
# behind a 0xFF marker, which is how the factory leaves most UV-9R slots. On
# erased flash the power selector reads 3 and every unknown bit reads 1, which
# is what an adversarial review caught the encoder carrying into a new channel.
CREATES = [
    ('a High channel on erased flash', 30,
     {'name': 'NEW', 'rx': 146_940_000, 'power': 'High', 'bandwidthHz': 25000}),
    ('a toned Low channel over a stale record', 22,
     {'name': 'OVER', 'rx': 446_100_000, 'power': 'Low', 'bandwidthHz': 12500,
      'tone': {'tx': {'kind': 'ctcss', 'deciHz': 1000}, 'rx': {'kind': 'ctcss', 'deciHz': 1000}}}),
]


def created(slot, spec):
    """The CHIRP side of one new channel."""
    m = chirp_common.Memory()
    m.number = slot
    m.name = spec['name']
    m.freq = spec['rx']
    m.power = {'High': HIGH, 'Med': MED, 'Low': LOW}[spec['power']]
    m.mode = 'FM' if spec['bandwidthHz'] >= 25000 else 'NFM'
    tone = spec.get('tone')
    if tone:
        assert tone['tx'] == tone['rx'] and tone['tx']['kind'] == 'ctcss', 'only the create used above'
        m.tmode, m.ctone = 'TSQL', tone['tx']['deciHz'] / 10
    return m


def edits(data):
    out = []
    for label, slot, change in EDITS:
        r = radio(data)
        m = copy.deepcopy(r.get_memory(slot))
        apply(m, change)
        r.set_memory(m)
        out.append({
            'label': label,
            'index': slot + 1,
            'change': change,
            'record': r._memobj.memory[slot].get_raw().hex(),
            'name': r._memobj.names[slot].get_raw().hex(),
        })
    for label, slot, spec in CREATES:
        r = radio(data)
        assert r.get_memory(slot).empty, f'slot {slot} is meant to be empty'
        r.set_memory(created(slot, spec))
        out.append({
            'label': label,
            'index': slot + 1,
            'create': spec,
            'record': r._memobj.memory[slot].get_raw().hex(),
            'name': r._memobj.names[slot].get_raw().hex(),
        })
    return out


def main():
    data = build()
    assert len(data) == MEM_SIZE + len(IDENT)
    with open(BIN_OUT, 'wb') as f:
        f.write(data)

    decoded = DUMP.decode(radio(data))
    with open(DECODE_OUT, 'w') as f:
        json.dump(decoded, f, indent=1, sort_keys=True)
        f.write('\n')

    with open(EDITS_OUT, 'w') as f:
        json.dump(edits(data), f, indent=1)
        f.write('\n')

    print(f'{len(data)} bytes, {len(decoded)} channels, {len(EDITS)} edits, {len(CREATES)} creates', file=sys.stderr)


if __name__ == '__main__':
    main()
