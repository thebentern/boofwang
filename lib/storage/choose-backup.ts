// SPDX-License-Identifier: GPL-3.0-or-later
import type { RadioId } from '../model/codeplug.js'
import type { StoredBackup } from './db.js'

export interface BackupWanted {
  /** The connected radio's identify hash, when a radio is connected. */
  readonly identHash: string | null
  /** The open codeplug's radio, matched on when none is connected. */
  readonly radioId: RadioId | null
  /** The fingerprint of the image the open codeplug came from, or null. */
  readonly unit: string | null
  /** A stored backup's fingerprint, from its own bytes by its own driver. */
  readonly fingerprint: (b: StoredBackup) => Promise<string | null>
}

export interface ChosenBackup {
  readonly backup: StoredBackup
  /** The fingerprint it was stored with, or one computed from its bytes. */
  readonly unitHash: string | null
}

/**
 * Which stored backup stands behind a write of the open codeplug.
 *
 * Nothing about safety is decided here. `writeImage` reads the radio's own
 * per-unit bytes and refuses a backup whose fingerprint is not that radio's,
 * whatever this offers it. What is decided is whether the backup offered is
 * one the driver will accept, and whether the screen is right about there
 * being a way back.
 *
 * The newest backup with a matching identify hash used to be the answer, and
 * it is wrong twice over once a driver can fingerprint the unit.
 *
 * `identHash` names a firmware, not a radio, so two identical radios share
 * it and the newest backup can be the other one's. Where the open codeplug's
 * image has a fingerprint, the backup must carry the same one, and the newest
 * that does is chosen. Where none does there is no backup of this radio, and
 * saying so before the write is better than a refusal after the slide.
 *
 * And a backup taken before its driver could fingerprint carries no
 * `unitHash`. Every backup is the whole image the radio gave, so the
 * fingerprint it would have been stored with is in its own bytes, and it is
 * computed from them: the same function on the same bytes, later. Refusing
 * those backups instead would have sent everyone who had one back to read
 * their radio again, which replaces the open codeplug, for no gain in safety.
 * A backup whose bytes cannot be fingerprinted stays null, and the driver
 * refuses that.
 */
export async function chooseBackup(
  backups: readonly StoredBackup[],
  want: BackupWanted,
): Promise<ChosenBackup | null> {
  const candidates = backups
    .filter((b) => (want.identHash !== null ? b.identHash === want.identHash : b.radioId === want.radioId))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

  for (const backup of candidates) {
    const unitHash = await unitOf(backup, want.fingerprint)
    if (want.unit === null || unitHash === want.unit) return { backup, unitHash }
  }
  return null
}

async function unitOf(b: StoredBackup, fingerprint: BackupWanted['fingerprint']): Promise<string | null> {
  if (b.unitHash != null) return b.unitHash
  try {
    return await fingerprint(b)
  } catch {
    // A backup no driver here can read cannot be shown to be of any radio.
    return null
  }
}
