// SPDX-License-Identifier: GPL-3.0-or-later
import { hz, mW } from '../../model/units.js'
import { CTCSS_DECIHZ } from '../../model/tones.js'
import type { RadioSchema } from '../../radio/schema.js'
import { CHANNEL_COUNT, NAME_LENGTH, TUNING_STEPS_HZ, UHF_RANGE, UV82_DTCS, VHF_RANGE } from './layout.js'
import { BAUD_RATE } from './protocol.js'

/** `UV5R_CHARSET`: upper-case alphanumerics plus a fixed punctuation set. */
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()+-=[]:";\'<>?,./'

const OFF_ON = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'On' },
]
const list = (labels: readonly string[]) => labels.map((label, value) => ({ value, label }))

/**
 * Labels and option lists transcribed from `get_settings` in CHIRP's `uv5r.py`,
 * which is GPL-3.0 and so compatible.
 *
 * Only what `UV82_SETTINGS` models and the writer can reach. Three deliberate
 * omissions. The `unknown` runs are decoded so a test can check every byte
 * against CHIRP's parser, but they are not controls. The VFO A and B blocks at
 * 0x0F10 and 0x0F30 are a separate job. And the power-on message at 0x1828 is
 * decoded but not offered, because it sits past the end of the main block and
 * this driver's write path sends the main block only - offering it would be a
 * control whose changes could never reach the radio.
 *
 * `band`, `step`, `sftd` and `tdrch` are in the struct and left out too: CHIRP
 * drives them from the VFO records rather than from here, and on this firmware
 * `tdrch` is the dual-watch channel on some models and a tone-burst frequency
 * on others. Guessing which would be worse than not offering it.
 */
