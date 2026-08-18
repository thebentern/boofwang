// SPDX-License-Identifier: GPL-3.0-or-later
import { chirpMode, txFrequency, type Channel } from '../model/channel.js'
import { sortedChannels, type Codeplug } from '../model/codeplug.js'
import { formatCtcss, formatDtcs, type ToneSpec } from '../model/tones.js'
import { formatFreq, formatPower, hz, type Hz } from '../model/units.js'
import { writeRow } from './csv-text.js'

/**
 * CHIRP's generic CSV.
 *
 * The column list and every format string are transcribed from
 * `Memory.CSV_FORMAT` and `Memory.to_csv` in CHIRP's `chirp/chirp_common.py`
 * (GPL-3.0). The aim is output that is byte-identical to CHIRP's, so a file
 * from boofwang and a file from CHIRP describing the same channels compare
 * equal - which is the only interoperability claim worth making.
 */

export const CSV_COLUMNS = [
  'Location', 'Name', 'Frequency',
  'Duplex', 'Offset', 'Tone',
  'rToneFreq', 'cToneFreq', 'DtcsCode',
  'DtcsPolarity', 'RxDtcsCode',
  'CrossMode',
  'Mode', 'TStep',
  'Skip', 'Power', 'Comment',
  'URCALL', 'RPT1CALL', 'RPT2CALL', 'DVCODE',
] as const

/**
 * Values a fresh `chirp_common.Memory` carries.
 *
 * They are written even for channels that have no tone at all, because CHIRP
 * writes them - and an export that omits them would not compare equal.
 */
const DEFAULTS = {
  rtone: 885,
  ctone: 885,
  dtcs: 23,
  rxDtcs: 23,
  dtcsPolarity: 'NN',
  crossMode: 'Tone->Tone',
} as const

type ToneTriple = { mode: '' | 'Tone' | 'DTCS'; val: number | null; pol: 'N' | 'R' | null }

function toTriple(t: ToneSpec | null): ToneTriple {
  if (t === null) return { mode: '', val: null, pol: null }
  if (t.kind === 'ctcss') return { mode: 'Tone', val: t.deciHz, pol: null }
  return { mode: 'DTCS', val: t.code, pol: t.polarity }
}

export interface ChirpToneFields {
  tmode: string
  rtone: number
  ctone: number
  dtcs: number
  rxDtcs: number
  dtcsPolarity: string
  crossMode: string
}

/**
 * Collapse a normalised tone pair into CHIRP's seven fields.
 *
 * This is `split_tone_decode` from `chirp_common.py` run forwards: given the
 * transmit and receive tone specs, it picks the narrowest `tmode` that
 * represents them, falling back to `Cross` when the two sides genuinely differ.
 * Reproducing its exact preference order matters, because a channel written as
 * `Cross` when CHIRP would have written `TSQL` is not a byte-identical export.
 */
export function encodeToneFields(tone: Channel['tone']): ChirpToneFields {
  const tx = toTriple(tone.tx)
  const rx = toTriple(tone.rx)

  const out: ChirpToneFields = {
    tmode: '',
    rtone: DEFAULTS.rtone,
    ctone: DEFAULTS.ctone,
    dtcs: DEFAULTS.dtcs,
    rxDtcs: DEFAULTS.rxDtcs,
    dtcsPolarity: `${tx.pol ?? 'N'}${rx.pol ?? 'N'}`,
    crossMode: DEFAULTS.crossMode,
  }

  if (tx.mode === '' && rx.mode === '') return out

  if (tx.mode === 'Tone' && rx.mode === '') {
    out.tmode = 'Tone'
    out.rtone = tx.val!
    return out
  }

  if (tx.mode === 'Tone' && rx.mode === 'Tone' && tx.val === rx.val) {
    out.tmode = tone.rxInverted ? 'TSQL-R' : 'TSQL'
    out.ctone = tx.val!
    return out
  }

  if (tx.mode === 'DTCS' && rx.mode === 'DTCS' && tx.val === rx.val) {
    out.tmode = tone.rxInverted ? 'DTCS-R' : 'DTCS'
    out.dtcs = tx.val!
    return out
  }

  out.tmode = 'Cross'
  out.crossMode = `${tx.mode}->${rx.mode}`
  if (tx.mode === 'Tone') out.rtone = tx.val!
  else if (tx.mode === 'DTCS') out.dtcs = tx.val!
  if (rx.mode === 'Tone') out.ctone = rx.val!
  else if (rx.mode === 'DTCS') out.rxDtcs = rx.val!
  return out
}

