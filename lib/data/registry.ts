// SPDX-License-Identifier: GPL-3.0-or-later
import type { DataSource } from './source.js'
import { hostSupports, type HostKind } from '../platform/host.js'

/**
 * Every external source boofwang will talk to, and nothing else.
 *
 * Metadata only. No endpoint, no request code - those live in the per-source
 * modules and are loaded on demand, so a source the running host cannot reach
 * contributes nothing to the bundle beyond the few strings needed to say it
 * exists.
 *
 * The licence lines below are what the publisher actually says, which in two
 * cases is nothing at all. That is recorded rather than smoothed over: a source
 * with no licence is a decision someone took, and the interface repeats the
 * line so the person staging the data can take it too. `docs/provenance.md`
 * carries the longer version.
 */

const BRANDMEISTER: DataSource = {
  id: 'brandmeister',
  name: 'BrandMeister',
  attribution: 'BrandMeister DMR network',
  licence:
    'No published data licence. The API is open and needs no account, and boofwang asks it only for '
    + 'what you search for.',
  homepage: 'https://brandmeister.network/',
  enabled: true,
  // Its API reflects the requesting origin, so a browser can reach it directly.
  // That is why the DM-32UV talk group and contact import - the largest gap
  // this fills - needs no desktop app.
  needs: [],
}

const HEARHAM: DataSource = {
  id: 'hearham',
  name: 'hearham',
  attribution: 'hearham.com repeater directory',
  licence:
    'No published data licence. The database is widely described as free to use in applications, but '
    + 'the site itself does not say so.',
  homepage: 'https://hearham.com/',
  enabled: true,
  needs: ['crossOriginFetch'],
}

const RADIOID: DataSource = {
  id: 'radioid',
  name: 'RadioID',
  attribution: 'RadioID.net DMR registry',
  licence:
    'Lookups are permitted. Mirroring the database, republishing it or building a competing directory '
    + 'needs written permission, which boofwang does not have and does not need.',
  homepage: 'https://radioid.net/',
  needs: ['crossOriginFetch'],
  enabled: true,
}

export const DATA_SOURCES: readonly DataSource[] = [BRANDMEISTER, HEARHAM, RADIOID]

export function sourceById(id: string): DataSource | undefined {
  return DATA_SOURCES.find((s) => s.id === id)
}

/**
 * The sources this host can actually use.
 *
 * The only question the interface should ask. A component that decides for
 * itself whether it is running in the desktop build will drift from this one
 * the first time a capability is added.
 */
export function availableSources(host: HostKind): readonly DataSource[] {
  return DATA_SOURCES.filter((s) => s.enabled && hostSupports(host, s.needs))
}

/**
 * Sources that exist, are switched on, and that this host cannot reach.
 *
 * Separate from `availableSources` so the interface can name them once, as a
 * fact about the host rather than a prompt to go and download something. A
 * source switched off with `enabled: false` appears in neither list: withdrawn
 * is not the same as unreachable, and nobody should be told to install an app
 * to get at something we have stopped offering.
 */
export function unreachableSources(host: HostKind): readonly DataSource[] {
  return DATA_SOURCES.filter((s) => s.enabled && !hostSupports(host, s.needs))
}