export const UV82_SETTINGS_GROUPS = [
  {
    id: 'radio',
    label: 'Radio',
    fields: [
      { key: 'squelch', label: 'Carrier squelch level', type: 'int', min: 0, max: 9, icon: 'lucide:volume-2' },
      {
        key: 'save',
        label: 'Battery saver',
        type: 'enum',
        options: list(['Off', '1:1', '1:2', '1:3', '1:4']),
      },
      {
        key: 'timeout',
        label: 'Transmit timeout',
        type: 'enum',
        options: [
          ...Array.from({ length: 40 }, (_, i) => ({ value: i, label: `${15 + i * 15} sec` })),
          { value: 40, label: 'Off (if the radio supports it)' },
        ],
      },
      { key: 'bcl', label: 'Busy channel lockout', type: 'enum', options: OFF_ON },
      { key: 'f2a.fmradio', label: 'Broadcast FM radio', type: 'enum', options: OFF_ON },
      { key: 'tdr', label: 'Dual watch', type: 'enum', options: OFF_ON },
      {
        key: 'tdrab',
        label: 'Dual watch transmit priority',
        type: 'enum',
        options: list(['Off', 'A', 'B']),
      },
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    fields: [
      { key: 'beep', label: 'Key beep', type: 'enum', options: OFF_ON },
      { key: 'voice', label: 'Voice prompts', type: 'enum', options: list(['Off', 'English', 'Chinese']) },
      { key: 'roger', label: 'Roger beep on transmit', type: 'enum', options: OFF_ON },
      { key: 'rogerrx', label: 'Roger beep on receive', type: 'enum', options: list(['Off', 'A', 'B']) },
      { key: 'ste', label: 'Squelch tail eliminate, radio to radio', type: 'enum', options: OFF_ON },
      {
        key: 'rpste',
        label: 'Squelch tail eliminate, repeater',
        type: 'enum',
        options: [{ value: 0, label: 'Off' }, ...Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: `${i + 1}` }))],
      },
      {
        key: 'rptrl',
        label: 'Squelch tail repeater delay',
        type: 'enum',
        options: [{ value: 0, label: 'Off' }, ...Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: `${(i + 1) * 100} ms` }))],
      },
    ],
  },
  {
    id: 'vox',
    label: 'VOX',
    fields: [
      {
        key: 'vox',
        label: 'VOX sensitivity',
        type: 'enum',
        icon: 'lucide:mic',
        options: [{ value: 0, label: 'Off' }, ...Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: `${i + 1}` }))],
      },
    ],
  },
  {
    id: 'display',
    label: 'Display',
    fields: [
      { key: 'abr', label: 'Backlight timeout', type: 'int', min: 0, max: 24, help: 'Seconds. 0 keeps it off.' },
      { key: 'wtled', label: 'Standby LED colour', type: 'enum', options: list(['Off', 'Blue', 'Orange', 'Purple']) },
      { key: 'rxled', label: 'Receive LED colour', type: 'enum', options: list(['Off', 'Blue', 'Orange', 'Purple']) },
      { key: 'txled', label: 'Transmit LED colour', type: 'enum', options: list(['Off', 'Blue', 'Orange', 'Purple']) },
      { key: 'mdfa', label: 'Display mode (A)', type: 'enum', options: list(['Channel', 'Name', 'Frequency']) },
      { key: 'mdfb', label: 'Display mode (B)', type: 'enum', options: list(['Channel', 'Name', 'Frequency']) },
      { key: 'f2a.displayab', label: 'Active display', type: 'enum', options: list(['A', 'B']) },
      { key: 'ponmsg', label: 'Power-on screen', type: 'enum', options: list(['Full', 'Message']) },
    ],
  },
  {
    id: 'keys',
    label: 'Keys and menus',
    fields: [
      { key: 'workmode', label: 'VFO/MR mode', type: 'enum', options: list(['Frequency', 'Channel']) },
      { key: 'keylock', label: 'Keypad lock', type: 'enum', options: OFF_ON },
      { key: 'autolk', label: 'Automatic key lock', type: 'enum', options: OFF_ON },
      { key: 'f2b.vfomrlock', label: 'VFO/MR button', type: 'enum', options: OFF_ON },
      { key: 'f2b.singleptt', label: 'Single PTT', type: 'enum', options: OFF_ON, help: 'UV-82C and UV-82HP only.' },
      { key: 'f2a.menu', label: 'All menus', type: 'enum', options: OFF_ON },
      { key: 'f2a.reset', label: 'Reset menu', type: 'enum', options: OFF_ON },
      { key: 'f12.screv', label: 'Scan resume', type: 'enum', options: list(['Time', 'Carrier', 'Search']) },
    ],
  },
  {
    id: 'dtmf',
    label: 'DTMF and alarm',
    fields: [
      { key: 'dtmfst', label: 'DTMF sidetone', type: 'enum', options: list(['Off', 'DT-ST', 'ANI-ST', 'DT+ANI']) },
      { key: 'pttid', label: 'PTT ID', type: 'enum', options: list(['Off', 'Beginning', 'End', 'Both']) },
      { key: 'pttlt', label: 'PTT ID delay', type: 'int', min: 0, max: 50 },
      { key: 'f2a.alarm', label: 'Alarm sound', type: 'enum', options: OFF_ON },
      { key: 'almod', label: 'Alarm mode', type: 'enum', options: list(['Site', 'Tone', 'Code']) },
    ],
  },
] as const satisfies RadioSchema['settings']

export const UV82_SCHEMA: RadioSchema = {
  id: 'uv82',
  vendor: 'Baofeng',
  model: 'UV-82',
  aliases: ['UV-82X3', 'UV-82HP', 'Radioddity UV-82X3'],
  status: 'read-only',

  capabilities: { read: true, write: false },

  memory: {
    channelCount: CHANNEL_COUNT,
    firstIndex: 1,
    specialChannels: [],
    nameLength: NAME_LENGTH,
    nameCharset: CHARSET,
    eraseFill: 0xff,
  },

  rf: {
    bands: [
      { loHz: hz(VHF_RANGE[0]), hiHz: hz(VHF_RANGE[1]), label: '130-176 MHz', txAllowed: true },
      { loHz: hz(UHF_RANGE[0]), hiHz: hz(UHF_RANGE[1]), label: '400-521 MHz', txAllowed: true },
    ],
    modulations: ['FM'],
    bandwidths: [25_000, 12_500],
    powerLevels: [
      // Order matters: `lowPower` indexes this table, 0 = High.
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
    /**
     * This family stores an independent transmit frequency per channel, so
     * receive-only is expressed the way CHIRP's UV-5R driver does it - there is
     * no dedicated inhibit bit, and a transmit frequency of zero is what the
     * radio treats as "do not transmit".
     */
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

  settings: UV82_SETTINGS_GROUPS,
}

export const UV82_SERIAL = {
  baudRate: BAUD_RATE,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  // The two-pin Kenwood cables reset the radio if DTR or RTS is asserted.
  signals: { dataTerminalReady: false, requestToSend: false },
  openSettleMs: 300,
} as const
