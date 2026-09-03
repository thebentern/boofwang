// SPDX-License-Identifier: GPL-3.0-or-later
import type { Hz, Milliwatts } from '../model/units.js'
import type { Modulation, RadioId } from '../model/index.js'
import type { TransportKind } from '../transport/transport.js'

/**
 * A declarative description of what a radio can do.
 *
 * The point of making this data rather than code is that the UI becomes a pure
 * function of it: the channel table, the editors and the settings form all
 * render by iterating a schema. Adding a radio should touch `lib/radios/<id>/`
 * and one line of the registry, and nothing under `app/`. If a second or third
 * radio forces a UI change, that is a defect in this type, not in the UI.
 *
 * It maps onto CHIRP's `RadioFeatures` field for field, with two differences:
 * bands carry a `txAllowed` flag CHIRP has no equivalent for, and the DMR
 * feature block has no CHIRP analogue at all.
 */

export interface BandLimit {
  readonly loHz: Hz
  readonly hiHz: Hz
  readonly label: string
  /** False for receive-only allocations (broadcast, air band on most radios). */
  readonly txAllowed: boolean
}

export interface PowerLevel {
  readonly id: string
  readonly label: string
  readonly mW: Milliwatts
  /** The value stored in the radio's own field. */
  readonly raw: number
}

export type ToneMode = 'none' | 'tone' | 'tsql' | 'dtcs' | 'cross'
export type DuplexKind = 'simplex' | 'plus' | 'minus' | 'split' | 'off'

export interface FieldSpec {
  readonly key: string
  readonly label: string
  readonly help?: string
  readonly type: 'bool' | 'int' | 'enum' | 'string' | 'freq' | 'tone' | 'hex'
  readonly options?: readonly { readonly value: string | number; readonly label: string }[]
  readonly min?: number
  readonly max?: number
  readonly maxLength?: number
  /** Icon names used here must also be listed in nuxt.config's icon.clientBundle.icons. */
  readonly icon?: string
  /**
   * This setting holds a channel number, so renumbering channels must move it.
   *
   * Declared rather than guessed from the label. The DM-32UV's eight APRS
   * report channels are `int` fields between 0 and 4000 and nothing else about
   * them says they are pointers - so a sort that renumbered the bank left all
   * eight reporting on whatever channel had landed on their old number, which
   * reaches the radio because these bytes are written.
   *
   * A value the codeplug has no channel for is left exactly as it is: there is
   * no channel to follow. `planRenumber` reports those rather than moving them.
   */
  readonly channelRef?: boolean
}

export interface SettingGroup {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly fields: readonly FieldSpec[]
  /**
   * The image layouts this group applies to, when it does not apply to all of
   * them.
   *
   * One radio can have more than one EEPROM layout: the UV-K5 stores its
   * settings in one arrangement under stock firmware and a substantially
   * different one under egzumer, and the driver decides which by the firmware
   * string the radio reports. Without this, a group added for one of them
   * would be rendered for the other, where its keys decode to nothing - a form
   * full of controls that silently do not exist on the radio in front of the
   * user, which is exactly the failure the settings-schema test was written to
   * catch.
   *
   * Absent means "every layout", which is the right default for a radio that
   * only has one.
   */
  readonly layouts?: readonly string[]
}

/** The setting groups that apply to an image of `layout`, in schema order. */
export function settingsForLayout(schema: RadioSchema, layout: string | undefined): readonly SettingGroup[] {
  return schema.settings.filter((g) => !g.layouts || (layout !== undefined && g.layouts.includes(layout)))
}

export interface RadioSchema {
  readonly id: RadioId
  readonly vendor: string
  readonly model: string
  readonly aliases: readonly string[]
  readonly status: 'planned' | 'read-only' | 'beta' | 'stable'

