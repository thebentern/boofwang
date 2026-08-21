// SPDX-License-Identifier: GPL-3.0-or-later
import { hz, mW } from '../../model/units.js'
import { CTCSS_DECIHZ } from '../../model/tones.js'
import type { RadioSchema } from '../../radio/schema.js'
import { CHANNEL_COUNT, NAME_LENGTH, TUNING_STEPS_HZ, UHF_RANGE, UV82_DTCS, VHF_RANGE } from './layout.js'
import { BAUD_RATE } from './protocol.js'

/** `UV5R_CHARSET`: upper-case alphanumerics plus a fixed punctuation set. */
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()+-=[]:";\'<>?,./'

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

  settings: [],
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
