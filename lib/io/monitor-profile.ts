// SPDX-License-Identifier: GPL-3.0-or-later
import { serviceFor, type BandService } from '../model/bands.js'
import type { Channel, Modulation } from '../model/channel.js'
import {
  sortedChannels,
  type Codeplug,
  type EncryptionType,
  type RadioId,
  type TalkGroup,
} from '../model/codeplug.js'
import { encryptionLegality, isBlankKey } from '../model/encryption.js'
import { formatFreq } from '../model/units.js'

/**
 * A codeplug described for a receiver rather than for a radio.
 *
 * For SDR receive testing: program a radio, point a decoder at what it
 * transmits, and check that what comes out is what was programmed. That takes
 * two files, because the two halves deserve different handling.
 *
 * The **profile** says where to listen and what to expect - the frequency, the
 * color code and slot, the talk group, and which key slot an encrypted channel
 * uses. It carries **no key material in any form**: not the key, not a masked
 * key, and not the name of a slot, for the reason `summary.ts` gives - a slot
 * called "SHERIFF TAC" says what a channel is for without disclosing a byte of
 * it. The profile is the half that gets left on a bench laptop and pasted into
 * an issue, so it is built so that doing that costs nothing.
 *
 * The **keys** file is the other half, and it is the radio's secrets in clear.
 * It holds only the slots an exported channel uses, never the whole table:
 * profiling three test channels must not also hand over the nineteen keys
 * nobody asked about. It carries no slot names either, because a decoder needs
 * a number and a key, and a name only adds what the key is for.
 *
 * Both are drawn from one plan, so the keys file cannot cover a channel the
 * profile left out. Nothing reads either back in, and nothing ever will be
 * able to program a radio from one: they describe a radio, they are not a
 * codeplug.
 */

export const MONITOR_PROFILE_SCHEMA = 'boofwang.monitor-profile/1'
export const MONITOR_KEYS_SCHEMA = 'boofwang.monitor-keys/1'

/**
 * The `extras.vendor` keys read here, and the only ones.
 *
 * The DM-32UV's names, as its `decodeChannel` writes them and as
 * `DIGITAL_VENDOR_KEYS` in `lib/radio/translate.ts` lists them. Each is read by
 * name rather than by spreading the record, because `extras.vendor` is where a
 * driver hangs the key slot a channel uses, and a spread would carry whatever a
 * future driver decides to hang there next.
 */
export const MONITOR_VENDOR_KEYS = [
  'colorCode',
  'timeSlot',
  'txContact',
  'encryptionKeyId',
  'encryptEnabled',
] as const

/**
 * What a key slot is called on the air, once somebody has watched it happen.
 *
 * An encrypted DMR call names its key with a key ID and its cipher with an
 * algorithm ID, both in signaling a decoder can see. Nothing establishes that
 * either is the slot number the CPS shows. The radio could send the slot, the
 * slot minus one, the id byte at the head of the key record, or something else
 * entirely, and the algorithm numbering is the vendor's, unpublished. Guessing
 * one would put a confident wrong number in front of the person trying to find
 * out, so a profile says `null` until a row here says otherwise.
 *
 * Rows come from the calibration table in `docs/protocols/dm32uv.md`, under
 * "Over-the-air key IDs": one transmission per slot and type, the key ID and
 * algorithm ID read off the decoder. Add only a pair that was observed. A
 * pattern that holds for three slots is a hypothesis about the fourth, and
 * this table is where it would stop looking like one.
 */
export interface AirKeyId {
  readonly radio: RadioId
  readonly slot: number
  readonly type: EncryptionType
  /** The key ID the radio was heard sending. */
  readonly kid: number
  /** The algorithm ID the radio was heard sending. */
  readonly algId: number
}

export const AIR_KEY_IDS: readonly AirKeyId[] = []

/**
 * The observed identity of a slot, or null when nobody has observed it.
 *
 * Looked up with the slot's type as well as its number, because the algorithm
 * ID belongs to the cipher: a row recorded for slot 3 holding an AES-256 key
 * says nothing about slot 3 after somebody re-keys it as ARC4.
 */
export function airKeyIdFor(
  radio: RadioId | null,
  slot: number,
  type: EncryptionType,
  table: readonly AirKeyId[] = AIR_KEY_IDS,
): AirKeyId | null {
  return table.find((r) => r.radio === radio && r.slot === slot && r.type === type) ?? null
}

