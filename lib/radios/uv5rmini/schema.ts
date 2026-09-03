// SPDX-License-Identifier: GPL-3.0-or-later
import { hz, mW } from '../../model/units.js'
import { CTCSS_DECIHZ } from '../../model/tones.js'
import type { RadioSchema } from '../../radio/schema.js'
import { UV17PRO_DTCS_CODES } from './layout.js'
import { BAUD_RATE } from './protocol.js'

/** `UV17Pro` name charset: upper case, digits and a little punctuation. */
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -/'

const OFF_ON = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'On' },
]
const range = (n: number, label: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => ({ value: i, label: label(i) }))

/**
 * Labels transcribed from CHIRP's `baofeng_uv17Pro.py`, which is the driver for
 * this radio family and is GPL-3.0, so compatible.
 *
 * Only the fields `UV5RM_SETTINGS` actually models are offered. The struct maps
 * 32 named bytes of a 64-byte region; the rest is round-tripped and not shown.
 */
export const UV5RMINI_SETTINGS_GROUPS = [
  {
    id: 'radio',
    label: 'Radio',
    fields: [
      { key: 'squelch', label: 'Squelch', type: 'int', min: 0, max: 9, icon: 'lucide:volume-2' },
      { key: 'timeout', label: 'Transmit timeout', type: 'enum', options: [{ value: 0, label: 'Off' }, ...range(12, (i) => `${(i + 1) * 15} sec`).map((o) => ({ value: o.value + 1, label: o.label }))] },
      { key: 'saveMode', label: 'Battery save', type: 'enum', options: OFF_ON },
      { key: 'dualStandby', label: 'Dual standby', type: 'enum', options: OFF_ON },
      { key: 'busyChannelLockout', label: 'Busy channel lockout', type: 'enum', options: OFF_ON },
      { key: 'fmRadio', label: 'FM radio', type: 'enum', options: OFF_ON },
      { key: 'bluetooth', label: 'Bluetooth', type: 'enum', options: OFF_ON },
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    fields: [
      { key: 'beep', label: 'Key beep', type: 'enum', options: OFF_ON },
      { key: 'voiceSwitch', label: 'Voice prompts', type: 'enum', options: OFF_ON },
      { key: 'voice', label: 'Voice language', type: 'enum', options: [{ value: 0, label: 'English' }, { value: 1, label: 'Chinese' }] },
      {
        key: 'sideTone',
        label: 'Side tone',
        type: 'enum',
        options: [
          { value: 0, label: 'Off' },
          { value: 1, label: 'Keypad' },
          { value: 2, label: 'ANI' },
          { value: 3, label: 'Keypad + ANI' },
        ],
      },
      { key: 'roger', label: 'Roger beep', type: 'enum', options: OFF_ON },
      { key: 'tone', label: 'Pilot tone', type: 'enum', options: [1000, 1450, 1750, 2100].map((hzv, i) => ({ value: i, label: `${hzv} Hz` })) },
    ],
  },
  {
    id: 'vox',
    label: 'VOX',
    fields: [
      { key: 'vox', label: 'VOX level', type: 'enum', options: [{ value: 0, label: 'Off' }, ...range(9, (i) => `${i + 1}`).map((o) => ({ value: o.value + 1, label: o.label }))], icon: 'lucide:mic' },
      { key: 'voxDelay', label: 'VOX delay', type: 'enum', options: range(16, (i) => `${500 + i * 100} ms`) },
    ],
  },
  {
    id: 'display',
    label: 'Display',
    fields: [
      { key: 'backlight', label: 'Backlight', type: 'int', min: 0, max: 10 },
      { key: 'chADisplayType', label: 'Channel A shows', type: 'enum', options: [{ value: 0, label: 'Name' }, { value: 1, label: 'Frequency' }, { value: 2, label: 'Channel number' }] },
      { key: 'chBDisplayType', label: 'Channel B shows', type: 'enum', options: [{ value: 0, label: 'Name' }, { value: 1, label: 'Frequency' }, { value: 2, label: 'Channel number' }] },
      { key: 'powerOnDisplayType', label: 'Power-on screen', type: 'enum', options: [{ value: 0, label: 'Logo' }, { value: 1, label: 'Battery voltage' }] },
      { key: 'displayAni', label: 'Show ANI', type: 'enum', options: OFF_ON },
      { key: 'menuQuitTime', label: 'Menu timeout', type: 'int', min: 0, max: 60, help: 'Seconds.' },
      { key: 'activeVfo', label: 'Active VFO', type: 'enum', options: [{ value: 0, label: 'A' }, { value: 1, label: 'B' }] },
    ],
  },
  {
    id: 'keys',
    label: 'Keys and scanning',
    fields: [
      { key: 'autoLock', label: 'Automatic keypad lock', type: 'enum', options: OFF_ON },
      { key: 'keyLock', label: 'Keypad lock', type: 'enum', options: OFF_ON },
      { key: 'scanMode', label: 'Scan resumes on', type: 'enum', options: [{ value: 0, label: 'Time' }, { value: 1, label: 'Carrier' }, { value: 2, label: 'Search' }] },
      { key: 'pttId', label: 'PTT ID', type: 'enum', options: [{ value: 0, label: 'Off' }, { value: 1, label: 'Start of transmission' }, { value: 2, label: 'End of transmission' }, { value: 3, label: 'Both' }] },
      { key: 'pttDelay', label: 'PTT delay', type: 'int', min: 0, max: 30 },
    ],
  },
  {
    id: 'repeater',
    label: 'Repeater and alarm',
    fields: [
      { key: 'tailClear', label: 'Squelch tail eliminate', type: 'enum', options: OFF_ON },
      { key: 'repeaterTailClear', label: 'Repeater tail eliminate', type: 'enum', options: range(11, (i) => (i === 0 ? 'Off' : `${i * 100} ms`)) },
      { key: 'repeaterTailDetect', label: 'Repeater tail detect', type: 'enum', options: OFF_ON },
      { key: 'alarmMode', label: 'Alarm mode', type: 'enum', options: [{ value: 0, label: 'Local' }, { value: 1, label: 'Send tone' }, { value: 2, label: 'Send code' }] },
      { key: 'alarmTone', label: 'Alarm tone', type: 'enum', options: OFF_ON },
    ],
  },
] as const satisfies RadioSchema['settings']

export const UV5RMINI_SCHEMA: RadioSchema = {
  id: 'uv5rmini',
  vendor: 'Baofeng',
  model: 'UV-5R Mini',
  /**
   * Both radios this driver speaks to.
   *
   * "UV-5R Mini" and "5RM"/"UV-5RM" are different radios with near-identical
   * names, different identify strings, different region maps and different
   * power tables. The handshake decides which is on the cable.
   */
  aliases: ['UV-5RM', '5RM', 'K5-Plus', 'MaxTalker P15', 'MT-5RM'],
  status: 'read-only',

  /*
   * The only radio here with a Bluetooth profile anybody has read off
   * hardware. A whole codeplug came back over it on 2026-08-21 - 33,344
   * bytes, matching the cable read on all 999 channel records. Writing over
   * it is offered on the same footing as the cable: no `writeTransports`
   * here, so it falls back to `transports` and both carriers write. See
   * docs/protocols/uv5rmini.md.
   */
  capabilities: {
    read: true,
    write: false,
    transports: ['serial', 'bluetooth'],
    /*
     * The K-port dongle route, on top of the built-in module. A dongle
     * reached this radio at 115200 with no configuration, which also answers
     * the rate question that hung over this field for a day.
     *
     * One ambiguity survives and is worth keeping written down: an
     * FFE0-variant dongle would be service-identical to this radio's own
     * module, so a session offering both candidate lists could not tell them
     * apart by UUID. The BT-A1D is FF00 and does not collide, and reads are
     * link-identical either way. See docs/protocols/ble-dongle.md.
     */
    dongle: 'k2',
    /*
     * And proven through one. A Baofeng BT-A1D carried this radio's whole
     * codeplug on 2026-09-01 - 1,000 slots, 21 channels, `5RMINI +L00000` -
     * which makes this the first radio here reachable three ways: cable, its
     * own BLE module, and a clip-on dongle.
     */
    dongleProven: true,
  },

  memory: {
    // The larger of the two: the UV-5R Mini has 999, the 5RM 1000.
    channelCount: 1000,
    firstIndex: 1,
    specialChannels: [],
    nameLength: 12,
    nameCharset: CHARSET,
    eraseFill: 0xff,
  },

  rf: {
    /**
     * `BF5RM.VALID_BANDS`, which adds the air band and the 350-390 MHz range to
     * the three the base UV-17 Pro declares.
     *
     * The air band is receive-only in the schema because it is receive-only in
     * law: 108-137 MHz is aeronautical, and no amateur or business licence
     * authorises transmitting there.
     */
    bands: [
      { loHz: hz(108_000_000), hiHz: hz(135_999_999), label: '108-136 MHz air', txAllowed: false },
      { loHz: hz(136_000_000), hiHz: hz(174_000_000), label: '136-174 MHz', txAllowed: true },
      { loHz: hz(350_000_000), hiHz: hz(390_000_000), label: '350-390 MHz', txAllowed: true },
      { loHz: hz(400_000_000), hiHz: hz(480_000_000), label: '400-480 MHz', txAllowed: true },
      { loHz: hz(480_000_000), hiHz: hz(520_000_000), label: '480-520 MHz', txAllowed: true },
    ],
    /** `BF5RM.MODES = UV17Pro.MODES + ['AM']`; AM is selected by tuning the air band. */
    modulations: ['FM', 'AM'],
    bandwidths: [25_000, 12_500],
    /**
     * Order matters: the two-bit `lowpower` field indexes this table directly,
     * and this radio's order is High, Low, Medium rather than descending.
     * Sorting it would silently reassign every channel's power.
     */
    /**
     * The union of both radios' tables, for display.
     *
     * Which of these a given channel can actually use depends on which radio
     * answered the handshake - the UV-5R Mini has High 5 W and Low 1 W, the
     * 5RM has High 8 W, Low 1 W and Medium 5 W. The decoder reads the level
     * from the variant's own table rather than from here.
     */
    powerLevels: [
      { id: 'high8', label: 'High (8 W)', mW: mW(8000), raw: 0 },
      { id: 'high5', label: 'High (5 W)', mW: mW(5000), raw: 0 },
      { id: 'low', label: 'Low', mW: mW(1000), raw: 1 },
    ],
    // 8.33 kHz is in the list because the air band uses it.
    tuningSteps: [2500, 5000, 6250, 8330, 10_000, 12_500, 20_000, 25_000, 50_000].map((s) => hz(s)),
    duplexes: ['simplex', 'plus', 'minus', 'split'],
    toneModes: ['none', 'tone', 'tsql', 'dtcs', 'cross'],
    ctcssDeciHz: CTCSS_DECIHZ,
    dtcsCodes: UV17PRO_DTCS_CODES,
    canSkip: true,
    hasRxDtcs: true,
    hasCtone: true,
    /**
     * No inhibit bit. The transmit frequency is filled with 0xFF or 0x00, which
     * is the whole of what this radio can say about receive-only.
     */
    txInhibit: { mechanism: 'Transmit frequency filled with 0xFF or 0x00' },
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

  settings: UV5RMINI_SETTINGS_GROUPS,
}

export const UV5RMINI_SERIAL = {
  baudRate: BAUD_RATE,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  // Same two-pin cable family as the other Baofengs: asserting either line
  // resets the radio out of programming mode.
  signals: { dataTerminalReady: false, requestToSend: false },
  openSettleMs: 300,
} as const
