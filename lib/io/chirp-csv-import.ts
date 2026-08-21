// SPDX-License-Identifier: GPL-3.0-or-later
import { parseCsv } from './csv-text.js'
import { CSV_COLUMNS } from './chirp-csv.js'
import type { Channel, TxSpec } from '../model/channel.js'
import {
  DTCS_CODES,
  NO_TONE,
  ctcss,
  dtcs,
  nearestCtcss,
  type TonePair,
  type ToneSpec,
} from '../model/tones.js'
import { hz, mW, type Hz } from '../model/units.js'

/**
 * Read a CHIRP CSV.
 *
 * The counterpart to `exportChirpCsv`, and the reason RepeaterBook works: its
 * "CHIRP export" is this format, so anything that can read a CHIRP CSV can read
 * a RepeaterBook one without a network call, an API token, or a User-Agent a
 * browser is not allowed to set.
 *
 * Driven by the header names rather than by column position. CHIRP has shipped
 * a 17-column file and a 21-column one, exporters reorder columns, and
 * RepeaterBook adds its own. Reading positionally would silently put an offset
 * in the tone column.
 */

export interface CsvRowIssue {
  /** 1-based line in the file, counting the header and any comments. */
  readonly line: number
  readonly severity: 'error' | 'warning'
  readonly message: string
}

export interface CsvImportResult {
  readonly channels: readonly Channel[]
  readonly issues: readonly CsvRowIssue[]
  /** Column headers the file carried that this build does not use. */
  readonly unknownColumns: readonly string[]
}

/** CHIRP writes DTCS as three digits, tones as one decimal, frequencies in MHz. */
function parseFreqMHz(s: string): Hz | null {
  const v = Number.parseFloat(s.trim())
  if (!Number.isFinite(v) || v < 0) return null
  return hz(Math.round(v * 1e6))
}

function parseCtcss(s: string): number | null {
  const v = Number.parseFloat(s.trim())
  if (!Number.isFinite(v)) return null
  return Math.round(v * 10)
}

/**
 * Rebuild the tone pair from CHIRP's seven columns.
 *
 * `Tone` is the mode and the other six are values that may or may not apply to
 * it; CHIRP writes all of them regardless, so reading a value without checking
 * the mode invents tones on channels that have none.
 */
function readTone(get: (c: string) => string, push: (i: Omit<CsvRowIssue, 'line'>) => void): TonePair {
  const mode = get('Tone').trim().toUpperCase()
  if (mode === '' || mode === 'NONE') return NO_TONE

  const rtoneRaw = parseCtcss(get('rToneFreq'))
  const ctoneRaw = parseCtcss(get('cToneFreq'))
  const dtcsCode = Number.parseInt(get('DtcsCode').trim(), 10)
  const rxDtcsCode = Number.parseInt(get('RxDtcsCode').trim(), 10)
  const polarity = get('DtcsPolarity').trim().toUpperCase() || 'NN'

  const snap = (raw: number | null): ToneSpec | null => {
    if (raw === null) return null
    const near = nearestCtcss(raw)
    if (near !== raw) {
      push({ severity: 'warning', message: `${(raw / 10).toFixed(1)} Hz is not a standard CTCSS tone; using ${(near / 10).toFixed(1)} Hz.` })
    }
    return ctcss(near)
  }

  const dtcsOf = (code: number, pol: string): ToneSpec | null => {
    if (!Number.isFinite(code)) return null
    if (!DTCS_CODES.includes(code)) {
      // A wrong DCS code keeps squelch shut, which is worse than none at all.
      push({ severity: 'error', message: `DCS code ${code} is not a standard code; the tone was dropped.` })
      return null
    }
    return dtcs(code, pol === 'R' ? 'R' : 'N')
  }

  switch (mode) {
    case 'TONE':
      // Transmit only. CHIRP puts the transmitted tone in rToneFreq.
      return { rx: null, tx: snap(rtoneRaw), rxInverted: false }
    case 'TSQL':
      return { rx: snap(ctoneRaw), tx: snap(ctoneRaw), rxInverted: false }
    case 'TSQL-R':
      return { rx: snap(ctoneRaw), tx: null, rxInverted: true }
    case 'DTCS':
      return { rx: dtcsOf(dtcsCode, polarity[0] ?? 'N'), tx: dtcsOf(dtcsCode, polarity[0] ?? 'N'), rxInverted: false }
    case 'DTCS-R':
      return { rx: dtcsOf(dtcsCode, polarity[0] ?? 'N'), tx: null, rxInverted: true }
    case 'CROSS': {
      const cross = get('CrossMode').trim()
      const [txPart = '', rxPart = ''] = cross.split('->')
      const pick = (part: string, isRx: boolean): ToneSpec | null => {
        if (part === 'Tone') return snap(isRx ? ctoneRaw : rtoneRaw)
        if (part === 'DTCS') {
          return dtcsOf(isRx ? rxDtcsCode : dtcsCode, (isRx ? polarity[1] : polarity[0]) ?? 'N')
        }
        return null
      }
      return { rx: pick(rxPart, true), tx: pick(txPart, false), rxInverted: false }
    }
    default:
      push({ severity: 'warning', message: `Tone mode ${JSON.stringify(mode)} is not one this build reads; the tone was dropped.` })
      return NO_TONE
  }
}

