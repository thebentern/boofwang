// SPDX-License-Identifier: GPL-3.0-or-later
import type { Channel } from './channel.js'

export type RadioId = 'uvk5' | 'uv82' | 'uv5rmini' | 'dm32uv'

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
    encryptionKeys: [],
    settings: {},
  }
}

/** Channels in memory-slot order. */
export function sortedChannels(cp: Codeplug): Channel[] {
  return [...cp.channels.values()].sort((a, b) => a.index - b.index)
}
