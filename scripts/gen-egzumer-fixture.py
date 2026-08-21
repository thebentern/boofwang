# SPDX-License-Identifier: GPL-3.0-or-later
"""
Build the synthetic egzumer test image, and CHIRP's own reading of it.

Nobody working on boofwang has a UV-K5 running egzumer, so there is no hardware
capture of that firmware to test against and this script does not pretend
otherwise. What it produces instead is honest in a different way: an EEPROM
image whose every byte was written by CHIRP's `uvk5_egzumer` driver through
CHIRP's own `bitwise` engine, plus a JSON record of what that same driver reads
back out of it.

That makes the fixture worth something a hand-rolled one would not be. If
boofwang's bit ordering, field offsets, step table or mode derivation were
wrong, its decode of these bytes would disagree with the JSON - and neither
side of the comparison was written by boofwang.

What it cannot do is prove the format string itself matches real hardware.
Only a radio can do that. See docs/protocols/uvk5.md.

Not run in CI: CI has no CHIRP checkout. Outputs are committed.

Usage:
    ./scripts/fetch-reference.sh                    # once, to get CHIRP sources
    python3 scripts/gen-egzumer-fixture.py
"""
import builtins
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
PKG = os.path.join(ROOT, 'reference', 'chirp_pkg')

if not os.path.isdir(os.path.join(PKG, 'chirp', 'drivers')):
    sys.exit(
        "reference/chirp_pkg/chirp/drivers is missing.\n"
        "Run ./scripts/fetch-reference.sh first (it assembles an importable CHIRP package)."
    )

sys.path.insert(0, PKG)
# CHIRP's modules call gettext's `_` as a builtin, which its application entry
# point installs. Nothing here translates anything, so identity will do.
builtins._ = lambda s: s

from chirp import bitwise, chirp_common, memmap  # noqa: E402
from chirp.drivers import uvk5_egzumer as EZ  # noqa: E402

BIN_OUT = os.path.join(ROOT, 'test', 'fixtures', 'images', 'uvk5-egzumer-synthetic.bin')
JSON_OUT = os.path.join(ROOT, 'test', 'fixtures', 'uvk5-egzumer-chirp-decode.json')

MEM_SIZE = 0x2000

LOW, MED, HIGH = EZ.UVK5_POWER_LEVELS


def radio():
    r = EZ.UVK5RadioEgzumer(None)
    # 0xFF throughout is what an erased UV-K5 EEPROM actually looks like, so
    # every slot this script does not touch is genuinely empty rather than
    # suspiciously zeroed.
    r._mmap = memmap.MemoryMapBytes(bytes([0xFF]) * MEM_SIZE)
    r._memobj = bitwise.parse(EZ.MEM_FORMAT, r._mmap)
    return r


def mem(number, name, freq, mode, step, power, duplex='', offset=0, **tone):
    m = chirp_common.Memory()
    m.number = number
    m.name = name
    m.freq = freq
    m.mode = mode
    m.tuning_step = step
    m.power = power
    m.duplex = duplex
    m.offset = offset
    for k, v in tone.items():
        setattr(m, k, v)
    return m


# Channels chosen to exercise what egzumer does differently from stock: the
# modulation nibble (including USB, which stock cannot express), the eighteen
# extra tuning steps, the three-bit PTT-ID field, and the wide band plan at both
# ends. The ordinary cases are here too, because they have to keep working.
CHANNELS = [
    mem(1, 'SIMPLEX', 146_520_000, 'FM', 5, HIGH),
    mem(2, 'REPEATER', 146_940_000, 'NFM', 6.25, MED, duplex='-', offset=600_000,
        tmode='Cross', cross_mode='Tone->DTCS', rtone=88.5, rx_dtcs=23,
        dtcs_polarity='NN'),
    mem(3, 'UHF PLUS', 442_100_000, 'FM', 12.5, HIGH, duplex='+', offset=5_000_000,
        tmode='TSQL', ctone=100.0),
    mem(4, 'WX NOAA', 162_550_000, 'FM', 25, LOW, duplex='off'),
    mem(5, 'AIRBAND', 121_500_000, 'AM', 8.33, LOW),
    mem(6, 'CB 19', 27_185_000, 'NAM', 0.01, LOW),
    mem(7, 'TEN USB', 28_400_000, 'USB', 1, LOW),
    mem(8, 'DTCS R', 145_000_000, 'FM', 5, MED, tmode='DTCS', dtcs=31,
        dtcs_polarity='RN'),
    mem(9, 'EXTRAS', 143_000_000, 'NFM', 2.5, LOW),
    mem(10, 'WIDE LOW', 21_300_000, 'USB', 0.05, LOW),
    mem(11, 'WIDE HIGH', 1_240_000_000, 'FM', 500, HIGH),
    mem(12, 'STEP 250', 433_500_000, 'FM', 250, MED),
    # Two of the fourteen VFO presets. They have no name storage and no
    # attribute byte, which is exactly why they are worth having here.
    mem(205, '', 145_500_000, 'FM', 12.5, HIGH),
    mem(214, '', 446_000_000, 'NFM', 6.25, LOW),
]

