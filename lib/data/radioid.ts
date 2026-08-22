// SPDX-License-Identifier: GPL-3.0-or-later
import { NO_TONE } from '../model/tones.js'
import { hz } from '../model/units.js'
import { isStorableColorCode, parseMHzField, parseSignedMHzOffset, txSpecFor } from './normalise.js'
import type {
  JsonFetcher,
  RepeaterRecord,
  SourceImpl,
  SourceIssue,
  SourceQuery,
  SourceResult,
} from './source.js'

/**
 * The RadioID.net DMR registry.
 *
 * Deliberately lookup-only. RadioID's policy permits queries and prohibits
 * mirroring the database, republishing it, or building a competing directory
 * without written permission - so this asks for a callsign and gets an answer,
 * and there is no code path here that walks the whole thing. `fetchRepeaters`
 * refuses a query with nothing in it rather than falling back to everything,
 * which is the shape that would quietly become a bulk download.
 *
 * It publishes no coordinates. `locator` is an integer identifier and not a
 * Maidenhead grid, so there is nothing to compute a distance from: this source
 * cannot answer "near me", and the search screen has to say so rather than
 * returning an empty list that looks like an absence of repeaters.
 *
 * Field names read from a live response on 2026-08-22.
 */

const BASE = 'https://radioid.net/api/dmr/repeater/'
const ID = 'radioid'

/** DMR occupies a 12.5 kHz channel. */
const DMR_BANDWIDTH_HZ = 12_500

interface RawRepeater {
  callsign?: unknown
  city?: unknown
  state?: unknown
  color_code?: unknown
  frequency?: unknown
  offset?: unknown
  status?: unknown
  trustee?: unknown
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function toRecord(raw: RawRepeater): RepeaterRecord | SourceIssue {
  const callsign = asText(raw.callsign)
  const ref = callsign || 'unknown'

  const rxFreq = parseMHzField(raw.frequency)
  if (rxFreq === null) {
    return { ref, severity: 'error', message: `${ref} publishes no usable frequency.` }
  }

  const offset = parseSignedMHzOffset(raw.offset)
  if (offset.kind === 'ambiguous') {
    return {
      ref,
      severity: 'error',
      message:
        `${ref} publishes its shift as ${JSON.stringify(offset.raw)} with no sign, so boofwang cannot tell `
        + 'which way it goes. Set the transmit frequency yourself if you know it.',
    }
  }

  const cc = raw.color_code
  if (!isStorableColorCode(cc)) {
    return {
      ref,
      severity: 'error',
      message: `${ref} publishes colour code ${String(cc)}, which is outside the 0 to 15 DMR range.`,
    }
  }

  const repeaterInput = offset.kind === 'none' ? null : hz(rxFreq + offset.deltaHz)
  const city = asText(raw.city)
  const state = asText(raw.state)

  return {
    sourceId: ID,
    ref,
    callsign,
    name: callsign,
    city: [city, state].filter((s) => s !== '').join(', '),
    rxFreq,
    tx: txSpecFor(rxFreq, repeaterInput),
    tone: NO_TONE,
    modulation: 'DMR',
    bandwidthHz: DMR_BANDWIDTH_HZ,
    // No coordinates are published, so `location` is always absent here.
    // `status` reads `on-air` on every record seen, which makes it evidence of
    // nothing in particular; it is not interpreted.
    operational: true,
    dmr: { colorCode: cc },
  }
}

const isIssue = (v: RepeaterRecord | SourceIssue): v is SourceIssue =>
  (v as SourceIssue).severity !== undefined

export const radioid: SourceImpl = {
  id: ID,

  async fetchRepeaters(get: JsonFetcher, query: SourceQuery): Promise<SourceResult> {
    const callsign = query.callsign?.trim() ?? ''
    if (callsign === '') {
      return {
        records: [],
        issues: [{
          ref: 'query',
          severity: 'error',
          message: 'RadioID answers lookups, not listings. Search for a callsign.',
        }],
      }
    }

    const body = await get(`${BASE}?callsign=${encodeURIComponent(callsign)}`)
    const results = (body as { results?: unknown } | null)?.results
    if (!Array.isArray(results)) {
      return {
        records: [],
        issues: [{ ref: callsign, severity: 'error', message: 'RadioID returned no result list.' }],
      }
    }

    const records: RepeaterRecord[] = []
    const issues: SourceIssue[] = []
    for (const raw of results as RawRepeater[]) {
      const got = toRecord(raw)
      if (isIssue(got)) issues.push(got)
      else records.push(got)
    }

    // Deliberately no distance filter: without coordinates there is nothing to
    // measure, and silently returning everything when a radius was asked for
    // would present an unfiltered list as a filtered one.
    if (query.near !== undefined) {
      issues.push({
        ref: 'query',
        severity: 'warning',
        message: 'RadioID publishes no locations, so these results are not sorted by distance.',
      })
    }

    return { records, issues }
  },
}