/** CHIRP writes power as watts with a W suffix: "5.0W", "1W". */
function parsePower(s: string): number | null {
  const m = /^([\d.]+)\s*w?$/i.exec(s.trim())
  if (!m) return null
  const watts = Number.parseFloat(m[1]!)
  return Number.isFinite(watts) ? Math.round(watts * 1000) : null
}

const MODE_BANDWIDTH: Record<string, { modulation: Channel['modulation']; bandwidthHz: number }> = {
  FM: { modulation: 'FM', bandwidthHz: 25_000 },
  NFM: { modulation: 'FM', bandwidthHz: 12_500 },
  AM: { modulation: 'AM', bandwidthHz: 25_000 },
  NAM: { modulation: 'AM', bandwidthHz: 12_500 },
}

/**
 * Parse a CHIRP CSV into channels.
 *
 * Never throws on a bad row. A file with one unreadable line still yields every
 * other channel, and the problem is reported against the line it came from -
 * losing an entire import because row 43 has a typo is not a service to anyone.
 */
export function importChirpCsv(text: string): CsvImportResult {
  const issues: CsvRowIssue[] = []
  const channels: Channel[] = []

  // Strip a BOM; some exporters emit one and it corrupts the first header name.
  const clean = text.replace(/^\uFEFF/, '')
  const rows = parseCsv(clean)

  /*
   * The header is the first row carrying both Location and Frequency, wherever
   * in the row they sit.
   *
   * Requiring Location to come first would reject any exporter that reorders
   * columns - which is exactly what this parser reads by name to tolerate.
   * Leading comments and blank lines fall out of the same search.
   */
  let headerAt = -1
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] ?? []).map((c) => c.trim().toLowerCase())
    if (cells.includes('location') && cells.includes('frequency')) { headerAt = i; break }
  }
  if (headerAt < 0) {
    return {
      channels: [],
      issues: [{ line: 1, severity: 'error', message: 'This file has no CHIRP header row, so it is not a CHIRP CSV.' }],
      unknownColumns: [],
    }
  }

  const header = rows[headerAt]!.map((h) => h.trim())
  const index = new Map(header.map((h, i) => [h.toLowerCase(), i]))
  const known = new Set(CSV_COLUMNS.map((c) => c.toLowerCase()))
  const unknownColumns = header.filter((h) => h && !known.has(h.toLowerCase()))

  for (let r = headerAt + 1; r < rows.length; r++) {
    const row = rows[r]!
    const line = r + 1
    if (row.length === 0 || (row.length === 1 && !row[0]?.trim())) continue
    if (row[0]?.trim().startsWith('#')) continue

    const get = (col: string) => {
      const at = index.get(col.toLowerCase())
      return at === undefined ? '' : (row[at] ?? '')
    }
    const push = (i: Omit<CsvRowIssue, 'line'>) => issues.push({ line, ...i })

    const slot = Number.parseInt(get('Location').trim(), 10)
    if (!Number.isFinite(slot)) {
      push({ severity: 'error', message: 'Row has no channel number; skipped.' })
      continue
    }

    const rxFreq = parseFreqMHz(get('Frequency'))
    if (rxFreq === null || rxFreq === 0) {
      push({ severity: 'error', message: 'Row has no usable frequency; skipped.' })
      continue
    }

    const duplex = get('Duplex').trim()
    const offset = parseFreqMHz(get('Offset')) ?? hz(0)
    let tx: TxSpec = { kind: 'simplex' }
    let txAllowed = true
    let txInhibitReason: string | undefined

    if (duplex === 'off') {
      txAllowed = false
      txInhibitReason = 'Marked receive-only in the file this came from'
    } else if (duplex === '+' && offset > 0) {
      tx = { kind: 'offset', direction: 'plus', offset }
    } else if (duplex === '-' && offset > 0) {
      tx = { kind: 'offset', direction: 'minus', offset }
    } else if (duplex === 'split') {
      tx = { kind: 'split', txFreq: offset }
    }

    const modeRaw = get('Mode').trim().toUpperCase()
    const mode = MODE_BANDWIDTH[modeRaw]
    if (!mode && modeRaw) {
      push({ severity: 'warning', message: `Mode ${JSON.stringify(modeRaw)} is not one this build reads; using FM.` })
    }

    const powerMw = parsePower(get('Power'))

    // TStep is written in kilohertz ("12.50"), unlike every other frequency
    // column in the file, which are megahertz.
    const stepKHz = Number.parseFloat(get('TStep').trim())

    channels.push({
      index: slot,
      name: get('Name').trim(),
      rxFreq,
      tx,
      txAllowed,
      ...(txInhibitReason === undefined ? {} : { txInhibitReason }),
      tone: readTone(get, push),
      modulation: mode?.modulation ?? 'FM',
      bandwidthHz: mode?.bandwidthHz ?? 25_000,
      power: { mW: mW(powerMw ?? 5000) },
      tuningStep: hz(Number.isFinite(stepKHz) ? Math.round(stepKHz * 1000) : 5000),
      skip: get('Skip').trim().toUpperCase() === 'S' ? 'skip' : 'none',
      comment: get('Comment').trim(),
      extras: {},
    })
  }

  return { channels, issues, unknownColumns }
}
