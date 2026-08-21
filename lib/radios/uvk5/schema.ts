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

/**
 * The name this build gives the egzumer firmware's EEPROM layout.
 *
 * A constant rather than a string literal because it is the join between three
 * places that must agree: the variant table that assigns it at handshake, the
 * decoder that branches on it, and the setting groups below that declare
 * themselves only for it.
 */
export const EGZUMER_LAYOUT = 'egzumer'
export const STOCK_LAYOUT = 'stock'

const listed = (labels: readonly string[]) => labels.map((label, value) => ({ value, label }))

/**
 * `KEYACTIONS_LIST` in uvk5_egzumer.py, unabridged.
 *
 * CHIRP hides the entries whose feature the firmware was not built with, which
 * it can do because it has the build flags in front of it. This build shows all
 * fifteen and says so in the group description instead: hiding an option would
 * also hide the value a radio already holds, and a key that is set to an action
 * the firmware does not have is worth being able to see.
 */
const KEY_ACTIONS = [
  'None',
  'Flashlight',
  'TX power',
  'Monitor',
  'Scan',
  'VOX',
  'Alarm',
  'FM broadcast radio',
  '1750 Hz tone',
  'Lock keypad',
  'Switch main VFO',
  'Switch frequency/memory mode',
  'Switch demodulation',
  'Min backlight temporary off',
  'Spectrum analyzer',
]

const PRIORITY_HELP = 'Counted from zero, so 0 is memory M1. 255 means no priority channel.'
const TENS_OF_MS = 'In units of 10 ms, which is how the radio stores it: 30 is 300 ms.'

/**
 * Settings the egzumer firmware stores, and stock does not store the same way.
 *
 * Every label and every value list is transcribed from `get_settings` in
 * CHIRP's `uvk5_egzumer.py`, and every offset behind them was checked back
 * against CHIRP's own `bitwise` parser - see the layout module.
 *
 * These are declared for the egzumer layout alone. Stock firmware puts real
 * data at most of the same addresses, but it does not always mean the same
 * thing by it: 0x0E78 is a backlight range here and an unknown byte there,
 * 0x0E90 is a beep flag plus a key action here and a whole beep byte there,
 * 0x0EA0 is the voice prompt here and the keypad tone there. Offering these
 * controls for a stock image would be offering to change something else.
 *
 * What is deliberately *not* offered:
 *
 *  - The VFO screen/memory/frequency channel pointers at 0x0E80. They decode,
 *    but CHIRP keeps four of those eight bytes consistent with each other when
 *    any one changes, and a control that edits one in isolation would leave the
 *    radio pointing two ways at once.
 *  - The power-on password at 0x0E98. It decodes as a number; a raw 32-bit
 *    field is the wrong way to ask someone for a six-digit code.
 *  - The seven attribute entries above memory 200, and the DTMF contact list at
 *    0x1C00, neither of which this build decodes at all.
 */
