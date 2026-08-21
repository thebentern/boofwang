// SPDX-License-Identifier: GPL-3.0-or-later
import type { Hz, Milliwatts } from '../model/units.js'
import type { Modulation, RadioId } from '../model/index.js'

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
}

export interface SettingGroup {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly fields: readonly FieldSpec[]
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
     * The DM-32UV reaches nearly everything it decodes. What it does not reach
     * - roaming zone membership, the emergency systems, the DTMF and analog
     * contact lists, and the blocks nothing has decoded - is the short half,
     * which is what `writeExcept` is for.
     * Without saying so, editing something outside that on that radio looks
     * like it worked - the table updates, the write button lights up - and the
     * write then reports "nothing has changed", which is both false and
     * unhelpful.
     */
    readonly writeScope?: string
    /**
     * What a write does *not* reach, in the user's words.
     *
     * The complement of `writeScope`, and worth having separately because the
     * two grow in opposite directions: as a driver matures its scope becomes a
     * long list and its exclusions become a short one. The connect screen's
     * one-line chip wants the short one - "Read · channels, zones, talk groups,
     * scan lists, RX groups, contacts, radio settings and encryption keys only"
     * both reads as read-only and squeezes the radio's name off the row.
     */
    readonly writeExcept?: string
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
    readonly radioIds: false | { readonly max: number }
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
