// SPDX-License-Identifier: GPL-3.0-or-later
import { chirpMode, txFrequency, type Channel } from '../model/channel.js'
import { sortedChannels, type Codeplug } from '../model/codeplug.js'
import { describeTone } from '../model/tones.js'
import { formatFreq, formatPower } from '../model/units.js'

/**
 * The channel plan as something a person can be handed.
 *
 * A `.bwp` is the whole radio and a CHIRP CSV is a spreadsheet import; neither
 * is what a club passes around when the plan is being agreed. This produces the
 * missing third thing - one self-contained HTML file, or the same table in
 * Markdown - that can be emailed, pasted into a wiki, or printed by someone who
 * has never heard of boofwang.
 *
 * Two properties define the format and are worth stating plainly.
 *
 * The first is that **no key material is here, in any form**. Not the key, not
 * a masked key, not the name of the slot it sits in. A summary is a thing
 * people forward without thinking about it, and the moment a key can travel
 * that way the mask becomes theatre - a 10-character ARC4 key with four
 * characters showing is not protected, and a slot named "SHERIFF TAC" tells a
 * reader what the encrypted channel is for. `.bwp` already exists for when the
 * whole codeplug is genuinely wanted. Mechanically this is why the file builds
 * its rows from a fixed list of channel fields rather than projecting the
 * codeplug: `Codeplug.encryptionKeys` is never read here, and neither is
 * `Channel.extras`, which on the DM-32UV carries the key slot a channel uses.
 *
 * The second is that receive-only is carried as **words**, never as a colour.
 * The output is meant to be printed, and a tint is the first thing a printer
 * loses - so a channel that must not be transmitted on says so where its
 * transmit frequency would otherwise be.
 */

/** What a receive-only channel says in the transmit column. */
export const RECEIVE_ONLY = 'receive only'

/**
 * Stated in the file itself, not only in this comment.
 *
 * Someone reading a forwarded summary has no way to know whether the keys were
 * left out or the radio simply had none, and those are very different facts.
 */
export const KEY_OMISSION_NOTE =
  'This summary never includes encryption keys or the names of their slots. ' +
  'Save a .bwp codeplug if the whole radio is wanted.'

/** The columns every summary carries, in order. `Notes` is appended when earned. */
export const SUMMARY_COLUMNS = [
  'Slot', 'Name', 'Receive', 'Transmit', 'TX tone', 'RX tone', 'Mode', 'Power',
] as const

export interface SummaryRow {
  readonly slot: number
  readonly name: string
  readonly rx: string
  /** The transmit frequency, or `RECEIVE_ONLY`. */
  readonly tx: string
  readonly toneTx: string
  readonly toneRx: string
  readonly mode: string
  readonly power: string
  readonly notes: string
  readonly receiveOnly: boolean
}

export interface CodeplugSummary {
  readonly title: string
  readonly radio: string
  /** Empty when the source did not record one - an imported CSV, say. */
  readonly firmware: string
  /** ISO 8601. */
  readonly generatedAt: string
  readonly channelCount: number
  readonly receiveOnlyCount: number
  readonly columns: readonly string[]
  readonly rows: readonly SummaryRow[]
  /** True when at least one channel carries a note, so the column earns its width. */
  readonly showNotes: boolean
}

export interface SummaryOptions {
  /** How the radio should be named: `Baofeng DM-32UV` rather than `dm32uv`. */
  radio?: string
  firmware?: string
  title?: string
  /** ISO 8601. Supplied by the caller so a test can pin it. */
  generatedAt?: string
}

/**
 * One row, from an explicit list of channel fields.
 *
 * Written out field by field rather than spread from the channel, because a
 * spread would silently start carrying whatever a future driver decides to hang
 * off `extras` - which for the DM-32UV is already the encryption key slot a
 * channel uses.
 */
function toRow(c: Channel): SummaryRow {
  const tx = txFrequency(c)
  return {
    slot: c.index,
    name: c.name,
    rx: formatFreq(c.rxFreq),
    tx: tx === null ? RECEIVE_ONLY : formatFreq(tx),
    toneTx: describeTone(c.tone.tx),
    toneRx: describeTone(c.tone.rx),
    mode: chirpMode(c),
    power: c.power.label ?? formatPower(c.power.mW),
    notes: c.comment,
    receiveOnly: !c.txAllowed,
  }
}

export function buildSummary(cp: Codeplug, opts: SummaryOptions = {}): CodeplugSummary {
  const channels = sortedChannels(cp)
  const rows = channels.map(toRow)
  const showNotes = rows.some((r) => r.notes !== '')
  const radio = opts.radio ?? cp.radio ?? 'an unknown radio'

  return {
    title: opts.title ?? `${radio} channel plan`,
    radio,
    firmware: opts.firmware ?? cp.meta.variant ?? '',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    channelCount: rows.length,
    receiveOnlyCount: rows.filter((r) => r.receiveOnly).length,
    columns: showNotes ? [...SUMMARY_COLUMNS, 'Notes'] : [...SUMMARY_COLUMNS],
    rows,
    showNotes,
  }
}