export const EGZUMER_SETTINGS_GROUPS = [
  {
    id: 'egzumer-basic',
    label: 'Basic',
    layouts: [EGZUMER_LAYOUT],
    fields: [
      { key: 'squelch', label: 'Squelch (Sql)', type: 'int', min: 0, max: 9, icon: 'lucide:volume-2' },
      {
        key: 'callChannel',
        label: 'One-key call channel (1 Call)',
        type: 'int',
        min: 0,
        max: 199,
        help: 'Counted from zero, so 0 is memory M1.',
        icon: 'lucide:radio',
      },
      {
        key: 'maxTalkTime',
        label: 'Transmit time-out (TxTOut)',
        type: 'enum',
        icon: 'lucide:clock',
        options: listed([
          '30 sec', '1 min', '2 min', '3 min', '4 min', '5 min',
          '6 min', '7 min', '8 min', '9 min', '15 min',
        ]),
      },
      {
        key: 'batterySave',
        label: 'Battery save (BatSav)',
        type: 'enum',
        icon: 'lucide:zap',
        options: listed(['Off', '1:1', '1:2', '1:3', '1:4']),
      },
      {
        key: 'batteryType',
        label: 'Battery type (BatTyp)',
        type: 'enum',
        icon: 'lucide:zap',
        options: listed(['1600 mAh', '2200 mAh']),
      },
      { key: 'noaaAutoscan', label: 'NOAA autoscan (NOAA-S)', type: 'bool', icon: 'lucide:satellite' },
      { key: 'freqModeAllowed', label: 'Frequency mode allowed', type: 'bool', icon: 'lucide:unlock' },
      { key: 'txVfo', label: 'Main VFO', type: 'enum', options: listed(['A', 'B']), icon: 'lucide:antenna' },
      {
        key: 'crossband',
        label: 'Crossband repeat',
        type: 'enum',
        icon: 'lucide:arrow-up-down',
        options: [
          { value: 0, label: 'Off' },
          { value: 1, label: 'On, VFO A is main' },
          { value: 2, label: 'On, VFO B is main' },
        ],
      },
      {
        key: 'dualWatch',
        label: 'Dual watch',
        type: 'enum',
        icon: 'lucide:arrow-up-down',
        options: [
          { value: 0, label: 'Off' },
          { value: 1, label: 'On, VFO A is main' },
          { value: 2, label: 'On, VFO B is main' },
        ],
      },
      {
        key: 'scanResumeMode',
        label: 'Scan resume (ScnRev)',
        type: 'enum',
        icon: 'lucide:scan-line',
        options: listed([
          'Listen 5 seconds and resume',
          'Listen until carrier disappears',
          'Stop scanning after receiving a signal',
        ]),
      },
    ],
  },
  {
    id: 'egzumer-audio',
    label: 'Audio and alerts',
    layouts: [EGZUMER_LAYOUT],
    fields: [
      {
        key: 'micGain',
        label: 'Microphone gain (Mic)',
        type: 'enum',
        icon: 'lucide:mic',
        options: listed(['+1.1 dB', '+4.0 dB', '+8.0 dB', '+12.0 dB', '+15.1 dB']),
      },
      { key: 'voxSwitch', label: 'VOX', type: 'bool', icon: 'lucide:mic' },
      {
        key: 'voxLevel',
        label: 'VOX level',
        type: 'int',
        min: 0,
        max: 9,
        help: 'Counted from zero: the radio shows this as 1 to 10.',
        icon: 'lucide:mic',
      },
      { key: 'buttonBeep', label: 'Key press beep (Beep)', type: 'bool', icon: 'lucide:volume-2' },
      {
        key: 'voice',
        label: 'Voice prompts',
        type: 'enum',
        icon: 'lucide:volume-2',
        options: listed(['Off', 'Chinese', 'English']),
      },
      {
        key: 'rogerBeep',
        label: 'End of transmission (Roger)',
        type: 'enum',
        icon: 'lucide:volume-2',
        options: listed(['Off', 'Roger beep', 'MDC data burst']),
      },
      { key: 'ste', label: 'Squelch tail elimination (STE)', type: 'bool', icon: 'lucide:signal' },
      {
        key: 'rpSte',
        label: 'Repeater squelch tail elimination (RP STE)',
        type: 'enum',
        icon: 'lucide:signal',
        options: listed([
          'Off', '100 ms', '200 ms', '300 ms', '400 ms', '500 ms',
          '600 ms', '700 ms', '800 ms', '900 ms', '1000 ms',
        ]),
      },
      {
        key: 'alarmMode',
        label: 'Alarm mode',
        type: 'enum',
        icon: 'lucide:triangle-alert',
        options: listed(['Site', 'Tone']),
      },
      { key: 'amFix', label: 'AM reception fix (AM Fix)', type: 'bool', icon: 'lucide:radio-tower' },
    ],
  },
  {
    id: 'egzumer-display',
    label: 'Display',
    layouts: [EGZUMER_LAYOUT],
    fields: [
      {
        key: 'channelDisplayMode',
        label: 'Channel display (ChDisp)',
        type: 'enum',
        icon: 'lucide:monitor',
        options: listed(['Frequency', 'Channel number', 'Name', 'Name + frequency']),
      },
      {
        key: 'powerOnDispmode',
        label: 'Power-on message (POnMsg)',
        type: 'enum',
        icon: 'lucide:power',
        options: listed(['Full screen test', 'User message', 'Battery voltage', 'None']),
      },
      { key: 'logoLine1', label: 'Message line 1', type: 'string', maxLength: 12, icon: 'lucide:type' },
      { key: 'logoLine2', label: 'Message line 2', type: 'string', maxLength: 12, icon: 'lucide:type' },
      {
        key: 'backlightTime',
        label: 'Backlight time (BackLt)',
        type: 'enum',
        icon: 'lucide:sun',
        options: listed(['Off', '5s', '10s', '20s', '1min', '2min', '4min', 'Always on']),
      },
      { key: 'backlightMin', label: 'Backlight level min (BLMin)', type: 'int', min: 0, max: 10, icon: 'lucide:sun' },
      { key: 'backlightMax', label: 'Backlight level max (BLMax)', type: 'int', min: 0, max: 10, icon: 'lucide:sun' },
      {
        key: 'backlightOnTxRx',
        label: 'Backlight on TX/RX (BltTRX)',
        type: 'enum',
        icon: 'lucide:sun',
        options: listed(['Off', 'TX', 'RX', 'TX/RX']),
      },
      {
        key: 'batteryText',
        label: 'Battery display (BatTXT)',
        type: 'enum',
        icon: 'lucide:zap',
        options: listed(['None', 'Voltage', 'Percentage']),
      },
      { key: 'micBar', label: 'Microphone bar (MicBar)', type: 'bool', icon: 'lucide:mic' },
      {
        key: 's0Level',
        label: 'S-meter S0 level',
        type: 'int',
        min: 90,
        max: 200,
        help: 'Stored as a positive magnitude; the radio reads it as that many dBm below zero.',
        icon: 'lucide:gauge',
      },
      {
        key: 's9Level',
        label: 'S-meter S9 level',
        type: 'int',
        min: 50,
        max: 160,
        help: 'Stored as a positive magnitude; the radio reads it as that many dBm below zero.',
        icon: 'lucide:gauge',
      },
    ],
  },
  {
    id: 'egzumer-keys',
    label: 'Keys',
    layouts: [EGZUMER_LAYOUT],
    description:
      'Which actions the side keys and the menu key run. Some of these do nothing unless the firmware ' +
      'was built with the matching feature, which the radio does not record anywhere this build can read.',
    fields: [
      { key: 'keyLock', label: 'Keypad locked', type: 'bool', icon: 'lucide:lock' },
      { key: 'autoKeypadLock', label: 'Auto keypad lock (KeyLck)', type: 'bool', icon: 'lucide:lock' },
      { key: 'key1ShortpressAction', label: 'Side key 1, short press (F1Shrt)', type: 'enum', icon: 'lucide:square-mouse-pointer', options: listed(KEY_ACTIONS) },
      { key: 'key1LongpressAction', label: 'Side key 1, long press (F1Long)', type: 'enum', icon: 'lucide:square-mouse-pointer', options: listed(KEY_ACTIONS) },
      { key: 'key2ShortpressAction', label: 'Side key 2, short press (F2Shrt)', type: 'enum', icon: 'lucide:square-mouse-pointer', options: listed(KEY_ACTIONS) },
      { key: 'key2LongpressAction', label: 'Side key 2, long press (F2Long)', type: 'enum', icon: 'lucide:square-mouse-pointer', options: listed(KEY_ACTIONS) },
      { key: 'keyMLongpressAction', label: 'Menu key, long press (M Long)', type: 'enum', icon: 'lucide:square-mouse-pointer', options: listed(KEY_ACTIONS) },
    ],
  },
  {
    id: 'egzumer-scan',
    label: 'Scan lists',
    layouts: [EGZUMER_LAYOUT],
    fields: [
      {
        key: 'scanListDefault',
        label: 'Default scan list (SList)',
        type: 'enum',
        icon: 'lucide:list',
        options: listed(['List 1', 'List 2', 'All channels']),
      },
      { key: 'scanList1PriorityEnable', label: 'List 1 priority scan', type: 'bool', icon: 'lucide:list' },
      { key: 'scanList1PriorityCh1', label: 'List 1 priority channel 1', type: 'int', min: 0, max: 255, help: PRIORITY_HELP, icon: 'lucide:list' },
      { key: 'scanList1PriorityCh2', label: 'List 1 priority channel 2', type: 'int', min: 0, max: 255, help: PRIORITY_HELP, icon: 'lucide:list' },
      { key: 'scanList2PriorityEnable', label: 'List 2 priority scan', type: 'bool', icon: 'lucide:list' },
      { key: 'scanList2PriorityCh1', label: 'List 2 priority channel 1', type: 'int', min: 0, max: 255, help: PRIORITY_HELP, icon: 'lucide:list' },
      { key: 'scanList2PriorityCh2', label: 'List 2 priority channel 2', type: 'int', min: 0, max: 255, help: PRIORITY_HELP, icon: 'lucide:list' },
    ],
  },
  {
    id: 'egzumer-dtmf',
    label: 'DTMF',
    layouts: [EGZUMER_LAYOUT],
    description:
      'The kill and revive codes are what a remote station can use to disable this radio. They are ' +
      'decoded and preserved so a backup is complete.',
    fields: [
      { key: 'dtmfSideTone', label: 'Sidetone on speaker (D ST)', type: 'bool', icon: 'lucide:hash' },
      {
        key: 'dtmfDecodeResponse',
        label: 'Decode response (D Resp)',
        type: 'enum',
        icon: 'lucide:hash',
        options: listed(['Do nothing', 'Local ringing', 'Replay response', 'Local ringing + reply response']),
      },
      { key: 'liveDtmfDecoder', label: 'Show decoded codes (D Live)', type: 'bool', icon: 'lucide:hash' },
      { key: 'dtmfAutoResetTime', label: 'Auto reset time (D Hold)', type: 'int', min: 5, max: 60, help: 'Seconds.', icon: 'lucide:clock' },
      { key: 'dtmfPreloadTime', label: 'Pre-load time (D Prel)', type: 'int', min: 3, max: 99, help: TENS_OF_MS, icon: 'lucide:clock' },
      { key: 'dtmfFirstCodePersistTime', label: 'First code persist time', type: 'int', min: 3, max: 100, help: TENS_OF_MS, icon: 'lucide:clock' },
      { key: 'dtmfHashPersistTime', label: '#/* persist time', type: 'int', min: 3, max: 100, help: TENS_OF_MS, icon: 'lucide:clock' },
      { key: 'dtmfCodePersistTime', label: 'Code persist time', type: 'int', min: 3, max: 100, help: TENS_OF_MS, icon: 'lucide:clock' },
      { key: 'dtmfCodeIntervalTime', label: 'Code interval time', type: 'int', min: 3, max: 100, help: TENS_OF_MS, icon: 'lucide:clock' },
      { key: 'dtmfSeparateCode', label: 'Separate code', type: 'string', maxLength: 1, icon: 'lucide:hash' },
      { key: 'dtmfGroupCallCode', label: 'Group call code', type: 'string', maxLength: 1, icon: 'lucide:hash' },
      { key: 'dtmfLocalCode', label: 'Local code (ANI ID)', type: 'string', maxLength: 3, icon: 'lucide:hash' },
      { key: 'dtmfUpCode', label: 'Up code', type: 'string', maxLength: 16, icon: 'lucide:hash' },
      { key: 'dtmfDownCode', label: 'Down code', type: 'string', maxLength: 16, icon: 'lucide:hash' },
      { key: 'dtmfPermitRemoteKill', label: 'Permit remote kill', type: 'bool', icon: 'lucide:shield-alert' },
      { key: 'dtmfKillCode', label: 'Kill code', type: 'string', maxLength: 5, icon: 'lucide:shield-alert' },
      { key: 'dtmfReviveCode', label: 'Revive code', type: 'string', maxLength: 5, icon: 'lucide:shield-alert' },
    ],
  },
  {
    id: 'egzumer-unlock',
    label: 'Transmit locks',
    layouts: [EGZUMER_LAYOUT],
    description:
      'What the firmware will let the radio transmit on. Transmitting outside the allocations your ' +
      'licence covers is illegal wherever you are, whatever the radio permits.',
    fields: [
      {
        key: 'intFlock',
        label: 'Transmit frequency lock (F Lock)',
        type: 'enum',
        icon: 'lucide:lock',
        options: listed([
          'Default+ (137-174, 400-470 + Tx200, Tx350, Tx500)',
          'FCC HAM (144-148, 420-450)',
          'CE HAM (144-146, 430-440)',
          'GB HAM (144-148, 430-440)',
          '137-174, 400-430',
          '137-174, 400-438',
          'Disable all',
          'Unlock all',
        ]),
      },
      { key: 'int200Tx', label: 'Unlock 174-350 MHz TX (Tx 200)', type: 'bool', icon: 'lucide:lock-open' },
      { key: 'int350Tx', label: 'Unlock 350-400 MHz TX (Tx 350)', type: 'bool', icon: 'lucide:lock-open' },
      { key: 'int500Tx', label: 'Unlock 500-600 MHz TX (Tx 500)', type: 'bool', icon: 'lucide:lock-open' },
      { key: 'int350En', label: 'Unlock 350-400 MHz RX (350 En)', type: 'bool', icon: 'lucide:lock-open' },
      { key: 'intScrEn', label: 'Scrambler enabled (ScraEn)', type: 'bool', icon: 'lucide:shield' },
      { key: 'intKilled', label: 'DTMF kill lock', type: 'bool', icon: 'lucide:shield-alert' },
    ],
  },
  {
    id: 'egzumer-fm',
    label: 'FM broadcast presets',
    layouts: [EGZUMER_LAYOUT],
    description:
      'The twenty broadcast stations the radio stores, in units of 100 kHz - 1013 is 101.3 MHz. ' +
      '65535 means the preset is empty, and so does anything outside 76 to 108 MHz.',
    fields: Array.from({ length: 20 }, (_, i) => ({
      key: `fmPreset${i + 1}`,
      label: `FM preset ${i + 1}`,
      type: 'int' as const,
      min: 0,
      max: 65_535,
      icon: 'lucide:radio-tower',
    })),
  },
] as const satisfies RadioSchema['settings']

