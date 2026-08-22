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
/** 2 added `presets`. See `STORE_PRESETS`. */
export const DB_VERSION = 2

export const STORE_BACKUPS = 'backups'
export const STORE_SESSIONS = 'sessions'
export const STORE_PREFS = 'prefs'
/**
 * Channel sets the user imported or saved.
 *
 * These lived in `localStorage` when a set was a few dozen frequencies from a
 * CHIRP CSV. A fetched repeater list is tens of thousands of records, which is
 * past the ~5 MB origin cap several times over - and the old code caught the
 * quota error and carried on, so the set worked all session and vanished on
 * reload with nothing said. One record per set rather than one blob, so adding
 * a large set does not mean rewriting every other one.
 */
export const STORE_PRESETS = 'presets'

/** The key `localStorage` used before `STORE_PRESETS`, read once to migrate. */
export const LEGACY_PRESETS_KEY = 'boofwang:presets'

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
  /**
   * Fingerprint of the physical unit, when the driver can produce one.
   *
   * `identHash` only identifies the firmware, so two identical radios share it.
   * This is what distinguishes them. Absent on backups taken before the check
   * existed, which the write path treats as "cannot confirm", not "matches".
   */
  unitHash?: string | null
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
  opts: { id: string; origin: BackupOrigin; identHash: string; label?: string; unitHash?: string | null },
): StoredBackup {
  return {
    id: opts.id,
    radioId: image.radioId,
    variant: image.variant,
    layout: image.layout,
    origin: opts.origin,
    createdAt: image.createdAt,
    identHash: opts.identHash,
    unitHash: opts.unitHash ?? null,
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