export interface MonitorChannel {
  readonly index: number
  readonly name: string
  readonly rxHz: number
  readonly modulation: Modulation
  readonly bandwidthHz: number
  /** Null on an analog channel, or a digital one whose source did not say. */
  readonly colorCode: number | null
  readonly timeSlot: 1 | 2 | null
  /** The DMR number the channel transmits to, not the radio's slot for it. */
  readonly txTalkGroup: number | null
  /** Always null today: unknown, not none. See `toMonitorChannel`. */
  readonly rxGroup: string | null
  /** The radio's key slot, which is not known to be the key ID it sends. */
  readonly keySlot: number | null
  readonly service: BandService
}

export interface MonitorTalkGroup {
  readonly number: number
  readonly name: string
  readonly callType: TalkGroup['callType']
}

export interface MonitorRxGroup {
  readonly name: string
  /** DMR numbers, which is how the DM-32UV stores members. */
  readonly members: readonly number[]
}

export interface MonitorKeySlot {
  readonly slot: number
  /** `none` when a channel names a slot that holds no key. */
  readonly type: EncryptionType
  readonly airKid: number | null
  readonly airAlgId: number | null
}

export interface MonitorProfile {
  readonly schema: typeof MONITOR_PROFILE_SCHEMA
  readonly radio: RadioId | null
  readonly variant: string | null
  /** ISO 8601. */
  readonly exportedAt: string
  readonly channels: readonly MonitorChannel[]
  readonly talkGroups: readonly MonitorTalkGroup[]
  readonly rxGroups: readonly MonitorRxGroup[]
  readonly keySlots: readonly MonitorKeySlot[]
}

export interface MonitorKey {
  readonly slot: number
  readonly type: EncryptionType
  /** Uppercase hex, no separators, exactly as the codeplug holds it. */
  readonly keyHex: string
}

export interface MonitorKeys {
  readonly schema: typeof MONITOR_KEYS_SCHEMA
  readonly radio: RadioId | null
  readonly variant: string | null
  /** ISO 8601. */
  readonly exportedAt: string
  readonly keys: readonly MonitorKey[]
}

/** An encrypted channel left out because encryption is unlawful where it is. */
export interface MonitorWarning {
  readonly index: number
  readonly name: string
  readonly rxHz: number
  readonly service: string
  /** One sentence or two, for a person. */
  readonly message: string
}

export interface MonitorOptions {
  /** Analog channels too. Off by default: the profile is for a DMR decoder. */
  readonly includeAnalog?: boolean
  /** ISO 8601. Supplied by the caller so a test can pin it. */
  readonly exportedAt?: string
}

export interface MonitorPlan {
  /** What the profile carries, in slot order. */
  readonly channels: readonly MonitorChannel[]
  readonly warnings: readonly MonitorWarning[]
  /**
   * Every key slot an exported channel uses, ascending. The keys file draws on
   * these and nothing else.
   */
  readonly keySlots: readonly number[]
}

export interface MonitorKeysPlan {
  /** Slots whose key goes into the file, ascending. */
  readonly exported: readonly number[]
  /** Slots an exported channel uses that hold no usable key: empty, or zeros. */
  readonly withoutKey: readonly number[]
}

/*
 * Analog for this purpose. The digital modes other than DMR have no color
 * code, slot or talk group to describe and no radio here produces them, so
 * they are left out either way rather than passed off as analog.
 */
const ANALOG: ReadonlySet<Modulation> = new Set<Modulation>(['FM', 'AM', 'USB', 'LSB', 'CW'])

/** A vendor field as an integer, or null when it is absent or is not one. */
function intField(vendor: Readonly<Record<string, string>>, key: (typeof MONITOR_VENDOR_KEYS)[number]): number | null {
  const raw = vendor[key]
  // `Number('')` is 0, which would turn a blank field into color code 0.
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isInteger(n) ? n : null
}

/**
 * The key slot a channel encrypts with, or null when it does not encrypt.
 *
 * Both halves are required: the enable bit and a slot. The DM-32UV keeps them
 * in different bytes - bit 6 of 0x1F and all of 0x1E - and qdmr links a
 * channel's key only when both are present. Requiring both is the reading that
 * never claims a channel is encrypted on the strength of one byte. Where those
 * bytes are rests on two radios and qdmr, not on the air: no channel has been
 * heard encrypting with the slot it names, which is exactly what a monitor
 * session can find out.
 *
 * DMR only. On an analog channel 0x1F is PTT ID settings and 0x1E is
 * unexplained, so the driver reads such a channel as unencrypted. A channel
 * switched to FM in the editor still carries the vendor fields it had as DMR,
 * and reading them here would invent encryption on it.
 */
