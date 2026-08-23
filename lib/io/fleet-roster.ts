// SPDX-License-Identifier: GPL-3.0-or-later
import type { FleetOutcome, FleetUnit } from '../radio/fleet.js'
import { parseCsv, writeRow } from './csv-text.js'

/**
 * The club's spreadsheet, in and out.
 *
 * Nobody types twenty callsigns and twenty seven-digit DMR IDs into a web form
 * without getting one of them wrong, and every club that runs a DMR net already
 * keeps this list - usually a column of names next to whatever RadioID.net
 * issued them. So the roster is pasted rather than entered, and the parser is
 * deliberately forgiving about which order the columns are in and what they are
 * called, because the file it is being handed was written for a person to read.
 *
 * What it is not forgiving about is a number it cannot read. A DMR ID that
 * silently parses to zero or to a truncated value is exactly the kind of quiet
 * wrong answer this project refuses to produce, so a row whose ID will not
 * parse is reported by line and left out.
 */

/** Header spellings seen in the wild, per column. Compared case-insensitively. */
const LABEL_HEADERS = ['label', 'radio', 'unit', 'owner', 'operator', 'user', 'handset']
const ID_HEADERS = ['dmrid', 'dmr id', 'id', 'radioid', 'radio id', 'number']
const NAME_HEADERS = ['name', 'callsign', 'call', 'radio name', 'display name']

export interface RosterParseResult {
  readonly units: readonly FleetUnit[]
  /** One per row that could not be used, with the line number as a person counts them. */
  readonly problems: readonly { readonly line: number; readonly message: string }[]
}

/**
 * Read a pasted roster.
 *
 * Column order comes from the header row when there is one. Without a header
 * the order is label, DMR ID, name - which is the order the export below
 * writes, so a roster that made a round trip through this app comes back the
 * same shape it left in.
 */
export function parseFleetRoster(text: string): RosterParseResult {
  const rows = parseCsv(text).filter((r) => r.some((f) => f.trim() !== ''))
  if (rows.length === 0) return { units: [], problems: [] }

  const header = headerIndexes(rows[0]!)
  const body = header ? rows.slice(1) : rows
  const at = header ?? { label: 0, dmrId: 1, name: 2 }
  const offset = header ? 2 : 1

  const units: FleetUnit[] = []
  const problems: { line: number; message: string }[] = []

  body.forEach((row, i) => {
    const line = i + offset
    const label = (row[at.label] ?? '').trim()
    const name = (row[at.name] ?? '').trim()
    const raw = (row[at.dmrId] ?? '').trim()

    const dmrId = raw === '' ? null : parseDmrId(raw)
    if (dmrId === false) {
      problems.push({ line, message: `${JSON.stringify(raw)} is not a DMR ID this can read.` })
      return
    }

    if (label === '' && name === '' && dmrId === null) return

    units.push({
      // Deterministic rather than random: nothing here is allowed to reach for
      // crypto, and a roster parsed twice from the same text producing two sets
      // of ids would make the run state impossible to reconcile with a re-import.
      id: `unit-${units.length + 1}`,
      label: label !== '' ? label : name !== '' ? name : `Radio ${units.length + 1}`,
      dmrId,
      name,
    })
  })

  return { units, problems }
}

/**
 * The roster as CSV, header included.
 *
 * The reason to offer this is not symmetry with the import. Nothing about a run
 * is persisted - the page holds it, and a reload loses it - so this is how a
 * club keeps the record of which ID went into which radio, which is the one
 * part of a programming session anybody needs a month later.
 */
export function exportFleetRoster(roster: readonly FleetUnit[]): string {
  let out = writeRow(['label', 'dmrId', 'name'])
  for (const u of roster) {
    out += writeRow([u.label, u.dmrId === null ? '' : String(u.dmrId), u.name])
  }
  return out
}

/**
 * Where each column is, or null when this row is data rather than a header.
 *
 * A row counts as a header only if it names a column this understands and holds
 * no number in the ID position - so "Dave,1234567,M0DAV" is never mistaken for
 * one, and neither is a roster whose first radio happens to be called "Name".
 */
function headerIndexes(row: readonly string[]): { label: number; dmrId: number; name: number } | null {
  const cells = row.map((c) => c.trim().toLowerCase())
  const label = cells.findIndex((c) => LABEL_HEADERS.includes(c))
  const dmrId = cells.findIndex((c) => ID_HEADERS.includes(c))
  const name = cells.findIndex((c) => NAME_HEADERS.includes(c))
  if (label < 0 && dmrId < 0 && name < 0) return null
  if (cells.some((c) => parseDmrId(c) !== false)) return null

  // A column this row does not name falls back to a position no row has, so
  // reading it yields an empty string rather than another column's value.
  return { label: label < 0 ? -1 : label, dmrId: dmrId < 0 ? -1 : dmrId, name: name < 0 ? -1 : name }
}

/**
 * A DMR ID, or false when the text is not one.
 *
 * Digits only, with the separators a spreadsheet adds allowed and stripped.
 * Anything else - a hex string, a callsign in the wrong column, "1.2e7" - is
 * refused rather than coerced, because `Number('1234567abc')` being NaN is the
 * good case and `Number('1e7')` being ten million is the bad one.
 */
function parseDmrId(text: string): number | false {
  const cleaned = text.replaceAll(/[\s,'_]/g, '')
  if (!/^\d+$/.test(cleaned)) return false
  const n = Number(cleaned)
  return Number.isSafeInteger(n) ? n : false
}

/**
 * The record of a run: the roster, plus what happened to each row.
 *
 * Separate from `exportFleetRoster` because the two answer different questions.
 * A roster is a plan and is meant to be edited and re-imported; this is a
 * record of an afternoon, and the column that matters is which physical radio
 * took which identity - which is the one question anybody asks a month later,
 * when a club member says their handset is coming up as somebody else.
 *
 * The unit fingerprint is written in full rather than truncated. It is a hash
 * of factory calibration, not a secret, and a prefix that collides is worth
 * less than no column at all.
 */
export function exportFleetRecord(
  roster: readonly FleetUnit[],
  outcomes: Readonly<Record<string, FleetOutcome>>,
): string {
  let out = writeRow(['label', 'dmrId', 'name', 'state', 'at', 'blocks', 'unit', 'note'])
  for (const u of roster) {
    const o = outcomes[u.id]
    out += writeRow([
      u.label,
      u.dmrId === null ? '' : String(u.dmrId),
      u.name,
      o?.state ?? 'pending',
      o?.at ?? '',
      o ? String(o.blocks) : '',
      o?.unitHash ?? '',
      o?.note ?? '',
    ])
  }
  return out
}
