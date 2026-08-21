# SPDX-License-Identifier: GPL-3.0-or-later
"""
Dump the UV-K5's stock settings from an image, using CHIRP's own parser.

Same purpose as `dump-uv5r-settings.py`: a second opinion that came from
somewhere else. `MEM_FORMAT` and the `bitwise` engine are CHIRP's, so a decoder
that disagrees with this is wrong about a radio somebody owns.

Not run in CI: CI has no CHIRP checkout. The output is pinned as a fixture and
this script is how it is re-derived.

Usage:
    ./scripts/fetch-reference.sh                       # once
    python3 scripts/dump-uvk5-settings.py IMAGE.bin > fixture.json
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
from chirp import bitwise  # noqa: E402

# The seven blocks the stock firmware keeps its settings in, and the members
# boofwang models in each. Named here rather than scraped so that a field this
# build forgot shows up as missing instead of quietly not being compared.
BLOCKS = {
    'main': ['call_channel', 'squelch', 'max_talk_time', 'noaa_autoscan', 'key_lock',
             'vox_switch', 'vox_level', 'mic_gain', 'unknown3', 'channel_display_mode',
             'crossband', 'battery_save', 'dual_watch', 'backlight_auto_mode',
             'tail_note_elimination', 'vfo_open'],
    'keys': ['beep_control', 'key1_shortpress_action', 'key1_longpress_action',
             'key2_shortpress_action', 'key2_longpress_action', 'scan_resume_mode',
             'auto_keypad_lock', 'power_on_dispmode'],
    'tone': ['keypad_tone', 'language'],
    'alarm': ['alarm_mode', 'reminding_of_end_talk', 'repeater_tail_elimination'],
    'scanlist': ['scanlist_default', 'scanlist1_priority_scan', 'scanlist1_priority_ch1',
                 'scanlist1_priority_ch2', 'scanlist2_priority_scan',
                 'scanlist2_priority_ch1', 'scanlist2_priority_ch2', 'scanlist_unknown_0xff'],
}
LOCK = ['flock', 'tx350', 'killed', 'tx200', 'tx500', 'en350', 'enscramble']


def mem_format():
    src = open(os.path.join(REF, 'uvk5.py')).read()
    m = re.search(r'MEM_FORMAT\s*=\s*"""(.*?)"""', src, re.S)
    if not m:
        sys.exit("could not find MEM_FORMAT in reference/uvk5.py")
    spec = m.group(1)
    if '%' in spec:
        sys.exit("MEM_FORMAT carries a runtime placeholder this script does not substitute")
    return spec


def main(path):
    mem = bitwise.parse(mem_format(), open(path, 'rb').read())

    out = {'source': os.path.basename(path), 'settings': {}}
    for names in BLOCKS.values():
        for name in names:
            out['settings'][name] = int(getattr(mem, name))
    for name in LOCK:
        out['settings'][name] = int(getattr(mem.lock, name))

    out['logo'] = {
        'line1': str(mem.logo_line1).rstrip('\x00\xff').rstrip(),
        'line2': str(mem.logo_line2).rstrip('\x00\xff').rstrip(),
    }
    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    print()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
