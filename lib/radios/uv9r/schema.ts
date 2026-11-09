// SPDX-License-Identifier: GPL-3.0-or-later
import { hz, mW } from '../../model/units.js'
import { CTCSS_DECIHZ } from '../../model/tones.js'
import type { RadioSchema } from '../../radio/schema.js'
import { UV82_SCHEMA, UV82_SERIAL } from '../uv82/schema.js'
import { CHANNEL_COUNT, NAME_LENGTH, POWER_RAW, TUNING_STEPS_HZ, VALID_BANDS, WP970I_DTCS } from './layout.js'
import { BAUD_RATE } from './protocol.js'

/**
 * `VALID_CHARS` on `WP970I`: CHIRP's `CHARSET_ALPHANUMERIC` - which, unlike
 * the UV-5R family's charset, includes lower case - plus a fixed set of
 * punctuation.
 */
const CHARSET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz 1234567890' + '!@#$%^&*()+-=[]:";\'<>?,./'

const OFF_ON = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'On' },
]
const list = (labels: readonly string[]) => labels.map((label, value) => ({ value, label }))
const offThen = (labels: readonly string[]) => list(['Off', ...labels])
const oneTo = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1))

/**
 * Labels and option lists transcribed from `get_settings` on `WP970I` in
 * CHIRP's `baofeng_wp970i.py` (GPL-3.0), which the UV-9R and the UV-9G inherit.
 *
 * The keys are the UV-82's, because the bytes are: the settings block is the
 * same struct at the same radio address, so `squelch` and `f2a.fmradio` name
 * the same bits on both families. The option lists are this family's, and
 * they are not all the UV-82's. The backlight timer here is Off and 1-10 where
 * the UV-82 form takes 0-24, and the transmit timer stops at 600 seconds with
 * no Off entry, because those are the lists `get_settings` builds.
 *
 * Only what CHIRP offers on this family. `bcl`, `rogerrx`, `singleptt` and
 * `vfomrlock` are in the struct and decoded, but `WP970I.get_settings` offers
 * none of them, so neither does this - a control for a byte the reference does
 * not present is a guess about what that byte does on this radio. `step`,
 * `band`, `sftd` and `tdrch` are left out for the reason the UV-82 leaves them
 * out: CHIRP drives them from the VFO records. Everything CHIRP keeps outside
 * the settings block - VFO frequencies, the band limits, the PTT ID and ANI
 * codes, the power-on message, the service squelch tables - is outside what
 * this driver claims, and so is outside this form.
 */
