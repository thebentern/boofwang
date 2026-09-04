// SPDX-License-Identifier: GPL-3.0-or-later
import { hz, mW } from '../../model/units.js'
import { CTCSS_DECIHZ } from '../../model/tones.js'
import type { RadioSchema } from '../../radio/schema.js'
import { CHANNEL_COUNT, NAME_LENGTH, TUNING_STEPS_HZ, UV82_DTCS } from '../uv82/layout.js'
import { UV82_SETTINGS_GROUPS } from '../uv82/schema.js'

/** `UV5R_CHARSET`: upper-case alphanumerics plus a fixed punctuation set. */
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()+-=[]:";\'<>?,./'

/*
 * Band edges, transcribed from `BaofengUV5R._vhf_range` and `_uhf_range`.
 *
 * Written out here rather than imported from the UV-82's layout even though
 * the VHF numbers are the same, because the UHF ones are not: CHIRP gives the
 * UV-82 400-521 MHz and this radio 400-520. One megahertz, and a shared
 * constant would have quietly handed it to whichever radio was edited second.
 * Every member of this family carries its own pair in CHIRP for the same
 * reason.
 */
const VHF_RANGE: readonly [number, number] = [130_000_000, 176_000_000]
const UHF_RANGE: readonly [number, number] = [400_000_000, 520_000_000]

/**
 * The UV-82's settings, less the two that are UV-82 hardware.
 *
 * The settings block is byte-identical across the family - one `MEM_FORMAT` in
 * uv5r.py covers every member - but CHIRP offers `singleptt` and `vfomrlock`
 * only for radios that are `BaofengUV82Radio`, the UV-82HP or the F-11.
 * `singleptt` makes two PTT buttons behave as one and this radio has one
 * button; `vfomrlock` locks a VFO/MR switch this radio does not present that
 * way. Offering either would be a control for hardware that is not there.
 */
export const UV5R_SETTINGS_GROUPS: RadioSchema['settings'] = UV82_SETTINGS_GROUPS.map((g) => ({
  ...g,
  fields: g.fields.filter((f) => f.key !== 'f2b.singleptt' && f.key !== 'f2b.vfomrlock'),
}))

export const UV5R_SCHEMA: RadioSchema = {
  id: 'uv5r',
  vendor: 'Baofeng',
  model: 'UV-5R',
  /*
   * The same radio under other badges.
   *
   * CHIRP carries these as `ALIASES` on `BaofengUV5RGeneric`, which is the
   * plain UV-5R class with a different label on the box. They are listed so
   * that someone holding a Retevis RT5R finds this driver rather than
   * concluding boofwang does not know their radio.
   */
  aliases: ['Baofeng UV-5X', 'Retevis RT5R', 'Retevis RT5RV', 'Retevis RT5', 'Rugged RH5R', 'Radioddity UV-5R EX', 'Ansoko A-5R'],
  status: 'read-only',

  // Same K-port and same 9600-baud clone rate as the rest of the family, so
  // the same untested dongle route. See docs/protocols/ble-dongle.md.
  capabilities: { read: true, write: false, transports: ['serial'], dongle: 'k2' },

  memory: {
    channelCount: CHANNEL_COUNT,
    firstIndex: 1,
    specialChannels: [],
    nameLength: NAME_LENGTH,
    nameCharset: CHARSET,
    eraseFill: 0xff,
  },

  rf: {
    /*
     * Both bands transmit. This is a Part 90 accepted radio sold to amateurs,
     * and CHIRP places no transmit restriction on the plain UV-5R - unlike the
     * GMRS members of the family, whose firmware enforces one.
     *
     * What this band plan cannot do is tell you which UV-5R you have. Behind
     * `UV5R_MODEL_291` and a `BASETYPE_UV5R` firmware string sit the GT-5R,
     * whose firmware restricts transmit to GMRS, the tri-band UV-5RX3, and the
     * UV-5G Pro with its airband receive - and CHIRP cannot separate them
     * either, which is why `match_model` returns False on all three and makes
     * the user say which radio they have. boofwang shows the plain UV-5R's
     * plan. That is a display claim only while this driver is read-only; it
     * has to be settled before a channel is ever written. See
     * docs/protocols/uv5r.md.
     */
    bands: [
      { loHz: hz(VHF_RANGE[0]), hiHz: hz(VHF_RANGE[1]), label: '130-176 MHz', txAllowed: true },
      { loHz: hz(UHF_RANGE[0]), hiHz: hz(UHF_RANGE[1]), label: '400-520 MHz', txAllowed: true },
    ],
    modulations: ['FM'],
    bandwidths: [25_000, 12_500],
    powerLevels: [
      // Order matters: `lowPower` indexes this table, 0 = High. The values are
      // `UV5R_POWER_LEVELS` from uv5r.py. Two levels, which is the whole
      // reason `classifyBasetype` refuses the firmware strings it cannot tell
      // apart from a tri-power BF-F8HP.
      { id: 'high', label: 'High', mW: mW(4000), raw: 0 },
      { id: 'low', label: 'Low', mW: mW(1000), raw: 1 },
    ],
    tuningSteps: TUNING_STEPS_HZ.map((s) => hz(s)),
    duplexes: ['simplex', 'plus', 'minus', 'split'],
    toneModes: ['none', 'tone', 'tsql', 'dtcs', 'cross'],
    ctcssDeciHz: CTCSS_DECIHZ,
    dtcsCodes: UV82_DTCS,
    canSkip: true,
    hasRxDtcs: true,
    hasCtone: true,
    // Same family, same mechanism: no inhibit bit, a filled transmit frequency.
    txInhibit: { mechanism: 'Transmit frequency set to zero' },
  },

  features: {
    dmr: false,
    zones: false,
    talkGroups: false,
    contacts: false,
    rxGroups: false,
    scanLists: false,
    radioIds: false,
    messages: false,
    encryption: false,
    bootPicture: false,
  },

  extraFields: [
    { key: 'busyChannelLockout', label: 'Busy channel lockout', type: 'bool', icon: 'lucide:lock' },
    {
      key: 'pttId',
      label: 'PTT ID',
      type: 'enum',
      options: [
        { value: 0, label: 'Off' },
        { value: 1, label: 'BOT' },
        { value: 2, label: 'EOT' },
        { value: 3, label: 'Both' },
      ],
      icon: 'lucide:hash',
    },
    { key: 'scode', label: 'PTT ID code', type: 'int', min: 0, max: 15, icon: 'lucide:hash' },
  ],

  settings: UV5R_SETTINGS_GROUPS,
}
