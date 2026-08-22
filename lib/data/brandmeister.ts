// SPDX-License-Identifier: GPL-3.0-or-later
import { NO_TONE } from '../model/tones.js'
import { distanceKm, isUsableCoord } from './geo.js'
import { isStorableColorCode, parseMHzField, txSpecFor } from './normalise.js'
import type {
  JsonFetcher,
  RepeaterRecord,
  SourceImpl,
  SourceIssue,
  SourceQuery,
  SourceResult,
  TalkGroupRecord,
  TalkGroupResult,
} from './source.js'

/**
 * The BrandMeister DMR network.
 *
 * The only source here that a browser can reach unaided: its API reflects the
 * requesting origin, so no proxy and no desktop shell are involved. That is why
 * the DM-32UV talk group and contact import - which before this had no bulk
 * path at all, against a fifty-thousand contact capacity - works on the web
 * build.
 *
 * Field meanings were established by reading live responses on 2026-08-22, not
 * from documentation, because BrandMeister publishes none for these endpoints.
 * Where a field's meaning could not be established it is carried past rather
 * than interpreted.
 */

const BASE = 'https://api.brandmeister.network/v2'
const ID = 'brandmeister'

/** DMR occupies a 12.5 kHz channel. Not published per record; it is the mode. */
const DMR_BANDWIDTH_HZ = 12_500