export const WP970I_SETTINGS_GROUPS = [
  {
    id: 'radio',
    label: 'Radio',
    fields: [
      {
        key: 'squelch',
        label: 'Squelch level',
        type: 'enum',
        icon: 'lucide:volume-2',
        options: offThen(oneTo(9)),
      },
      { key: 'save', label: 'Battery saver', type: 'enum', options: list(['Off', '1:1', '1:2', '1:3', '1:4']) },
      {
        key: 'timeout',
        label: 'Transmit timeout',
        type: 'enum',
        options: Array.from({ length: 40 }, (_, i) => ({ value: i, label: `${15 + i * 15} sec` })),
      },
      { key: 'f2a.fmradio', label: 'Broadcast FM radio', type: 'enum', options: OFF_ON },
      { key: 'tdr', label: 'Dual watch', type: 'enum', options: OFF_ON },
      { key: 'tdrab', label: 'Dual watch transmit priority', type: 'enum', options: list(['Off', 'A', 'B']) },
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    fields: [
      { key: 'beep', label: 'Key beep', type: 'enum', options: OFF_ON },
      { key: 'voice', label: 'Voice prompts', type: 'enum', options: list(['Off', 'English', 'Chinese']) },
      { key: 'roger', label: 'Roger beep', type: 'enum', options: OFF_ON },
      { key: 'ste', label: 'Squelch tail eliminate, radio to radio', type: 'enum', options: OFF_ON },
      { key: 'rpste', label: 'Squelch tail eliminate, repeater', type: 'enum', options: offThen(oneTo(10)) },
      {
        key: 'rptrl',
        label: 'Squelch tail repeater delay',
        type: 'enum',
        options: offThen(Array.from({ length: 10 }, (_, i) => `${(i + 1) * 100} ms`)),
      },
    ],
  },
  {
    id: 'vox',
    label: 'VOX',
    fields: [{ key: 'vox', label: 'VOX sensitivity', type: 'enum', icon: 'lucide:mic', options: offThen(oneTo(10)) }],
  },
  {
    id: 'display',
    label: 'Display',
    fields: [
      { key: 'abr', label: 'Backlight timeout', type: 'enum', options: offThen(oneTo(10)) },
      { key: 'wtled', label: 'Standby LED color', type: 'enum', options: list(['Off', 'Blue', 'Orange', 'Purple']) },
      { key: 'rxled', label: 'Receive LED color', type: 'enum', options: list(['Off', 'Blue', 'Orange', 'Purple']) },
      { key: 'txled', label: 'Transmit LED color', type: 'enum', options: list(['Off', 'Blue', 'Orange', 'Purple']) },
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

/**
 * Busy channel lockout, PTT ID and its code: `mem.extra` in baofeng_common.py,
 * from the same three bit fields the UV-82 exposes.
 *
 * The first two are the UV-82's controls. The code is this family's list:
 * `SCODE_LIST` is fifteen entries, "1" to "15", for stored values 0 to 14, and
 * CHIRP has nothing to show for a 15. The UV-82's control takes 0 to 15, which
 * would let a value onto this radio that its own reference cannot name.
 */
const WP970I_EXTRA_FIELDS: RadioSchema['extraFields'] = [
  ...UV82_SCHEMA.extraFields.filter((f) => f.key !== 'scode'),
  {
    key: 'scode',
    label: 'PTT ID code',
    type: 'enum',
    options: Array.from({ length: 15 }, (_, i) => ({ value: i, label: String(i + 1) })),
    icon: 'lucide:hash',
  },
]

/**
 * The parts of a schema every member of the family shares.
 *
 * A member supplies its identity, its band plan and its power table; the
 * memory, the tones and the channel extras are the family's, because the
 * channel record and the settings block are the same bytes on every one.
 */
export function wp970iSchema(member: {
  readonly id: RadioSchema['id']
  readonly vendor: string
  readonly model: string
  readonly aliases: readonly string[]
  readonly bands: RadioSchema['rf']['bands']
  readonly powerLevels: RadioSchema['rf']['powerLevels']
}): RadioSchema {
  return {
    id: member.id,
    vendor: member.vendor,
    model: member.model,
    aliases: member.aliases,
    // Every schema ships read-only; the registry is where writing is turned
    // on. See lib/radio/registry.ts and docs/protocols/uv9r.md.
    status: 'read-only',

    /*
     * A cable and nothing else.
     *
     * No `dongle`: these radios are sold waterproof, and the programming jack
     * is a screw-in connector rather than the two-pin Kenwood plug a clip-on
     * BLE-to-serial dongle is made for. CHIRP issue 9837 is a UV-9R Plus whose
     * owner had the wrong shroud on an otherwise correct cable; the connector
     * is the first thing to suspect on this radio, before the driver.
     *
     * `writesWholeImage` because CHIRP never writes these radios sparsely:
     * `_upload` sends contiguous `_ranges`, and that sequence is the only one
     * reported working on one. So every write sweeps all three owned ranges -
     * which the confirmation has to say, because it is not the size of the
     * edit - and no boofwang write has ever told us a diff is safe here.
     */
    capabilities: { read: true, write: false, transports: ['serial'], writesWholeImage: true },

    memory: {
      channelCount: CHANNEL_COUNT,
      firstIndex: 1,
      specialChannels: [],
      nameLength: NAME_LENGTH,
      nameCharset: CHARSET,
      eraseFill: 0xff,
    },

    rf: {
      bands: member.bands,
      modulations: ['FM'],
      bandwidths: [25_000, 12_500],
      powerLevels: member.powerLevels,
      tuningSteps: TUNING_STEPS_HZ.map((s) => hz(s)),
      duplexes: ['simplex', 'plus', 'minus', 'split'],
      toneModes: ['none', 'tone', 'tsql', 'dtcs', 'cross'],
      ctcssDeciHz: CTCSS_DECIHZ,
      dtcsCodes: WP970I_DTCS,
      canSkip: true,
      hasRxDtcs: true,
      hasCtone: true,
      /*
       * No inhibit bit: the record stores an absolute transmit frequency, and
       * filling it with 0xFF is how CHIRP's `set_memory` writes duplex "off".
       * `_is_txinh` in baofeng_common.py reads a 0x00 filling as receive-only
       * too; the encoder still writes only 0xFF, and passes a zero filling on
       * only in a record it did not change.
       */
      txInhibit: { mechanism: 'Transmit frequency filled with 0xFF' },
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

    extraFields: WP970I_EXTRA_FIELDS,

    settings: WP970I_SETTINGS_GROUPS,
  }
}

/** Both of `VALID_BANDS`, as transmit-capable bands. */
const FULL_BANDS: RadioSchema['rf']['bands'] = VALID_BANDS.map(([lo, hi]) => ({
  loHz: hz(lo),
  hiHz: hz(hi),
  label: `${lo / 1e6}-${hi / 1e6} MHz`,
  txAllowed: true,
}))

export const UV9R_SCHEMA: RadioSchema = wp970iSchema({
  id: 'uv9r',
  vendor: 'Baofeng',
  model: 'UV-9R',
  /*
   * The names that have answered this radio's magic.
   *
   * CHIRP lists the UV-9R Pro as an alias of its BF-A58 class, which is this
   * memory layout behind this magic, and a factory UV-9R Pro image on CHIRP's
   * tracker carries the same ident bytes as a 2017 UV-9R. The UV-9R Plus is
   * read by CHIRP as a UV-9R, or as a UV-82WP - the same magic again.
   *
   * Not every radio sold under these names is this radio. Later UV-9R Plus
   * and UV-9R Pro units have been reported silent to this protocol (CHIRP
   * issue 10270), and one is listed with 200 channels, which this layout
   * cannot hold. A radio that does not acknowledge the magic is not this one,
   * whatever the box says.
   */
  aliases: ['UV-9R Plus', 'UV-9R Pro'],
  bands: FULL_BANDS,
  powerLevels: [
    // `POWER_LEVELS` on `WP970I`, which `UV9R` keeps: 5, 3 and 1 W, matching
    // what Baofeng publishes for the UV-9R. Only the two-bit selector is
    // stored; the wattages are labels.
    { id: 'high', label: 'High', mW: mW(5000), raw: POWER_RAW.high },
    { id: 'med', label: 'Med', mW: mW(3000), raw: POWER_RAW.med },
    { id: 'low', label: 'Low', mW: mW(1000), raw: POWER_RAW.low },
  ],
})

export const UV9R_SERIAL = {
  ...UV82_SERIAL,
  baudRate: BAUD_RATE,
  // CHIRP opens every radio with DTR and RTS asserted (`WANTS_DTR` and
  // `WANTS_RTS` default true). boofwang holds both low on every radio, because
  // the two-pin Kenwood cables reset the radio when either is raised, and that
  // has been verified on the UV-5R family's cables. Nobody has tried either
  // level on a UV-9R cable; low is kept so every driver opens the same way.
  signals: { dataTerminalReady: false, requestToSend: false },
} as const