export interface DuplexFields {
  duplex: '' | '+' | '-' | 'split' | 'off'
  offset: Hz
}

/**
 * CHIRP's `Duplex` and `Offset`.
 *
 * A receive-only channel becomes `off`, which is CHIRP's transmit-inhibit
 * marker, and takes precedence over any shift the channel also carries. Losing
 * that here would be the exact failure the model's separate `txAllowed` flag
 * exists to prevent.
 */
export function encodeDuplex(ch: Channel): DuplexFields {
  if (!ch.txAllowed) return { duplex: 'off', offset: hz(0) }
  switch (ch.tx.kind) {
    case 'simplex':
      return { duplex: '', offset: hz(0) }
    case 'offset':
      return { duplex: ch.tx.direction === 'plus' ? '+' : '-', offset: ch.tx.offset }
    case 'split':
      // In split mode CHIRP puts the absolute transmit frequency in Offset.
      return { duplex: 'split', offset: ch.tx.txFreq }
  }
}

/** CHIRP's `TStep`: kHz with two decimals. */
export function formatTStep(step: Hz): string {
  return (step / 1000).toFixed(2)
}

const SKIP_TO_CSV = { none: '', skip: 'S', pskip: 'P' } as const

export function channelToRow(ch: Channel): string[] {
  const tones = encodeToneFields(ch.tone)
  const { duplex, offset } = encodeDuplex(ch)

  return [
    String(ch.index),
    ch.name,
    formatFreq(ch.rxFreq),
    duplex,
    formatFreq(offset),
    tones.tmode,
    formatCtcss(tones.rtone),
    formatCtcss(tones.ctone),
    formatDtcs(tones.dtcs),
    tones.dtcsPolarity,
    formatDtcs(tones.rxDtcs),
    tones.crossMode,
    chirpMode(ch),
    formatTStep(ch.tuningStep),
    SKIP_TO_CSV[ch.skip],
    // Watts, not the radio's own level name: CHIRP's importer runs this column
    // through `parse_power`, which rejects "High".
    formatPower(ch.power.mW),
    ch.comment,
    '', '', '', '',
  ]
}

export interface ExportOptions {
  /** Comment lines emitted before the header, each prefixed with `#`. */
  header?: readonly string[]
  /** Restrict the export to these memory slots. */
  slots?: readonly number[]
}

export function exportChirpCsv(cp: Codeplug, opts: ExportOptions = {}): string {
  let out = ''
  for (const line of opts.header ?? []) out += writeRow([`# ${line}`])
  out += writeRow(CSV_COLUMNS)

  const wanted = opts.slots ? new Set(opts.slots) : null
  for (const ch of sortedChannels(cp)) {
    if (wanted && !wanted.has(ch.index)) continue
    out += writeRow(channelToRow(ch))
  }
  return out
}

/**
 * A default header naming the source.
 *
 * Worth emitting: a bare CSV gives no clue which radio or firmware it came
 * from, and CHIRP preserves leading `#` lines on load, so it survives a
 * round trip through CHIRP itself.
 */
export function defaultHeader(cp: Codeplug): string[] {
  const lines = [`Exported by boofwang from ${cp.radio ?? 'an unknown radio'}`]
  if (cp.meta.variant) lines.push(`Firmware: ${cp.meta.variant}`)
  const rxOnly = [...cp.channels.values()].filter((c) => !c.txAllowed).length
  if (rxOnly > 0) {
    lines.push(`${rxOnly} channel(s) are receive-only and exported with Duplex=off`)
  }
  return lines
}

/** Channels a target radio cannot represent as receive-only. */
export function txInhibitConflicts(cp: Codeplug, supportsTxInhibit: boolean): Channel[] {
  if (supportsTxInhibit) return []
  return [...cp.channels.values()].filter((c) => !c.txAllowed)
}

export { txFrequency }
