// SPDX-License-Identifier: GPL-3.0-or-later
import type { TonePair } from '../model/tones.js'
import { hz, type Hz } from '../model/units.js'
import { distanceKm, isUsableCoord } from './geo.js'
import { isStorableColorCode, parseAccess, parseMode, txSpecFor } from './normalise.js'
import type {
  JsonFetcher,
  RepeaterRecord,
  SourceImpl,
  SourceIssue,
  SourceQuery,
  SourceResult,
} from './source.js'

/**
 * The hearham.com repeater directory.
 *
 * The only large multi-mode analogue source here, which makes it the one that
 * serves the UV-K5, UV-82 and UV-5R Mini rather than only the DM-32UV: of
 * 22,635 records, 15,274 are FM.
 *
 * It sends no `Access-Control-Allow-Origin`, so it needs the desktop shell -
 * see `needs` in `registry.ts`. It also publishes no data licence, which is
 * recorded in `docs/provenance.md` and repeated to the user wherever its data
 * is shown. If its owner asks us to stop, `enabled: false` in the registry is
 * the whole change.
 *
 * Field meanings come from reading live responses on 2026-08-22. The site
 * publishes no schema.
 */

const ENDPOINT = 'https://hearham.com/api/repeaters/v1'
const ID = 'hearham'

interface RawRepeater {
  id?: unknown
  callsign?: unknown
  latitude?: unknown
  longitude?: unknown
  city?: unknown
  mode?: unknown
  encode?: unknown
  decode?: unknown
  frequency?: unknown
  offset?: unknown
  operational?: unknown
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Frequencies here are already integers in hertz, unlike every other source. */
function asHz(v: unknown): Hz | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
  return hz(v)
}

function toRecord(raw: RawRepeater): RepeaterRecord | SourceIssue {
  const ref = String(raw.id ?? raw.callsign ?? 'unknown')
  const callsign = asText(raw.callsign)
  const label = callsign || ref

  const rxFreq = asHz(raw.frequency)
  if (rxFreq === null) {
    return { ref, severity: 'error', message: `${label} publishes no usable frequency.` }
  }

  const mode = parseMode(raw.mode)
  if (mode.modulation === null) {
    return { ref, severity: 'warning', message: `${label}: ${mode.issue ?? 'unreadable mode.'}` }
  }

  // `offset` is a signed hertz delta from the output to the input, and 3,236
  // records publish zero - which is either a simplex node or a repeater whose
  // shift nobody filled in. The two are indistinguishable from here, so both
  // become simplex: a channel that transmits where it listens is wrong in a
  // way the operator will notice immediately, whereas a guessed shift is wrong
  // in a way they will not.
  const offset = typeof raw.offset === 'number' && Number.isFinite(raw.offset) ? raw.offset : 0
  const repeaterInput = offset === 0 ? null : hz(rxFreq + offset)

  // `encode` is what the repeater expects to hear, so it is what this radio
  // transmits; `decode` is what the repeater sends, so it is what opens this
  // radio's squelch. Both are free text and neither is reliably a tone - see
  // `parseAccess`, and note that 5,836 records put a DMR colour code in
  // `encode`.
  const enc = parseAccess(raw.encode)
  const dec = parseAccess(raw.decode)
  const tone: TonePair = { rx: dec.tone, tx: enc.tone, rxInverted: false }

  const colorCode = enc.colorCode ?? dec.colorCode
  const lat = raw.latitude
  const lon = raw.longitude

  return {
    sourceId: ID,
    ref,
    callsign,
    name: callsign,
    city: asText(raw.city),
    rxFreq,
    tx: txSpecFor(rxFreq, repeaterInput),
    tone,
    modulation: mode.modulation,
    bandwidthHz: mode.bandwidthHz ?? (mode.modulation === 'FM' ? 25_000 : 12_500),
    ...(isUsableCoord(lat, lon) ? { location: { lat: lat as number, lon: lon as number } } : {}),
    // This source does track whether a repeater is up, unlike the others.
    operational: raw.operational !== 0,
    ...(isStorableColorCode(colorCode) ? { dmr: { colorCode } } : {}),
  }
}

const isIssue = (v: RepeaterRecord | SourceIssue): v is SourceIssue =>
  (v as SourceIssue).severity !== undefined

export const hearham: SourceImpl = {
  id: ID,

  async fetchRepeaters(get: JsonFetcher, query: SourceQuery): Promise<SourceResult> {
    const body = await get(ENDPOINT)
    if (!Array.isArray(body)) {
      return {
        records: [],
        issues: [{ ref: 'repeaters', severity: 'error', message: 'hearham returned something that is not a list of repeaters.' }],
      }
    }

    const records: RepeaterRecord[] = []
    const issues: SourceIssue[] = []
    for (const raw of body as RawRepeater[]) {
      const got = toRecord(raw)
      if (isIssue(got)) issues.push(got)
      else records.push(got)
    }

    return { records: applyQuery(records, query), issues }
  },
}

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