/** The cells of one row, in `columns` order. */
function cells(s: CodeplugSummary, r: SummaryRow): string[] {
  const out = [String(r.slot), r.name, r.rx, r.tx, r.toneTx, r.toneRx, r.mode, r.power]
  if (s.showNotes) out.push(r.notes)
  return out
}

/**
 * `2026-08-21 14:32 UTC`, or the string as given when it is not a date.
 *
 * UTC rather than the exporting machine's zone: the reader is somewhere else,
 * and a local time with no offset on it is a small lie.
 */
function formatStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * The whole document, styles included, referring to nothing outside itself.
 *
 * No stylesheet link, no font, no script and no image: the site itself has no
 * external asset hosts, and a summary that fetched one would break in exactly
 * the situations this format is for - an attachment opened offline, a file
 * dropped on a laptop in a car park before a net.
 */
export function summaryHtml(s: CodeplugSummary): string {
  const facts: [string, string][] = [
    ['Radio', s.radio],
    ...(s.firmware ? ([['Firmware', s.firmware]] as [string, string][]) : []),
    ['Channels', String(s.channelCount)],
    ...(s.receiveOnlyCount > 0
      ? ([['Receive-only', `${s.receiveOnlyCount} of ${s.channelCount}`]] as [string, string][])
      : []),
    ['Generated', formatStamp(s.generatedAt)],
  ]

  const head = s.columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join('')

  const body = s.rows
    .map((r) => {
      const tds = cells(s, r)
        .map((value, i) => {
          // Only the transmit cell is marked, and the marking is the word it
          // already contains; the class exists to weight it, not to carry it.
          const cls = i === 3 && r.receiveOnly ? ' class="rx-only"' : ''
          return `<td${cls}>${escapeHtml(value) || '&mdash;'}</td>`
        })
        .join('')
      return `<tr>${tds}</tr>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(s.title)}</title>
<style>
:root { color-scheme: light dark; }
body {
  margin: 0 auto; padding: 28px 20px 48px; max-width: 60rem;
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  background: #ffffff; color: #14191c;
}
h1 { margin: 0 0 4px; font-size: 21px; letter-spacing: -0.02em; }
.facts { margin: 0 0 18px; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 22px; font-size: 13.5px; }
.facts div { display: flex; gap: 6px; }
.facts dt { color: #58646c; }
.facts dd { margin: 0; font-weight: 600; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { padding: 4px 8px; text-align: left; border-bottom: 1px solid #dfe3e6; vertical-align: top; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #58646c; border-bottom: 1px solid #c6ced4; }
td:first-child, td:nth-child(3), td:nth-child(4), td:nth-child(5), td:nth-child(6), td:nth-child(8) {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace; font-variant-numeric: tabular-nums;
}
td:first-child { text-align: right; color: #58646c; }
.rx-only { font-weight: 600; }
.note { margin-top: 20px; font-size: 12.5px; color: #58646c; max-width: 62ch; }
@media (prefers-color-scheme: dark) {
  body { background: #101315; color: #e8ecee; }
  th, td { border-bottom-color: #252b30; }
  th, td:first-child, .facts dt, .note { color: #96a0a7; }
}
@media print {
  body { padding: 0; max-width: none; background: #ffffff; color: #000000; font-size: 10pt; }
  table { font-size: 9pt; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
}
</style>
</head>
<body>
<h1>${escapeHtml(s.title)}</h1>
<dl class="facts">
${facts.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('\n')}
</dl>
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
<p class="note">${escapeHtml(KEY_OMISSION_NOTE)}</p>
</body>
</html>
`
}

/**
 * The same table as Markdown.
 *
 * Cheap to produce and it is what gets pasted into a wiki or an issue, where an
 * HTML attachment is the wrong shape. Pipes in a cell are escaped rather than
 * stripped, because a channel called `A|B` should survive being written down.
 */
export function summaryMarkdown(s: CodeplugSummary): string {
  const cell = (value: string) => (value === '' ? '—' : value.replaceAll('|', '\\|').replaceAll('\n', ' '))
  const line = (values: readonly string[]) => `| ${values.join(' | ')} |`

  const facts = [
    `**Radio:** ${s.radio}`,
    ...(s.firmware ? [`**Firmware:** ${s.firmware}`] : []),
    `**Channels:** ${s.channelCount}`,
    ...(s.receiveOnlyCount > 0 ? [`**Receive-only:** ${s.receiveOnlyCount}`] : []),
    `**Generated:** ${formatStamp(s.generatedAt)}`,
  ]

  return [
    `# ${s.title}`,
    '',
    facts.join(' · '),
    '',
    line(s.columns),
    line(s.columns.map(() => '---')),
    ...s.rows.map((r) => line(cells(s, r).map(cell))),
    '',
    KEY_OMISSION_NOTE,
    '',
  ].join('\n')
}