  readonly capabilities: {
    readonly read: boolean
    readonly write: boolean

    /**
     * The carriers this radio can actually be reached over.
     *
     * A cable works on all four. Bluetooth is one radio and one profile so far:
     * the UV-5R Mini answers on an HM-10 style FFE0, established by enumerating
     * a real radio and sending it its own identify magic. Nobody has read a
     * service UUID off the other three, and `requestDevice` filters the chooser
     * on exactly that number, so offering Bluetooth for them opens a chooser
     * that lists nothing - indistinguishable from a radio that is switched off,
     * which is the failure this project has already misdiagnosed twice.
     *
     * Declared rather than inferred because nothing else says it: no codeplug,
     * no USB id and no other schema field tells the connect screen whether a
     * radio has a BLE module in it. A radio reachable through a clip-on
     * BLE-to-serial dongle does NOT belong here - that is `dongle` below,
     * because the dongle is the Bluetooth device and the radio is not.
     */
    readonly transports: readonly TransportKind[]
    /**
     * Which carriers this radio's write path is verified over.
     *
     * A subset of `transports`, and it exists because the two halves of the
     * write path disagreed about it for a day: one change taught the app to
     * reconnect over Bluetooth and offer the write, another taught the UV-5R
     * Mini driver to refuse one, and neither knew about the other - so the
     * write gate said allowed, the user typed WRITE, and the driver threw. The
     * gate explains and the driver enforces, and this is the single fact both
     * read so they cannot disagree again. Omitted means every carrier in
     * `transports`.
     *
     * Carrier, deliberately: a write over a BLE-to-UART dongle sends the
     * radio its verified cable bytes, but over a slower link that can drop
     * halfway, and no radio has survived one behind a dongle - so a radio
     * whose only wireless route is a dongle stays blocked for writing until
     * one does. The UV-5R Mini, which has a module of its own and has taken a
     * write over it, omits this field and writes over both.
     */
    readonly writeTransports?: readonly TransportKind[]
    /**
     * The physical programming jack a clip-on BLE-to-serial dongle fits,
     * when one does. 'k2' is the two-pin Kenwood plug the TIDRADIO BL-1
     * family clips onto.
     *
     * The radio behind a dongle is an ordinary cabled radio - it never knows
     * the cable became a radio link - so this is deliberately not an entry in
     * `transports`, which means "this radio has a BLE module of its own".
     * Absent means no dongle route is offered. This says the jack fits and
     * nothing more - whether a dongle carries THIS radio is `dongleProven`
     * below, and the two are not the same question. See
     * docs/protocols/ble-dongle.md.
     */
    readonly dongle?: 'k2'
    /**
     * Whether a codeplug has actually come off THIS radio through a dongle.
     *
     * Separate from the dongle profile's own `verified`, and the separation
     * is the point: the profile being proven says the GATT layout is a real
     * serial pipe, which it now is. It says nothing about a given radio
     * behind it. A Baofeng BT-A1D read a whole UV-5R Mini codeplug on
     * 2026-09-01 and drew nothing at all from a UV-82 on the same day, so
     * one flag cannot speak for both and the interface must not let it.
     */
    readonly dongleProven?: true
    /** Non-empty when writing needs an explicit per-feature unlock. */
    readonly writeRequiresUnlock?: string
    /**
     * Whether a write must send the entire image rather than only what changed.
     *
     * Some radios erase a flash page before programming and write back only the
     * block they were handed, so a sparse write silently wipes everything
     * sharing that page. Where this is set, the driver sends every block and
     * the confirmation has to say so - telling someone "1 block" while sending
     * the whole radio would be describing their edit rather than the write.
     */
    readonly writesWholeImage?: boolean

    /**
     * What a write can actually reach, in the user's words, when it is not
     * the whole codeplug.
     *
     * Used by the restore screen and the write gate, where "what will
     * actually be put back" is the question being asked. Deliberately not used
     * by the connect screen's chip: that grew to thirteen clauses and opened
     * with the word "Read" on a driver that writes.
     * Without saying so, editing something outside that on that radio looks
     * like it worked - the table updates, the write button lights up - and the
     * write then reports "nothing has changed", which is both false and
     * unhelpful.
     */
    readonly writeScope?: string
  }