# Extras CHIRP only reaches through `mem.extra`, set on the parsed object
# instead so this script does not have to build RadioSetting objects. The bit
# packing is still CHIRP's, which is the part being cross-checked.
RAW_EXTRAS = {
    # channel number (1-based, as everywhere else here): field -> value
    2: {'dtmf_pttid': 1, 'scrambler': 3},
    3: {'bclo': 1, 'freq_reverse': 1},
    9: {'dtmf_pttid': 4, 'dtmf_decode': 1, 'scrambler': 10, 'bclo': 1},
    10: {'dtmf_pttid': 3},
}
ATTR_EXTRAS = {
    2: {'is_scanlist1': 1, 'compander': 3},
    3: {'is_scanlist2': 1},
    9: {'is_scanlist1': 1, 'is_scanlist2': 1, 'compander': 1},
}

# One distinct, in-range value per setting, so a decoder that reads the wrong
# byte reads a wrong number rather than a coincidentally equal one.
SETTINGS = {
    'call_channel': 3, 'squelch': 4, 'max_talk_time': 5, 'noaa_autoscan': 1,
    'key_lock': 0, 'vox_switch': 1, 'vox_level': 6, 'mic_gain': 2,
    'backlight_min': 2, 'backlight_max': 9,
    'channel_display_mode': 3, 'crossband': 2, 'battery_save': 4, 'dual_watch': 1,
    'backlight_time': 5, 'ste': 1, 'freq_mode_allowed': 1,
    'ScreenChannel_A': 12, 'MrChannel_A': 12, 'FreqChannel_A': 202,
    'ScreenChannel_B': 205, 'MrChannel_B': 7, 'FreqChannel_B': 205,
    'NoaaChannel_A': 207, 'NoaaChannel_B': 208,
    'keyM_longpress_action': 14, 'button_beep': 1,
    'key1_shortpress_action': 4, 'key1_longpress_action': 1,
    'key2_shortpress_action': 3, 'key2_longpress_action': 7,
    'scan_resume_mode': 2, 'auto_keypad_lock': 1, 'power_on_dispmode': 1,
    'password': 123456,
    'voice': 2, 's0_level': 130, 's9_level': 76,
    'alarm_mode': 1, 'roger_beep': 2, 'rp_ste': 5, 'TX_VFO': 1, 'Battery_type': 1,
    'slDef': 2, 'sl1PriorEnab': 1, 'sl1PriorCh1': 4, 'sl1PriorCh2': 0xFF,
    'sl2PriorEnab': 0, 'sl2PriorCh1': 9, 'sl2PriorCh2': 11,
    'int_flock': 3, 'int_350tx': 1, 'int_KILLED': 0, 'int_200tx': 1,
    'int_500tx': 0, 'int_350en': 1, 'int_scren': 1,
    'backlight_on_TX_RX': 3, 'AM_fix': 1, 'mic_bar': 1, 'battery_text': 1,
    'live_DTMF_decoder': 1,
}

DTMF_SETTINGS = {
    'side_tone': 1, 'separate_code': '*', 'group_call_code': '#',
    'decode_response': 3, 'auto_reset_time': 12, 'preload_time': 30,
    'first_code_persist_time': 7, 'hash_persist_time': 8,
    'code_persist_time': 9, 'code_interval_time': 10, 'permit_remote_kill': 1,
}

