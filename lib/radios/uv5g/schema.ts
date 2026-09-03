// SPDX-License-Identifier: GPL-3.0-or-later
import { hz, mW } from '../../model/units.js'
import { CTCSS_DECIHZ } from '../../model/tones.js'
import type { RadioSchema } from '../../radio/schema.js'
import { CHANNEL_COUNT, NAME_LENGTH, TUNING_STEPS_HZ, UV82_DTCS } from '../uv82/layout.js'
import { UV82_SETTINGS_GROUPS } from '../uv82/schema.js'

/** `UV5R_CHARSET`: upper-case alphanumerics plus a fixed punctuation set. */
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()+-=[]:";\'<>?,./'

/**
 * The UV-82's settings, less the single-PTT switch.
 *
 * The settings block is byte-identical across the family - one `MEM_FORMAT` in
 * uv5r.py covers both radios - but `f2b.singleptt` selects between the UV-82's
 * two PTT buttons, and this radio has one. Offering it would be a control for
 * hardware that is not there.
 */
export const UV5G_SETTINGS_GROUPS: RadioSchema['settings'] = UV82_SETTINGS_GROUPS.map((g) => ({
  ...g,
  fields: g.fields.filter((f) => f.key !== 'f2b.singleptt'),
}))

export const UV5G_SCHEMA: RadioSchema = {
  id: 'uv5g',
  vendor: 'Radioddity',
  // The shell and the power-on message both say "BAOFENG UV-5G"; CHIRP files
  // it under Radioddity, whose name is on the box. The alias keeps both
  // spellings findable.
  model: 'UV-5G',
  aliases: ['Baofeng UV-5G'],
  status: 'read-only',

  // Same K-port and same 9600-baud clone rate as the UV-82, so the same
  // untested dongle route. See docs/protocols/ble-dongle.md.
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
     * A GMRS band plan, expressed in the order `bandFor` searches.
     *
     * The two transmit windows sit inside the 400-520 MHz receive span, and
     * every consumer of this table takes the first band containing a
     * frequency - so the windows come first and the broad receive-only spans
     * after, with no fiddly edge arithmetic. A new channel also starts in the
     * first transmit-capable band, which lands it on GMRS 15 rather than an
     * arbitrary band edge.
     *
     * Receive-only here is the firmware's rule, not just the licence: this
     * radio is sold as Part 95E certified, transmitting on GMRS channels only,
     * with wideband receive. That claim comes from the vendor and the
     * certification, not from keying the radio on the bench - boofwang has no
     * way to test a refusal to transmit, and does not try.
     */
    bands: [
      { loHz: hz(462_550_000), hiHz: hz(462_725_000), label: 'GMRS 462 MHz', txAllowed: true },
      { loHz: hz(467_550_000), hiHz: hz(467_725_000), label: 'GMRS 467 MHz', txAllowed: true },
      { loHz: hz(130_000_000), hiHz: hz(176_000_000), label: '130-176 MHz', txAllowed: false },
      { loHz: hz(400_000_000), hiHz: hz(520_000_000), label: '400-520 MHz', txAllowed: false },
    ],
    modulations: ['FM'],
    bandwidths: [25_000, 12_500],
    powerLevels: [
      // Order matters: `lowPower` indexes this table, 0 = High. The values are
      // `UV5R_POWER_LEVELS` from uv5r.py; the box says 5 W, CHIRP says 4, and
      // neither number is stored on the radio - only the one-bit selector is.
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
    // The factory codeplug uses it: eleven NOAA channels ship as 0xFF fills.
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

  settings: UV5G_SETTINGS_GROUPS,
}