interface RawDevice {
  id?: unknown
  callsign?: unknown
  tx?: unknown
  rx?: unknown
  colorcode?: unknown
  lat?: unknown
  lng?: unknown
  city?: unknown
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Turn one device record into a repeater, or explain why not.
 *
 * The frequency mapping is the part to get right and the easiest to get wrong.
 * BrandMeister publishes from the repeater's point of view: `tx` is what the
 * repeater transmits, so it is what this radio receives; `rx` is what the
 * repeater listens to, so it is where this radio transmits. Reversing them
 * yields a channel that hears nothing and keys up on a repeater's output, which
 * is both useless and antisocial. Verified against a known pair: SV4M publishes
 * tx 439.3750 and rx 431.7750, the standard European 70 cm -7.6 MHz shift.
 */
function toRecord(raw: RawDevice): RepeaterRecord | SourceIssue {
  const ref = String(raw.id ?? raw.callsign ?? 'unknown')
  const callsign = asText(raw.callsign)

  const rxFreq = parseMHzField(raw.tx)
  if (rxFreq === null) {
    return { ref, severity: 'error', message: `${callsign || ref} publishes no usable output frequency.` }
  }
  const repeaterInput = parseMHzField(raw.rx)

  // A colour code that cannot be stored is fatal to the record rather than a
  // field to drop: a DMR channel without the right colour code does not work,
  // and one silently truncated into four bits is worse than one that is absent.
  const cc = raw.colorcode
  if (!isStorableColorCode(cc)) {
    return {
      ref,
      severity: 'error',
      message:
        `${callsign || ref} publishes colour code ${String(cc)}, which is outside the 0 to 15 DMR range `
        + 'and cannot be stored.',
    }
  }

  const lat = raw.lat
  const lon = raw.lng
  const located = isUsableCoord(lat, lon)

  return {
    sourceId: ID,
    ref,
    callsign,
    name: callsign,
    city: asText(raw.city),
    rxFreq,
    tx: txSpecFor(rxFreq, repeaterInput),
    // DMR carries no CTCSS. The colour code is the access control, and it lives
    // on `dmr` rather than being forced into a tone field it does not fit.
    tone: NO_TONE,
    modulation: 'DMR',
    bandwidthHz: DMR_BANDWIDTH_HZ,
    ...(located ? { location: { lat: lat as number, lon: lon as number } } : {}),
    // BrandMeister publishes a `status` integer whose meaning is not documented
    // anywhere we can check. Rather than guess which values mean "on the air",
    // nothing is claimed: a listing here is evidence the repeater is registered,
    // not that it is up.
    operational: true,
    dmr: { colorCode: cc },
  }
}

const isIssue = (v: RepeaterRecord | SourceIssue): v is SourceIssue =>
  (v as SourceIssue).severity !== undefined

export const brandmeister: SourceImpl = {
  id: ID,

  /**
   * Every registered repeater, filtered here rather than by the server.
   *
   * The endpoint rejects query parameters - it answers `Unsupported query
   * parameter` to anything - so the whole list arrives or none of it does. That
   * is around 10 MB, which is why the caller is expected to hold the result for
   * the session rather than re-fetching per search. Filtering lives here so
   * that expectation does not leak into every screen that wants a search box.
   */
  async fetchRepeaters(get: JsonFetcher, query: SourceQuery): Promise<SourceResult> {
    const body = await get(`${BASE}/device`)
    if (!Array.isArray(body)) {
      return {
        records: [],
        issues: [{ ref: 'device', severity: 'error', message: 'BrandMeister returned something that is not a list of repeaters.' }],
      }
    }

    const records: RepeaterRecord[] = []
    const issues: SourceIssue[] = []
    for (const raw of body as RawDevice[]) {
      const got = toRecord(raw)
      if (isIssue(got)) issues.push(got)
      else records.push(got)
    }

    return { records: applyQuery(records, query), issues }
  },

  /**
   * The talk group directory: about 1,800 entries, as a number-to-name map.
   *
   * The DM-32UV holds 800, so this can never be imported whole. Filtering is
   * the caller's job because only the caller knows which region the person in
   * front of it operates in.
   */
  async fetchTalkGroups(get: JsonFetcher): Promise<TalkGroupResult> {
    const body = await get(`${BASE}/talkgroup`)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return {
        talkGroups: [],
        issues: [{ ref: 'talkgroup', severity: 'error', message: 'BrandMeister returned something that is not a talk group list.' }],
      }
    }

    const talkGroups: TalkGroupRecord[] = []
    const issues: SourceIssue[] = []
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      // Shape-checked before parsing, because `Number('  ')` is 0 rather than
      // NaN - so a blank key would otherwise become talk group 0 carrying
      // whatever name sat beside it.
      if (!/^\d+$/.test(key.trim())) {
        issues.push({ ref: key, severity: 'error', message: `Talk group id ${JSON.stringify(key)} is not a number.` })
        continue
      }
      const number = Number(key.trim())
      const name = typeof value === 'string' ? value.trim() : ''
      if (name === '') {
        issues.push({ ref: key, severity: 'warning', message: `Talk group ${number} has no name.` })
        continue
      }
      talkGroups.push({ sourceId: ID, number, name })
    }

    talkGroups.sort((a, b) => a.number - b.number)
    return { talkGroups, issues }
  },
}

/**
 * Narrow a result set to what was asked for.
 *
 * A record with no coordinates is kept when no distance was asked for and
 * dropped when one was - it cannot be shown to be near anywhere. Three and a
 * half thousand records are in that state, so the interface has to say how many
 * were set aside rather than quietly returning a shorter list.
 */
function applyQuery(records: readonly RepeaterRecord[], query: SourceQuery): RepeaterRecord[] {
  let out = [...records]

  if (query.callsign !== undefined && query.callsign.trim() !== '') {
    const needle = query.callsign.trim().toUpperCase()
    out = out.filter((r) => r.callsign.toUpperCase().includes(needle))
  }

  if (query.modes !== undefined && query.modes.length > 0) {
    const modes = new Set(query.modes)
    out = out.filter((r) => modes.has(r.modulation))
  }

  const near = query.near
  if (near !== undefined) {
    const limit = query.withinKm
    out = out.filter((r) => r.location !== undefined)
    if (limit !== undefined) out = out.filter((r) => distanceKm(near, r.location!) <= limit)
    out.sort((a, b) => distanceKm(near, a.location!) - distanceKm(near, b.location!))
  }

  return out
}