function keySlotOf(c: Channel): number | null {
  if (c.modulation !== 'DMR') return null
  const vendor = c.extras.vendor ?? {}
  const enabled = intField(vendor, 'encryptEnabled')
  if (enabled === null || enabled === 0) return null
  const slot = intField(vendor, 'encryptionKeyId')
  return slot !== null && slot >= 1 ? slot : null
}

/**
 * Talk groups by the physical slot a channel's `txContact` names.
 *
 * Not by position in the list: the DM-32UV's bank has gaps - slots 2, 5, 8 and
 * 9 are wiped records - so the nth talk group is not slot n. The slot comes
 * from the record id, `tg-<block>-<n>`, recovered the way the channel editor,
 * the DMR page and the driver's own validator recover it. A profile that
 * resolved it some other way would name a different talk group than every
 * screen does. An id of any other shape resolves to nothing, and says null.
 */
const TALK_GROUP_ID = /^tg-[0-9a-fx]+-(\d+)$/

function talkGroupsBySlot(cp: Codeplug): ReadonlyMap<number, TalkGroup> {
  const out = new Map<number, TalkGroup>()
  for (const g of cp.talkGroups) {
    const m = TALK_GROUP_ID.exec(g.id)
    // First wins, as `find` does on the screens that show the same lookup.
    if (m && !out.has(Number(m[1]))) out.set(Number(m[1]), g)
  }
  return out
}

/**
 * One channel, from an explicit list of fields.
 *
 * Written out field by field rather than spread from the channel, for the
 * reason `summary.ts` gives: a spread would start carrying whatever a future
 * driver hangs off `extras`, and on the DM-32UV that is already the key slot.
 */
function toMonitorChannel(c: Channel, keySlot: number | null, talkGroups: ReadonlyMap<number, TalkGroup>): MonitorChannel {
  const digital = c.modulation === 'DMR'
  const vendor = c.extras.vendor ?? {}
  const colorCode = digital ? intField(vendor, 'colorCode') : null
  const timeSlot = digital ? intField(vendor, 'timeSlot') : null
  const contact = digital ? intField(vendor, 'txContact') : null

  return {
    index: c.index,
    name: c.name,
    rxHz: c.rxFreq,
    modulation: c.modulation,
    bandwidthHz: c.bandwidthHz,
    colorCode: colorCode !== null && colorCode >= 0 && colorCode <= 15 ? colorCode : null,
    timeSlot: timeSlot === 1 || timeSlot === 2 ? timeSlot : null,
    // Slot 0 is "no talk group", the value the editor writes for none. A slot
    // that holds no talk group is null too: the validator already says that
    // channel transmits to an empty slot, and a second warning here would be
    // the same fact in a place nobody looks for it.
    txTalkGroup: contact === null || contact === 0 ? null : (talkGroups.get(contact)?.number ?? null),
    /*
     * Always null, and deliberately not "none". The reference puts a digital
     * channel's RX group list at byte 0x1F, bits 5-0, and the DM-32UV driver
     * reads only bit 6 of that byte, which is encryption, and carries the
     * rest through untouched - so no codeplug has an answer to give here yet.
     * Decoding it is a driver change with a write-path consequence: a field
     * that is read and never written lets the document claim a group the
     * radio does not hold, the first time a channel is copied into another
     * slot. Read null as unknown.
     */
    rxGroup: null,
    keySlot,
    service: serviceFor(c.rxFreq).service,
  }
}

/**
 * Which channels go into the files, and which are left out and why.
 *
 * An encrypted channel where encryption is not lawful - amateur, GMRS, MURS,
 * and the receive-only weather and air channels - is left out of both files
 * and reported instead. The channel editor refuses to give such a channel a
 * key, but a radio programmed by anything else can arrive holding one, and the
 * radio encrypts there regardless. A monitor profile would be a working set of
 * instructions for decrypting that traffic, and on those bands that is not a
 * test of a license anybody holds. Whether a key reaches the keys file follows
 * from this, because the keys come only from the channels that stay.
 */