/** `KEYACTIONS_LIST` in uvk5.py, which is not the egzumer list of the same name. */
const STOCK_KEY_ACTIONS = listed([
  'None', 'Flashlight on/off', 'Power select', 'Monitor', 'Scan on/off',
  'VOX on/off', 'Alarm on/off', 'FM radio on/off', 'Transmit 1750 Hz',
])
const STOCK_OFF_ON = listed(['Off', 'On'])

/**
 * The stock firmware's settings.
 *
 * Labels and option lists transcribed from CHIRP's `uvk5.py`, which is GPL-3.0.
 * Every group names the stock layout alone, for the same reason the egzumer
 * groups name theirs: the two firmwares keep their settings at different
 * addresses in different orders, and a group rendered for the wrong one is a
 * form full of controls that do not exist on the radio in front of the user.
 *
 * Two fields are decoded and deliberately not offered. `killed` is the DTMF
 * remote-kill flag, and the only thing setting it does is stop the radio
 * working. The eight password bytes at 0xE98 are not even modelled, so they
 * round-trip without boofwang ever showing or rewriting them.
 */
export const STOCK_SETTINGS_GROUPS = [
  {
    id: 'stock-radio',
    label: 'Radio',
    layouts: [STOCK_LAYOUT],
    fields: [
      { key: 'squelch', label: 'Squelch', type: 'int', min: 0, max: 9, icon: 'lucide:volume-2' },
      { key: 'batterySave', label: 'Battery save', type: 'enum', options: listed(['Off', '1:1', '1:2', '1:3', '1:4']) },
      {
        key: 'maxTalkTime',
        label: 'Transmit timeout',
        type: 'enum',
        options: [
          { value: 0, label: '30 sec' }, { value: 1, label: '1 min' }, { value: 2, label: '2 min' },
          { value: 3, label: '3 min' }, { value: 4, label: '4 min' }, { value: 5, label: '5 min' },
          { value: 6, label: '6 min' }, { value: 7, label: '7 min' }, { value: 8, label: '8 min' },
          { value: 9, label: '9 min' }, { value: 10, label: '15 min' },
        ],
      },
      { key: 'dualWatch', label: 'Dual watch', type: 'enum', options: listed(['Off', 'Band A', 'Band B']) },
      { key: 'crossband', label: 'Cross-band repeat', type: 'enum', options: listed(['Off', 'Band A', 'Band B']) },
      { key: 'vfoOpen', label: 'Frequency mode', type: 'enum', options: STOCK_OFF_ON },
      { key: 'noaaAutoscan', label: 'NOAA weather autoscan', type: 'enum', options: STOCK_OFF_ON },
      { key: 'callChannel', label: 'Call channel', type: 'int', min: 0, max: 199 },
    ],
  },
  {
    id: 'stock-audio',
    label: 'Audio',
    layouts: [STOCK_LAYOUT],
    fields: [
      { key: 'micGain', label: 'Microphone gain', type: 'int', min: 0, max: 4, icon: 'lucide:mic' },
      { key: 'beepControl', label: 'Key beep', type: 'enum', options: STOCK_OFF_ON },
      { key: 'keypadTone', label: 'Voice prompts', type: 'enum', options: listed(['Off', 'Chinese', 'English']) },
      { key: 'language', label: 'Menu language', type: 'enum', options: listed(['Chinese', 'English']) },
      { key: 'remindingOfEndTalk', label: 'End-of-transmission tone', type: 'enum', options: listed(['Off', 'Roger', 'MDC']) },
      { key: 'tailNoteElimination', label: 'Squelch tail elimination', type: 'enum', options: STOCK_OFF_ON },
      {
        key: 'repeaterTailElimination',
        label: 'Repeater tail elimination',
        type: 'enum',
        options: [{ value: 0, label: 'Off' }, ...Array.from({ length: 9 }, (_, i) => ({ value: i + 1, label: `${(i + 1) * 100} ms` }))],
      },
      { key: 'alarmMode', label: 'Alarm mode', type: 'enum', options: listed(['Site', 'Tone']) },
    ],
  },
  {
    id: 'stock-vox',
    label: 'VOX',
    layouts: [STOCK_LAYOUT],
    fields: [
      { key: 'voxSwitch', label: 'VOX', type: 'enum', options: STOCK_OFF_ON },
      { key: 'voxLevel', label: 'VOX level', type: 'int', min: 0, max: 9 },
    ],
  },
  {
    id: 'stock-display',
    label: 'Display',
    layouts: [STOCK_LAYOUT],
    fields: [
      { key: 'channelDisplayMode', label: 'Channel display', type: 'enum', options: listed(['Frequency', 'Channel number', 'Channel name']) },
      { key: 'powerOnDispMode', label: 'Power-on screen', type: 'enum', options: listed(['Full screen', 'Welcome message', 'Battery voltage']) },
      { key: 'backlightAutoMode', label: 'Backlight timeout', type: 'int', min: 0, max: 10 },
      { key: 'logoLine1', label: 'Welcome line 1', type: 'string', maxLength: 16 },
      { key: 'logoLine2', label: 'Welcome line 2', type: 'string', maxLength: 16 },
    ],
  },
  {
    id: 'stock-keys',
    label: 'Keys and scanning',
    layouts: [STOCK_LAYOUT],
    fields: [
      { key: 'keyLock', label: 'Keypad lock', type: 'enum', options: STOCK_OFF_ON },
      { key: 'autoKeypadLock', label: 'Automatic keypad lock', type: 'enum', options: STOCK_OFF_ON },
      { key: 'key1ShortpressAction', label: 'Side key 1, short press', type: 'enum', options: STOCK_KEY_ACTIONS },
      { key: 'key1LongpressAction', label: 'Side key 1, long press', type: 'enum', options: STOCK_KEY_ACTIONS },
      { key: 'key2ShortpressAction', label: 'Side key 2, short press', type: 'enum', options: STOCK_KEY_ACTIONS },
      { key: 'key2LongpressAction', label: 'Side key 2, long press', type: 'enum', options: STOCK_KEY_ACTIONS },
      {
        key: 'scanResumeMode',
        label: 'Scan resume',
        type: 'enum',
        options: listed(['After 5 seconds', 'When the signal goes', 'Stop on a signal']),
      },
      { key: 'scanlistDefault', label: 'Default scan list', type: 'enum', options: listed(['None', '1', '2', '1 and 2']) },
      { key: 'scanlist1PriorityScan', label: 'Scan list 1 priority', type: 'enum', options: STOCK_OFF_ON },
      { key: 'scanlist2PriorityScan', label: 'Scan list 2 priority', type: 'enum', options: STOCK_OFF_ON },
    ],
  },
  {
    id: 'stock-locks',
    label: 'Transmit locks',
    layouts: [STOCK_LAYOUT],
    description:
      'What the radio will let you transmit on. These are the firmware\u2019s own limits, and widening ' +
      'them does not widen your licence: what you may transmit is decided by the licence you hold and ' +
      'the rules where you are, not by this radio.',
    fields: [
      { key: 'flock', label: 'Frequency lock', type: 'enum', options: listed(['Off', 'FCC', 'CE', 'GB', '430 MHz', '438 MHz']) },
      { key: 'tx200', label: 'Transmit on 200 MHz', type: 'enum', options: STOCK_OFF_ON },
      { key: 'tx350', label: 'Transmit on 350 MHz', type: 'enum', options: STOCK_OFF_ON },
      { key: 'tx500', label: 'Transmit on 500 MHz', type: 'enum', options: STOCK_OFF_ON },
      { key: 'en350', label: 'Enable the 350 MHz band', type: 'enum', options: STOCK_OFF_ON },
      { key: 'enscramble', label: 'Enable scrambler', type: 'enum', options: STOCK_OFF_ON },
    ],
  },
] as const satisfies RadioSchema['settings']

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

  /**
   * Both layouts have their own, and every group names the one it belongs to.
   * The two firmwares keep their settings at different addresses in different
   * orders, so a group rendered for the wrong one would be a form full of
   * controls that do not exist on the radio in front of the user.
   */
  settings: [...EGZUMER_SETTINGS_GROUPS, ...STOCK_SETTINGS_GROUPS],
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