  readonly memory: {
    readonly channelCount: number
    readonly firstIndex: number
    /** Named slots past the ordinary range - the UV-K5's 14 VFO pseudo-channels. */
    readonly specialChannels: readonly { readonly index: number; readonly name: string }[]
    readonly nameLength: number
    readonly nameCharset: string
    /** The byte an erased record is filled with. Explicit, because it differs per radio. */
    readonly eraseFill: number
  }

  readonly rf: {
    readonly bands: readonly BandLimit[]
    readonly modulations: readonly Modulation[]
    readonly bandwidths: readonly number[]
    readonly powerLevels: readonly PowerLevel[]
    /** In hertz, not kHz floats: integer comparison, no float equality traps. */
    readonly tuningSteps: readonly Hz[]
    readonly duplexes: readonly DuplexKind[]
    readonly toneModes: readonly ToneMode[]
    readonly ctcssDeciHz: readonly number[]
    readonly dtcsCodes: readonly number[]
    readonly canSkip: boolean
    readonly hasRxDtcs: boolean
    readonly hasCtone: boolean
    /**
     * Whether a single channel can be marked receive-only.
     *
     * `false` means an RX-only channel cannot be honoured and must be refused
     * rather than programmed as transmit-capable. `mechanism` records how it is
     * achieved when it can be, since not every radio has a dedicated bit - the
     * UV-K5 has none, and instead parks the transmit frequency at 0 MHz.
     */
    readonly txInhibit: false | { readonly mechanism: string }
  }

  readonly features: {
    readonly dmr: false | { readonly colorCodes: readonly [number, number]; readonly timeslots: 1 | 2 }
    readonly zones: false | { readonly max: number; readonly channelsPer: number; readonly nameLength: number }
    readonly talkGroups: false | { readonly max: number; readonly nameLength: number }
    readonly contacts: false | { readonly max: number }
    readonly rxGroups: false | { readonly max: number }
    readonly scanLists: false | { readonly max: number; readonly channelsPer: number }
    /**
     * The radio's own DMR identities.
     *
     * `nameLength` and `maxId` are here rather than in the driver because three
     * separate places need them and two of them are outside `lib/radios/`: the
     * DMR editor's input limits, and the fleet roster, which has to say whether
     * a club's spreadsheet fits the radio before anyone plugs one in. Both were
     * literals typed into a form, which is how a fourth place gets a different
     * answer.
     */
    readonly radioIds: false | { readonly max: number; readonly nameLength: number; readonly maxId: number }
    /**
     * Canned text messages, when the radio stores them.
     *
     * A feature flag rather than "does this codeplug happen to have any": a
     * radio with none still needs somewhere to add the first, and a radio that
     * has no such memory must not be offered the control at all. Without this
     * the messages panel appeared for every radio, and on one that cannot store
     * them a typed message was accepted and then dropped by the encoder.
     */
    readonly messages: false | { readonly max: number; readonly maxChars: number }
    readonly encryption:
      | false
      | { readonly slots: number; readonly types: readonly string[]; readonly nameLength: number }
  }

  /** Per-radio channel fields with no cross-radio meaning; rendered generically. */
  readonly extraFields: readonly FieldSpec[]
  readonly settings: readonly SettingGroup[]
}

/** Is `f` inside any band this radio covers? */
export function bandFor(schema: RadioSchema, f: Hz): BandLimit | null {
  for (const b of schema.rf.bands) {
    if (f >= b.loHz && f <= b.hiHz) return b
  }
  return null
}

/** The power level closest to, but not exceeding, `target`. */
export function clampPower(schema: RadioSchema, target: Milliwatts): PowerLevel {
  const levels = [...schema.rf.powerLevels].sort((a, b) => a.mW - b.mW)
  let best = levels[0]!
  for (const l of levels) {
    if (l.mW <= target) best = l
  }
  return best
}