export function planMonitorExport(cp: Codeplug, opts: MonitorOptions = {}): MonitorPlan {
  const talkGroups = talkGroupsBySlot(cp)
  const channels: MonitorChannel[] = []
  const warnings: MonitorWarning[] = []

  for (const c of sortedChannels(cp)) {
    const wanted = c.modulation === 'DMR' || (opts.includeAnalog === true && ANALOG.has(c.modulation))
    if (!wanted) continue

    const keySlot = keySlotOf(c)
    if (keySlot !== null) {
      const legality = encryptionLegality(c.rxFreq)
      if (!legality.allowed) {
        const who = c.name ? `Channel ${c.index}, ${c.name},` : `Channel ${c.index}`
        warnings.push({
          index: c.index,
          name: c.name,
          rxHz: c.rxFreq,
          service: legality.service,
          message:
            `${who} is encrypted on ${formatFreq(c.rxFreq)} MHz and is left out of the monitor files. ` +
            legality.reason +
            (legality.cfr === undefined ? '' : ` ${legality.cfr}.`),
        })
        continue
      }
    }
    channels.push(toMonitorChannel(c, keySlot, talkGroups))
  }

  const keySlots = [...new Set(channels.flatMap((c) => (c.keySlot === null ? [] : [c.keySlot])))]
  return { channels, warnings, keySlots: keySlots.sort((a, b) => a - b) }
}

/**
 * The firmware the codeplug came from, or null when nothing recorded one.
 *
 * A DM-32UV opened from a raw `.bin` arrives with an empty string, because a
 * flat file has nowhere to say which firmware wrote it. Null says that; an
 * empty string reads like a firmware whose name is blank.
 */
function variantOf(cp: Codeplug): string | null {
  return cp.meta.variant === undefined || cp.meta.variant === '' ? null : cp.meta.variant
}

export function buildMonitorProfile(cp: Codeplug, opts: MonitorOptions = {}): string {
  const plan = planMonitorExport(cp, opts)

  // The type of each slot and nothing else about it. This path never reads a
  // key or a slot's name, which is what the tests beside it hold it to.
  const types = new Map(cp.encryptionKeys.map((k) => [k.slot, k.type] as const))

  const profile: MonitorProfile = {
    schema: MONITOR_PROFILE_SCHEMA,
    radio: cp.radio,
    variant: variantOf(cp),
    exportedAt: opts.exportedAt ?? new Date().toISOString(),
    channels: plan.channels,
    talkGroups: cp.talkGroups.map((g) => ({ number: g.number, name: g.name, callType: g.callType })),
    rxGroups: cp.rxGroups.map((g) => ({ name: g.name, members: [...g.dmrIds] })),
    keySlots: plan.keySlots.map((slot) => {
      const type = types.get(slot) ?? 'none'
      const air = airKeyIdFor(cp.radio, slot, type)
      return { slot, type, airKid: air?.kid ?? null, airAlgId: air?.algId ?? null }
    }),
  }
  return `${JSON.stringify(profile, null, 2)}\n`
}

/**
 * Whether a slot holds a key worth handing to a decoder.
 *
 * A slot of zeros is skipped along with the empty ones. It is what a redacted
 * capture holds - the committed DM-32UV capture is twenty-two of them - and
 * what a cleared slot reads as. Either way the zeros are not a key anybody
 * chose, and a keys file is a statement that these are the keys to try.
 */
function usable(key: { readonly type: EncryptionType; readonly keyHex: string }): boolean {
  return key.type !== 'none' && key.keyHex !== '' && !isBlankKey(key.keyHex)
}

export function planMonitorKeys(cp: Codeplug, opts: MonitorOptions = {}): MonitorKeysPlan {
  const bySlot = new Map(cp.encryptionKeys.map((k) => [k.slot, k] as const))
  const exported: number[] = []
  const withoutKey: number[] = []
  for (const slot of planMonitorExport(cp, opts).keySlots) {
    const key = bySlot.get(slot)
    if (key !== undefined && usable(key)) exported.push(slot)
    else withoutKey.push(slot)
  }
  return { exported, withoutKey }
}

export function buildMonitorKeys(cp: Codeplug, opts: MonitorOptions = {}): string {
  const bySlot = new Map(cp.encryptionKeys.map((k) => [k.slot, k] as const))
  const keys: MonitorKey[] = []
  for (const slot of planMonitorKeys(cp, opts).exported) {
    const key = bySlot.get(slot)!
    keys.push({ slot, type: key.type, keyHex: key.keyHex })
  }

  const file: MonitorKeys = {
    schema: MONITOR_KEYS_SCHEMA,
    radio: cp.radio,
    variant: variantOf(cp),
    exportedAt: opts.exportedAt ?? new Date().toISOString(),
    keys,
  }
  return `${JSON.stringify(file, null, 2)}\n`
}
