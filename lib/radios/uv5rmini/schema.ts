// SPDX-License-Identifier: GPL-3.0-or-later
import { hz, mW } from '../../model/units.js'
import { CTCSS_DECIHZ } from '../../model/tones.js'
import type { RadioSchema } from '../../radio/schema.js'
import { UV17PRO_DTCS_CODES } from './layout.js'
import { BAUD_RATE } from './protocol.js'

/** `UV17Pro` name charset: upper case, digits and a little punctuation. */
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -/'

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

  capabilities: { read: true, write: false },

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
