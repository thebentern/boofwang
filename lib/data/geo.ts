// SPDX-License-Identifier: GPL-3.0-or-later

/** Mean Earth radius, kilometres. */
const R_KM = 6371.0088

const rad = (deg: number): number => (deg * Math.PI) / 180

/**
 * Great-circle distance in kilometres.
 *
 * Haversine rather than a flat approximation, because "repeaters near me" is
 * asked at every latitude and a flat-Earth shortcut is wrong by tens of
 * kilometres in Alaska and Scandinavia - both places where the answer to the
 * question matters more than most.
 */
export function distanceKm(
  a: { readonly lat: number; readonly lon: number },
  b: { readonly lat: number; readonly lon: number },
): number {
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const s
    = Math.sin(dLat / 2) ** 2
      + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)))
}

/**
 * Whether a published coordinate is usable.
 *
 * Rejects the null island at 0,0 as well as out-of-range values. Thousands of
 * records in these directories carry no location, and a proportion of those
 * express it as a pair of zeros rather than as an absent field - which would
 * otherwise place a repeater in the Gulf of Guinea and sort it to the top of a
 * search run from anywhere in west Africa.
 */
export function isUsableCoord(lat: unknown, lon: unknown): lat is number {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (lat === 0 && lon === 0) return false
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}