BUILD_OPTIONS = {
    'ENABLE_DTMF_CALLING': 1, 'ENABLE_PWRON_PASSWORD': 0, 'ENABLE_TX1750': 1,
    'ENABLE_ALARM': 1, 'ENABLE_VOX': 1, 'ENABLE_VOICE': 0, 'ENABLE_NOAA': 1,
    'ENABLE_FMRADIO': 1, 'ENABLE_SPECTRUM': 1, 'ENABLE_AM_FIX': 1,
    'ENABLE_BLMIN_TMP_OFF': 1, 'ENABLE_RAW_DEMODULATORS': 0,
    'ENABLE_WIDE_RX': 1, 'ENABLE_FLASHLIGHT': 1,
}

FM_PRESETS = [881, 909, 934, 1013, 1047, 1075, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF,
              0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF,
              0xFFFF, 0xFFFF]


def build():
    r = radio()
    o = r._memobj

    # Set before the channels, because `_get_bands` reads it and the VFO preset
    # names in the dump depend on it. (The band nibble `set_memory` stamps into
    # each attribute byte does not: CHIRP always uses BANDS_NOLIMITS there.)
    for k, v in BUILD_OPTIONS.items():
        setattr(o.BUILD_OPTIONS, k, v)

    for m in CHANNELS:
        r.set_memory(m)

    for number, fields in RAW_EXTRAS.items():
        for k, v in fields.items():
            setattr(o.channel[number - 1], k, v)
    for number, fields in ATTR_EXTRAS.items():
        for k, v in fields.items():
            setattr(o.channel_attributes[number - 1], k, v)

    for k, v in SETTINGS.items():
        setattr(o, k, v)
    for k, v in DTMF_SETTINGS.items():
        setattr(o.dtmf, k, v)

    o.logo_line1 = 'BOOFWANG\x00\xff\xff\xff'[0:12] + '\x00\xff\xff\xff'
    o.logo_line2 = 'EGZUMER TST\x00'[0:12] + '\x00\xff\xff\xff'
    o.dtmf.local_code = '103'
    o.dtmf.kill_code = '77777'
    o.dtmf.revive_code = '88888'
    o.dtmf.up_code = '123' + '\x00' * 13
    o.dtmf.down_code = '456' + '\x00' * 13

    for i, v in enumerate(FM_PRESETS):
        o.fmfreq[i] = v

    # The DTMF contact list is not decoded by boofwang. It is populated anyway,
    # so the round-trip test proves those bytes survive rather than proving
    # nothing because they were 0xFF all along.
    for i in range(4):
        o.dtmfcontact[i].name = ('CONTACT%i' % i)[0:8]
        o.dtmfcontact[i].number = '%03i' % (i + 1)

    # Likewise the seven attribute entries above memory 200 and the calibration
    # region: filled with something that is not erase-fill so that "preserved"
    # means something.
    for i in range(200, 207):
        o.channel_attributes[i].band = i - 200
        o.channel_attributes[i].is_free = 0

    raw = bytearray(r._mmap.get_byte_compatible()[0:MEM_SIZE])
    for addr in range(EZ.UVK5RadioEgzumer._cal_start, 0x1FF0):
        raw[addr] = (addr * 7 + 0x33) & 0xFF
    return r, bytes(raw)


def tone_json(kind, mem):
    """The tone on one side of a channel, in boofwang's own shape."""
    tmode, cross = mem.tmode, mem.cross_mode
    tx_ctcss = tmode in ('Tone', 'TSQL') or (tmode == 'Cross' and cross.startswith('Tone->'))
    rx_ctcss = tmode == 'TSQL' or (tmode == 'Cross' and cross.endswith('->Tone'))
    tx_dtcs = tmode == 'DTCS' or (tmode == 'Cross' and cross.startswith('DTCS->'))
    rx_dtcs = tmode == 'DTCS' or (tmode == 'Cross' and cross.endswith('->DTCS'))

    if kind == 'tx':
        if tx_ctcss:
            return {'kind': 'ctcss', 'deciHz': round((mem.rtone if tmode != 'TSQL' else mem.ctone) * 10)}
        if tx_dtcs:
            return {'kind': 'dtcs', 'code': mem.dtcs, 'polarity': mem.dtcs_polarity[0]}
        return None
    if rx_ctcss:
        return {'kind': 'ctcss', 'deciHz': round(mem.ctone * 10)}
    if rx_dtcs:
        code = mem.rx_dtcs if tmode == 'Cross' else mem.dtcs
        return {'kind': 'dtcs', 'code': code, 'polarity': mem.dtcs_polarity[1]}
    return None


