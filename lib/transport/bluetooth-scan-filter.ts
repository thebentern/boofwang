// SPDX-License-Identifier: GPL-3.0-or-later
import { normaliseUuid, type BluetoothProfile } from './bluetooth-uuids.js'

/**
 * Web Bluetooth's chooser filter, reimplemented for a scan the app runs itself.
 *
 * In a browser the filter is the browser's: `requestDevice` takes a list of
 * `{ services }` and `{ namePrefix }` entries, ORs them, and lists whatever
 * matches. The native app has no chooser. It starts a scan, is handed every
 * advertisement in range, and decides which rows to show. The deciding is
 * done here, in code the core project can test, with the same semantics the
 * browser applies - so a profile that lists a radio in Chrome lists it in
 * the app, and a profile that would empty the chooser empties the list, for
 * the same reason.
 *
 * Why the scan runs unfiltered and the filtering happens on this side:
 *
 * - CoreBluetooth cannot filter a scan by name at all, only by service, and
 *   the name prefixes are half of every profile's filter. Whether the UV-5R
 *   Mini puts FFE0 in its advertisement is recorded as unverified in
 *   docs/protocols/uv5rmini.md - the chooser matched, but a chooser cannot
 *   say which half hit - so a scan filtered on the service alone might list
 *   nothing, indistinguishable from a radio that is switched off.
 * - Android rate-limits scan starts to five per thirty seconds and silently
 *   returns nothing past that. One unfiltered scan per chooser opening, with
 *   the candidates applied here, is one start; re-scanning per candidate
 *   would burn the allowance on the second opening.
 *
 * Matching is exactly the browser's: a name prefix is case-sensitive and
 * matches at the start of the advertised name only, and a service matches
 * only if the device puts it in its advertisement - which is what
 * `advertisedServices` records where it differs from `service`.
 */

export interface ScanAdvertisement {
  /** The name the platform attached to the device, usually from the scan. */
  readonly name?: string | null
  /** The name carried in the advertisement itself, where the platform separates the two. */
  readonly localName?: string | null
  /** Service UUIDs in the advertisement, in whatever spelling the platform uses. */
  readonly uuids?: readonly string[]
}

/** The services a scan may match on, normalised and de-duplicated. */
export function advertisedServicesOf(candidates: readonly BluetoothProfile[]): string[] {
  const out = new Set<string>()
  for (const c of candidates) {
    for (const s of c.advertisedServices ?? [c.service]) out.add(normaliseUuid(s))
  }
  return [...out]
}

/** Every name prefix across the candidates, de-duplicated, order preserved. */
export function namePrefixesOf(candidates: readonly BluetoothProfile[]): string[] {
  const out = new Set<string>()
  for (const c of candidates) {
    for (const p of c.namePrefixes) out.add(p)
  }
  return [...out]
}

function safeUuid(value: string): string | undefined {
  try {
    return normaliseUuid(value)
  } catch {
    // An advertisement is whatever the peripheral put on the air. One entry
    // that is not a UUID must not stop the others being matched.
    return undefined
  }
}

/** Would Web Bluetooth's chooser list this advertisement for these candidates? */
export function matchesProfiles(ad: ScanAdvertisement, candidates: readonly BluetoothProfile[]): boolean {
  if (candidates.length === 0) return false

  const names = [ad.name, ad.localName].filter((n): n is string => typeof n === 'string' && n.length > 0)
  for (const prefix of namePrefixesOf(candidates)) {
    if (names.some((n) => n.startsWith(prefix))) return true
  }

  const wanted = new Set(advertisedServicesOf(candidates))
  for (const raw of ad.uuids ?? []) {
    const uuid = safeUuid(raw)
    if (uuid !== undefined && wanted.has(uuid)) return true
  }

  return false
}
