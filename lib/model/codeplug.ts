// SPDX-License-Identifier: GPL-3.0-or-later
import type { Channel } from './channel.js'
import type { Hz } from './units.js'

export type RadioId = 'uvk5' | 'uv82' | 'uv5g' | 'uv5rmini' | 'dm32uv'

export type EncryptionType = 'none' | 'custom' | 'arc4' | 'aes128' | 'aes256'

export interface Zone {
  id: string
  name: string
  /** Channel indices, in the order the radio presents them. */
  channels: number[]
}

export interface TalkGroup {
  id: string
  name: string
  number: number
  callType: 'group' | 'private' | 'allCall'
}

export interface RxGroup {
  id: string
  name: string
  /** Raw DMR IDs, which is how the DM-32UV stores them - not talkgroup indices. */
  dmrIds: number[]
}

export interface ScanList {
  id: string
  name: string
  channels: number[]
  priority1?: number | null
  priority2?: number | null
}

/**
 * An entry in the radio's DMR address book.
 *
 * Distinct from a talk group, and from the radio's own IDs. The DM-32UV keeps
 * up to 50,000 of these in a memory region of their own, outside the
 * configuration the rest of a codeplug comes from.
 */
export interface DmrContact {
  id: string
  name: string
  dmrId: number
  callsign: string
  city: string
  province: string
  country: string
  remark: string
}

/** A repeater the radio can roam to: a pair, a colour code and a slot. */
export interface RoamChannel {
  id: string
  name: string
  rxFreq: Hz
  txFreq: Hz
  colorCode: number
  timeSlot: 1 | 2
}

/**
 * A named list of roaming channels.
 *
 * `members` is not decoded: a 33-byte record with a 16-byte name leaves too
 * little room to guess the entry width from, and every zone on the radio this
 * was written against is empty. The count the radio stores is carried so the
 * gap is visible rather than implied.
 */
/**
 * An entry in the DM-32UV's block 0x03 "Call" list.
 *
 * Named for what the records say rather than for what they do, because what
 * they do is not known - see the layout. The OEM CPS writes this block, so it
 * is codeplug data; the two reference fields point at something nobody has
 * identified, and are carried rather than interpreted.
 */
export interface CallListEntry {
  id: string
  name: string
  inUse: boolean
  referenceA: number
  referenceB: number
}

export interface RoamZone {
  id: string
  name: string
  /** Bit 0 of the record's first byte. */
  enabled: boolean
  /**
   * The byte the reference calls "channel count / index".
   *
   * Carried and shown, not interpreted. Flags, name and this byte account for
   * all 33 bytes of the record, so whatever list it counts or points into is
   * somewhere nobody has found.
   */
  channelIndex: number
}

/** One of the radio's eight digital emergency systems. Read only. */
export interface EmergencySystem {
  id: string
  slot: number
  name: string
  alarmType: number
  alarmMode: number
  revertChannel: number
}

/**
 * Analog signalling: DTMF codes and the two contact lists that go with them.
 *
 * Read only, and deliberately shallow. The settings record that sits between
 * the code lists is almost entirely unexplained, so nothing here offers to
 * change it.
 */
export interface AnalogConfig {
  dtmfCodes: string[]
  dtmfSpecialCodes: string[]
  contacts: string[]
  bdcContacts: { name: string; number: number }[]
}

export interface DmrRadioId {
  id: string
  name: string
  dmrId: number
}

export interface EncryptionKey {
  id: string
  /** 1-based slot on the radio. */
  slot: number
  name: string
  type: EncryptionType
  /** Uppercase hex, no separators. Empty when the slot is unused. */
  keyHex: string
}

export interface CodeplugMeta {
  title: string
  notes: string
  createdAt: string
  modifiedAt: string
  /** Firmware/model string reported by the radio this came from. */
  variant?: string
}

/**
 * The editable document.
 *
 * Deliberately holds no reference to a `RadioImage`: a codeplug is a portable
 * value that can be built from a CSV or a preset bundle with no radio present.
 * The image is paired with it at the session level instead.
 */
export interface Codeplug {
  readonly schemaVersion: 1
  /** null means radio-agnostic: an imported CSV, or a preset bundle. */
  radio: RadioId | null
  meta: CodeplugMeta
  /** Sparse: index is the memory slot, and empty slots are absent. */
  channels: Map<number, Channel>
  zones: Zone[]
  scanLists: ScanList[]
  talkGroups: TalkGroup[]
  rxGroups: RxGroup[]
  radioIds: DmrRadioId[]
  contacts: DmrContact[]
  /** Canned text messages. */
  messages: string[]
  /**
   * The two VFOs, when the radio stores them as channel records.
   *
   * Kept apart from `channels` on purpose: they are not in the channel bank,
   * nothing counts them, and no zone or scan list can point at one, so folding
   * them in would make every membership list have to exclude two entries.
   */
  vfo: { a: Channel | null; b: Channel | null }
  roamChannels: RoamChannel[]
  roamZones: RoamZone[]
  /** Block 0x03. Real codeplug data of unknown purpose - see `CallListEntry`. */
  callList: CallListEntry[]
  /** Read only: decoded so a backup is complete, never written. */
  emergency: EmergencySystem[]
  analog: AnalogConfig | null
  encryptionKeys: EncryptionKey[]
  /** Radio settings, keyed by the setting ids declared in the RadioSchema. */
  settings: Record<string, unknown>
}

export function emptyCodeplug(radio: RadioId | null, now: string): Codeplug {
  return {
    schemaVersion: 1,
    radio,
    meta: { title: 'Untitled', notes: '', createdAt: now, modifiedAt: now },
    channels: new Map(),
    zones: [],
    scanLists: [],
    talkGroups: [],
    rxGroups: [],
    radioIds: [],
    contacts: [],
    messages: [],
    vfo: { a: null, b: null },
    roamChannels: [],
    roamZones: [],
    callList: [],
    emergency: [],
    analog: null,
    encryptionKeys: [],
    settings: {},
  }
}

/** Channels in memory-slot order. */
export function sortedChannels(cp: Codeplug): Channel[] {
  return [...cp.channels.values()].sort((a, b) => a.index - b.index)
}
