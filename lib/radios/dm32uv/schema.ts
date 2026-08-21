// SPDX-License-Identifier: GPL-3.0-or-later
import { hz, mW } from '../../model/units.js'
import { CTCSS_DECIHZ, DTCS_CODES } from '../../model/tones.js'
import type { RadioSchema } from '../../radio/schema.js'
import { DM32_COLOURS, DM32_KEY_FUNCTIONS, KEY_SLOTS, MESSAGE_MAX_CHARS, MESSAGE_SLOTS } from './layout.js'
import { BAUD_RATE, OPEN_SETTLE_MS } from './protocol.js'

const COLOUR_OPTIONS = DM32_COLOURS.map((label, value) => ({ value, label }))
const KEY_OPTIONS = DM32_KEY_FUNCTIONS.map((label, value) => ({ value, label }))
const ON_OFF = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'On' },
]

/**
 * The settings this build is prepared to change.
 *
 * Deliberately a subset. Block 0x04 is 4 KiB and the reference names perhaps a
 * tenth of it with confidence; the rest is decoded where it can be, round-tripped
 * everywhere, and offered nowhere. A control for a byte whose meaning is a guess
 * is worse than no control, because the user cannot tell the difference.
 */
export const DM32UV_SETTINGS_GROUPS = [
  {
    id: 'display',
    label: 'Display',
    description: 'What the radio shows when it powers on and how it is lit.',
    fields: [
      {
        key: 'powerOnInterface',
        label: 'Power-on screen',
        type: 'enum',
        options: [
          { value: 0, label: 'Picture' },
          { value: 1, label: 'Custom message' },
          { value: 2, label: 'Battery voltage' },
        ],
        icon: 'lucide:monitor',
      },
      { key: 'powerOnLine1', label: 'Power-on line 1', type: 'string', maxLength: 13 },
      { key: 'powerOnLine2', label: 'Power-on line 2', type: 'string', maxLength: 13 },
      {
        key: 'backlightBrightness',
        label: 'Backlight brightness',
        help: 'Stored 0-5; the radio shows it as 1-6.',
        type: 'int',
        min: 0,
        max: 5,
      },
      { key: 'autoBacklightDuration', label: 'Backlight timeout', type: 'int', min: 0, max: 5, help: '0 is 5 seconds, each step adds 5.' },
      { key: 'displayFlags.volumeChangePrompt', label: 'Show volume changes', type: 'bool' },
      { key: 'displayFlags.timeDisplay', label: 'Show the clock', type: 'bool' },
      {
        key: 'displayFlags.dateFormat',
        label: 'Date format',
        type: 'enum',
        options: [
          { value: 0, label: 'Year / month / day' },
          { value: 1, label: 'Day / month / year' },
        ],
      },
      { key: 'menuExitTime', label: 'Menu timeout', type: 'int', min: 0, max: 30, help: 'Seconds. 0 on both radios seen so far, which the reference does not explain.' },
    ],
  },
  {
    id: 'tones',
    label: 'Alert tones',
    description:
      'Which events the radio beeps for. The bit positions come from the reference implementation’s own ' +
      'interface rather than from a capture, so they are its reading rather than an attested one.',
    fields: [
      { key: 'alertTones.keyPress', label: 'Key press', type: 'bool', icon: 'lucide:volume-2' },
      { key: 'alertTones.keyRelease', label: 'Key release', type: 'bool' },
      { key: 'alertTones.menuExit', label: 'Leaving a menu', type: 'bool' },
      { key: 'alertTones.callEnd', label: 'End of call', type: 'bool' },
      { key: 'alertTones.talkPermit', label: 'Talk permit', type: 'bool' },
      { key: 'alertTones.startUpSound', label: 'Power on', type: 'bool' },
      { key: 'alertTones.voicePrompt', label: 'Voice prompt', type: 'bool' },
      { key: 'alertTones.scanStop', label: 'Scan stops', type: 'bool' },
    ],
  },
  {
    id: 'colours',
    label: 'Colours',
    description: 'The six display colours the radio stores, one nibble each.',
    fields: [
      { key: 'callsignColour.colour', label: 'Callsign', type: 'enum', options: COLOUR_OPTIONS },
      { key: 'standbyTextColour.colour', label: 'Standby text', type: 'enum', options: COLOUR_OPTIONS },
      { key: 'channelAColour.colour', label: 'Channel A', type: 'enum', options: COLOUR_OPTIONS },
      { key: 'channelBColour.colour', label: 'Channel B', type: 'enum', options: COLOUR_OPTIONS },
      { key: 'zoneAColour.colour', label: 'Zone A', type: 'enum', options: COLOUR_OPTIONS },
      { key: 'zoneBColour.colour', label: 'Zone B', type: 'enum', options: COLOUR_OPTIONS },
    ],
  },
  {
    id: 'keys',
    label: 'Keys',
    description: 'What the side and programmable keys do. The radio offers the same list for every one.',
    fields: [
      { key: 'sk1Short', label: 'SK1 short press', type: 'enum', options: KEY_OPTIONS, icon: 'lucide:square-mouse-pointer' },
      { key: 'sk1Long', label: 'SK1 long press', type: 'enum', options: KEY_OPTIONS },
      { key: 'sk2Short', label: 'SK2 short press', type: 'enum', options: KEY_OPTIONS },
      { key: 'sk2Long', label: 'SK2 long press', type: 'enum', options: KEY_OPTIONS },
      { key: 'p1Short', label: 'P1 short press', type: 'enum', options: KEY_OPTIONS },
      { key: 'p1Long', label: 'P1 long press', type: 'enum', options: KEY_OPTIONS },
      { key: 'p2Short', label: 'P2 short press', type: 'enum', options: KEY_OPTIONS },
      { key: 'p2Long', label: 'P2 long press', type: 'enum', options: KEY_OPTIONS },
      { key: 'longPressTime', label: 'Long press time', type: 'int', min: 0, max: 4, help: 'Stored 0-4; the radio shows it as 1-5.' },
      { key: 'keyLockFlags.lockKey', label: 'Keypad lock', type: 'enum', options: [{ value: 0, label: 'Manual' }, { value: 1, label: 'Automatic' }] },
      { key: 'keyLockFlags.knobLock', label: 'Lock the knob', type: 'bool' },
      { key: 'keyLockFlags.sideKeyLock', label: 'Lock the side keys', type: 'bool' },
      { key: 'autoKeypadLockDelay', label: 'Auto lock after', type: 'int', min: 0, max: 60, help: 'Seconds.' },
    ],
  },
  {
    id: 'dmr',
    label: 'DMR',
    fields: [
      { key: 'digitalDecodeFlags.privateCallMatch', label: 'Match private calls', type: 'bool' },
      { key: 'digitalDecodeFlags.groupCallMatch', label: 'Match group calls', type: 'bool' },
      { key: 'callHoldTime', label: 'Call hold time', type: 'int', min: 0, max: 61, help: 'Seconds.' },
      { key: 'activeRetriesTime', label: 'Active retries', type: 'int', min: 1, max: 8 },
    ],
  },
  {
    id: 'gps',
    label: 'GPS',
    description: 'This radio has a receiver; the position below is where it last had a fix or was told it was.',
    fields: [
      { key: 'gpsFlags.gpsSwitch', label: 'GPS', type: 'enum', options: ON_OFF, icon: 'lucide:satellite' },
      {
        key: 'gpsFlags.gpsMode',
        label: 'Constellation',
        type: 'enum',
        options: [
          { value: 0, label: 'GPS' },
          { value: 1, label: 'BeiDou' },
          { value: 2, label: 'GPS + BeiDou' },
        ],
      },
      { key: 'gpsFlags.distanceUnit', label: 'Distance', type: 'enum', options: [{ value: 0, label: 'Metric' }, { value: 1, label: 'Imperial' }] },
      {
        key: 'gpsFlags.speedUnit',
        label: 'Speed',
        type: 'enum',
        options: [
          { value: 0, label: 'km/h' },
          { value: 1, label: 'mph' },
          { value: 2, label: 'knots' },
        ],
      },
      { key: 'gpsFlags.gpsDisplayFormat', label: 'Position format', type: 'enum', options: [{ value: 0, label: 'Degrees' }, { value: 1, label: 'Degrees, minutes, seconds' }] },
      { key: 'gpsReportInterval', label: 'Report interval', type: 'int', min: 5, max: 255, help: 'Seconds.' },
      {
        key: 'utcZone',
        label: 'Time zone',
        type: 'enum',
        options: Array.from({ length: 26 }, (_, i) => ({
          value: i,
          label: i === 12 ? 'UTC' : `UTC${i < 12 ? '-' : '+'}${Math.abs(i - 12)}`,
        })),
      },
    ],
  },
  {
    id: 'power',
    label: 'Power',
    fields: [
      { key: 'allowReset.allowReset', label: 'Allow reset from the keypad', type: 'bool' },
      {
        key: 'autoPowerOff',
        label: 'Automatic power off',
        type: 'enum',
        options: [
          { value: 0, label: 'Off' },
          { value: 1, label: '30 minutes' },
          { value: 2, label: '60 minutes' },
          { value: 3, label: '120 minutes' },
          { value: 4, label: '240 minutes' },
          { value: 5, label: '480 minutes' },
        ],
        icon: 'lucide:power',
      },
    ],
  },
] as const satisfies RadioSchema['settings']

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
    // Three levels, not two: byte 0x18 bits 2-1 carry 0=Low, 1=Medium, 2=High.
    // `raw` is the value those two bits hold.
    powerLevels: [
      { id: 'low', label: 'Low', mW: mW(1000), raw: 0 },
      { id: 'medium', label: 'Medium', mW: mW(2500), raw: 1 },
      { id: 'high', label: 'High', mW: mW(5000), raw: 2 },
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
    messages: { max: MESSAGE_SLOTS, maxChars: MESSAGE_MAX_CHARS },
    encryption: { slots: KEY_SLOTS, types: ['none', 'custom', 'arc4', 'aes128', 'aes256'], nameLength: 10 },
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
    { key: 'encryptionKeyId', label: 'Encryption key', type: 'int', min: 0, max: KEY_SLOTS, icon: 'lucide:key' },
  ],

  settings: DM32UV_SETTINGS_GROUPS,
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
