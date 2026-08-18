// SPDX-License-Identifier: GPL-3.0-or-later
import type { RadioId } from '../model/codeplug.js'
import type { RadioImage } from '../radio/image.js'

/**
 * The shape of what boofwang stores locally, and the mapping to and from it.
 *
 * The IndexedDB plumbing lives in `app/composables/useBoofwangDb.ts`, because
 * `IDBDatabase` and friends are DOM types and `lib/` is kept DOM-free so it
 * stays testable in plain Node. What is here is the part worth testing: the
 * record shapes and the conversion to and from a `RadioImage`.
 *
 * IndexedDB rather than localStorage, incidentally: localStorage caps at about
 * 5 MB per origin, is synchronous, and holds only strings, so a binary image
 * would have to be base64'd at a 33% size penalty. IndexedDB stores
 * `Uint8Array` natively through structured clone.
 */

export const DB_NAME = 'boofwang'
export const DB_VERSION = 1

export const STORE_BACKUPS = 'backups'
export const STORE_SESSIONS = 'sessions'
export const STORE_PREFS = 'prefs'

/** Why an image was kept, which decides how eagerly it may be pruned. */
export type BackupOrigin = 'download' | 'pre-write' | 'import'

export interface StoredBackup {
  id: string
  radioId: RadioId
  variant: string
  layout: string
  origin: BackupOrigin
  createdAt: string
  /** Hash of the identify result, so a backup can be matched to a radio. */
  identHash: string
  sha256: string
  label: string
  byteLength: number
  regions: { start: number; label: string; readOnly: boolean; data: Uint8Array }[]
}

export interface StoredSession {
  id: string
  radioId: RadioId
  updatedAt: string
  /** The serialised codeplug document. */
  doc: unknown
}

export function toStoredBackup(
  image: RadioImage,
  opts: { id: string; origin: BackupOrigin; identHash: string; label?: string },
): StoredBackup {
  return {
    id: opts.id,
    radioId: image.radioId,
    variant: image.variant,
    layout: image.layout,
    origin: opts.origin,
    createdAt: image.createdAt,
    identHash: opts.identHash,
    sha256: image.sha256,
    label: opts.label ?? `${image.radioId} ${image.variant}`,
    byteLength: image.regions.reduce((n, r) => n + r.data.length, 0),
    regions: image.regions.map((r) => ({
      start: r.start,
      label: r.label,
      readOnly: r.readOnly === true,
      data: r.data,
    })),
  }
}

export function fromStoredBackup(b: StoredBackup): RadioImage {
  return {
    radioId: b.radioId,
    variant: b.variant,
    layout: b.layout,
    createdAt: b.createdAt,
    regions: b.regions.map((r) => ({ start: r.start, data: r.data, label: r.label, readOnly: r.readOnly })),
    meta: {},
    sha256: b.sha256,
  }
}
