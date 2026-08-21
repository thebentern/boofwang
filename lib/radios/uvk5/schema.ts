// SPDX-License-Identifier: GPL-3.0-or-later
import { hz, mHz, mW } from '../../model/units.js'
import { CTCSS_DECIHZ, DTCS_CODES } from '../../model/tones.js'
import type { RadioSchema } from '../../radio/schema.js'
import { BANDS_HZ, TUNING_STEPS_HZ } from './layout.js'

const BAND_LABELS = ['50-76 MHz', '108-137 MHz', '137-174 MHz', '174-350 MHz', '350-400 MHz', '400-470 MHz', '470-600 MHz']

/**
 * The air band is receive-only: it is AM aviation spectrum, and no amateur
 * licence authorises transmitting there. Marking it in the schema means the
 * validator objects before anything reaches the radio.
 */
const RX_ONLY_BANDS = new Set([1])

export const UVK5_SCHEMA: RadioSchema = {
  id: 'uvk5',
  vendor: 'Quansheng',
  model: 'UV-K5',
  aliases: ['UV-K5(8)', 'UV-K6', 'Retevis RA79', 'Quansheng UV-5R Plus'],
  status: 'read-only',

  capabilities: { read: true, write: false },

  memory: {
    channelCount: 200,
    firstIndex: 1,
    // 200..213 zero-based; the radio's VFO/band presets, which have no name storage.
    specialChannels: [
      { index: 201, name: 'F1(50M-76M)A' }, { index: 202, name: 'F1(50M-76M)B' },
      { index: 203, name: 'F2(108M-136M)A' }, { index: 204, name: 'F2(108M-136M)B' },
      { index: 205, name: 'F3(136M-174M)A' }, { index: 206, name: 'F3(136M-174M)B' },
      { index: 207, name: 'F4(174M-350M)A' }, { index: 208, name: 'F4(174M-350M)B' },
      { index: 209, name: 'F5(350M-400M)A' }, { index: 210, name: 'F5(350M-400M)B' },
      { index: 211, name: 'F6(400M-470M)A' }, { index: 212, name: 'F6(400M-470M)B' },
      { index: 213, name: 'F7(470M-600M)A' }, { index: 214, name: 'F7(470M-600M)B' },
    ],
    // The field is 16 bytes but CHIRP caps the usable name at 10.
    nameLength: 10,
    nameCharset: ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~',
    eraseFill: 0xff,
  },

  rf: {
    bands: BANDS_HZ.map(([lo, hi], i) => ({
      loHz: hz(lo),
      hiHz: hz(hi),
      label: BAND_LABELS[i]!,
      txAllowed: !RX_ONLY_BANDS.has(i),
    })),
    modulations: ['FM', 'AM'],
    bandwidths: [25_000, 12_500],
    powerLevels: [
      { id: 'low', label: 'Low', mW: mW(1500), raw: 0b00 },
      { id: 'med', label: 'Med', mW: mW(3000), raw: 0b01 },
      { id: 'high', label: 'High', mW: mW(5000), raw: 0b10 },
    ],
    tuningSteps: TUNING_STEPS_HZ.map((s) => hz(s)),
    duplexes: ['simplex', 'plus', 'minus', 'off'],
    toneModes: ['none', 'tone', 'tsql', 'dtcs', 'cross'],
    ctcssDeciHz: CTCSS_DECIHZ,
    dtcsCodes: DTCS_CODES,
    // No skip flag exists on this radio; CHIRP declares valid_skips = [].
    canSkip: false,
    hasRxDtcs: true,
    hasCtone: true,
    /**
     * The UV-K5 has no transmit-inhibit bit. CHIRP achieves the same effect by
     * setting a minus shift with the offset equal to the receive frequency, so
     * the radio computes a transmit frequency of 0 MHz and cannot key up. It is
     * a real, round-trippable mechanism rather than a gap, so receive-only
     * presets can be programmed - but it is worth naming precisely, because it
     * consumes the offset field and is therefore incompatible with a repeater
     * shift on the same channel.
     */
    txInhibit: { mechanism: 'Transmit frequency parked at 0 MHz (minus shift with offset equal to the RX frequency)' },
  },

  features: {
    dmr: false,
    zones: false,
    talkGroups: false,
    contacts: false,
    rxGroups: false,
    scanLists: { max: 2, channelsPer: 200 },
    radioIds: false,
    messages: false,
    encryption: false,
  },

  extraFields: [
    { key: 'scanList1', label: 'Scan list 1', type: 'bool', icon: 'lucide:list' },
    { key: 'scanList2', label: 'Scan list 2', type: 'bool', icon: 'lucide:list' },
    {
      key: 'compander',
      label: 'Compander',
      type: 'enum',
      options: [
        { value: 0, label: 'Off' },
        { value: 1, label: 'TX' },
        { value: 2, label: 'RX' },
        { value: 3, label: 'TX/RX' },
      ],
      icon: 'lucide:volume-2',
    },
    { key: 'scrambler', label: 'Scrambler', type: 'int', min: 0, max: 10, icon: 'lucide:shield' },
    { key: 'busyChannelLockout', label: 'Busy channel lockout', type: 'bool', icon: 'lucide:lock' },
    { key: 'freqReverse', label: 'Frequency reverse', type: 'bool', icon: 'lucide:refresh-cw' },
    { key: 'dtmfDecode', label: 'DTMF decode', type: 'bool', icon: 'lucide:hash' },
    {
      key: 'dtmfPttId',
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
  ],

  settings: [],
}

export const UVK5_SERIAL = {
  baudRate: 38_400,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  // Several UV-K5 cables assert DTR on open, which resets the radio mid-handshake.
  signals: { dataTerminalReady: false, requestToSend: false },
  openSettleMs: 250,
} as const

export const UVK5_FM_RANGE = { min: mHz(76), max: mHz(108) }
