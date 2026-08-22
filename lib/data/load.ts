// SPDX-License-Identifier: GPL-3.0-or-later
import { hostSupports, type HostKind } from '../platform/host.js'
import { sourceById } from './registry.js'
import type { SourceImpl } from './source.js'

/**
 * Getting hold of the code that talks to a source, and refusing when the host
 * cannot.
 *
 * This is the enforcement half of the capability gate, and it exists separately
 * from `availableSources` for the same reason `writeImage` enforces what
 * `evaluateWriteGate` explains: one of them is there to tell a person why they
 * are stuck, and the other is there to be unbypassable. If they ever disagree,
 * this one wins and the user sees an error rather than a well-worded absence.
 *
 * A note on what this does and does not achieve. The desktop build ships the
 * same artifact as the web build, so the module for a desktop-only source is
 * physically present in both - there is no second bundle to leave it out of,
 * and pretending otherwise would mean two artifacts to keep in step. What is
 * guaranteed is that the web build never *reaches* it: the import is dynamic,
 * so it is not in the entry chunk, and this function refuses before the import
 * is evaluated. There are no credentials in any of these modules, so presence
 * costs nothing beyond a few kilobytes of a chunk nobody fetches.
 */
export class SourceUnavailableError extends Error {
  constructor(readonly sourceId: string, readonly reason: string) {
    super(reason)
    this.name = 'SourceUnavailableError'
  }
}

export async function loadSource(id: string, host: HostKind): Promise<SourceImpl> {
  const meta = sourceById(id)
  if (meta === undefined) {
    throw new SourceUnavailableError(id, `There is no data source called ${JSON.stringify(id)}.`)
  }
  if (!meta.enabled) {
    throw new SourceUnavailableError(id, `${meta.name} is switched off in this build.`)
  }
  if (!hostSupports(host, meta.needs)) {
    throw new SourceUnavailableError(
      id,
      `${meta.name} cannot be reached from the browser. It needs the desktop app.`,
    )
  }

  switch (id) {
    case 'brandmeister':
      return (await import('./brandmeister.js')).brandmeister
    case 'hearham':
      return (await import('./hearham.js')).hearham
    case 'radioid':
      return (await import('./radioid.js')).radioid
    default:
      // Reachable only if the registry gains a source and this switch does not.
      throw new SourceUnavailableError(id, `${meta.name} has no reader in this build.`)
  }
}
