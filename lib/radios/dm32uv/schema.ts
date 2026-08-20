// SPDX-License-Identifier: GPL-3.0-or-later
import { hz, mW } from '../../model/units.js'
import { CTCSS_DECIHZ, DTCS_CODES } from '../../model/tones.js'
import type { RadioSchema } from '../../radio/schema.js'
import { BAUD_RATE, OPEN_SETTLE_MS } from './protocol.js'

export const DM32UV_SCHEMA: RadioSchema = {
  id: 'dm32uv',
  vendor: 'Baofeng',
  model: 'DM-32UV',
  aliases: ['DP570UV'],
  status: 'read-only',

  capabilities: { read: true, write: false },

  memory: {
    // The reference implementation's ceiling; the largest codeplug actually
    // attested is far smaller, and the test radio holds 45 channels.
    channelCount: 4000,
    firstIndex: 1,
    specialChannels: [],
    nameLength: 16,
    nameCharset:
      ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~',
    eraseFill: 0xff,
  },

  rf: {
    bands: [
      { loHz: hz(136_000_000), hiHz: hz(174_000_000), label: '136-174 MHz', txAllowed: true },
      { loHz: hz(400_000_000), hiHz: hz(480_000_000), label: '400-480 MHz', txAllowed: true },
    ],
    modulations: ['FM', 'DMR'],
    bandwidths: [25_000, 12_500],
    powerLevels: [
      { id: 'low', label: 'Low', mW: mW(1000), raw: 0 },
      { id: 'high', label: 'High', mW: mW(5000), raw: 1 },
    ],
    tuningSteps: [2_500, 5_000, 6_250, 10_000, 12_500, 25_000].map((s) => hz(s)),
    duplexes: ['simplex', 'plus', 'minus', 'split', 'off'],
    toneModes: ['none', 'tone', 'tsql', 'dtcs', 'cross'],
    ctcssDeciHz: CTCSS_DECIHZ,
    dtcsCodes: DTCS_CODES,
    canSkip: true,
    hasRxDtcs: true,
    hasCtone: true,
    /** A dedicated per-channel bit, unlike either of the analog radios here. */
    txInhibit: { mechanism: 'Per-channel transmit-forbid flag' },
  },

  features: {
    dmr: { colorCodes: [0, 15], timeslots: 2 },
    zones: { max: 250, channelsPer: 64, nameLength: 11 },
    talkGroups: { max: 800, nameLength: 16 },
    contacts: { max: 50_000 },
    rxGroups: { max: 32 },
    scanLists: { max: 32, channelsPer: 15 },
    radioIds: { max: 250 },
    encryption: { slots: 8, types: ['none', 'custom', 'arc4', 'aes128', 'aes256'], nameLength: 10 },
  },

  extraFields: [
    { key: 'colorCode', label: 'Colour code', type: 'int', min: 0, max: 15, icon: 'lucide:hash' },
    {
      key: 'timeSlot',
      label: 'Time slot',
      type: 'enum',
      options: [
        { value: 1, label: '1' },
        { value: 2, label: '2' },
      ],
      icon: 'lucide:layers',
    },
    { key: 'encryptionKeyId', label: 'Encryption key', type: 'int', min: 0, max: 8, icon: 'lucide:key' },
  ],

  settings: [],
}

export const DM32UV_SERIAL = {
  baudRate: BAUD_RATE,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  signals: { dataTerminalReady: false, requestToSend: false },
  openSettleMs: OPEN_SETTLE_MS,
} as const