def dump(r):
    o = r._memobj
    specials = r._get_specials()
    channels = {}

    numbers = [m.number for m in CHANNELS]
    for number in numbers:
        got = r.get_memory(number)
        if got.empty:
            continue
        slot = number - 1
        raw = o.channel[slot]
        entry = {
            'name': got.name,
            'freq': got.freq,
            'offset': got.offset,
            'duplex': got.duplex or '',
            'mode': got.mode,
            'tuningStepHz': round(got.tuning_step * 1000),
            'power': str(got.power) if got.power else None,
            'txtone': tone_json('tx', got),
            'rxtone': tone_json('rx', got),
            'raw': {
                'freq': int(raw.freq), 'offset': int(raw.offset),
                'modulation': int(raw.modulation), 'shift': int(raw.shift),
                'bandwidth': int(raw.bandwidth), 'txpower': int(raw.txpower),
                'step': int(raw.step), 'scrambler': int(raw.scrambler),
                'bclo': int(raw.bclo), 'freqReverse': int(raw.freq_reverse),
                'dtmfPttId': int(raw.dtmf_pttid), 'dtmfDecode': int(raw.dtmf_decode),
                'rxCode': int(raw.rxcode), 'txCode': int(raw.txcode),
                'rxCodeFlag': int(raw.rxcodeflag), 'txCodeFlag': int(raw.txcodeflag),
            },
        }
        if slot < 200:
            a = o.channel_attributes[slot]
            entry['attr'] = {
                'scanList1': int(a.is_scanlist1), 'scanList2': int(a.is_scanlist2),
                'compander': int(a.compander), 'isFree': int(a.is_free), 'band': int(a.band),
            }
        channels[str(number)] = entry

    settings = {k: int(getattr(o, k)) for k in SETTINGS}
    settings.update({'dtmf_' + k: (str(getattr(o.dtmf, k)) if isinstance(v, str) else int(getattr(o.dtmf, k)))
                     for k, v in DTMF_SETTINGS.items()})
    settings['logo_line1'] = str(o.logo_line1).rstrip('\x00\xff')
    settings['logo_line2'] = str(o.logo_line2).rstrip('\x00\xff')
    settings['dtmf_local_code'] = str(o.dtmf.local_code).rstrip('\x00\xff')
    settings['dtmf_kill_code'] = str(o.dtmf.kill_code).rstrip('\x00\xff')
    settings['dtmf_revive_code'] = str(o.dtmf.revive_code).rstrip('\x00\xff')
    settings['dtmf_up_code'] = str(o.dtmf.up_code).rstrip('\x00\xff')
    settings['dtmf_down_code'] = str(o.dtmf.down_code).rstrip('\x00\xff')

    return {
        'source': 'Written and read back by CHIRP uvk5_egzumer via chirp.bitwise. Synthetic, not hardware.',
        'vfoChannelNames': r._get_vfo_channel_names(),
        'bands': [[int(lo * 1e6), int(hi * 1e6)] for lo, hi in r._get_bands().values()],
        'steps': [round(s * 1000) for s in EZ.UVK5RadioEgzumer._steps],
        'buildOptions': {k: int(getattr(o.BUILD_OPTIONS, k)) for k in BUILD_OPTIONS},
        'fmPresets': [int(o.fmfreq[i]) for i in range(20)],
        'settings': settings,
        'channels': channels,
        'specials': {name: idx for name, idx in specials.items()},
    }


def main():
    r, raw = build()
    # Re-parse the bytes that will actually be committed, so the JSON describes
    # the file rather than the object that produced it.
    r._mmap = memmap.MemoryMapBytes(raw)
    r._memobj = bitwise.parse(EZ.MEM_FORMAT, r._mmap)

    with open(BIN_OUT, 'wb') as f:
        f.write(raw)
    with open(JSON_OUT, 'w') as f:
        json.dump(dump(r), f, indent=1, sort_keys=True)
        f.write('\n')

    print(f"wrote {BIN_OUT} ({len(raw)} bytes)")
    print(f"wrote {JSON_OUT}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
