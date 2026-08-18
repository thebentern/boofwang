// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * RFC 4180 CSV, matching Python's `csv` module in the configuration CHIRP uses.
 *
 * CHIRP writes with `csv.writer(f, delimiter=',')` on a file opened
 * `newline=''`, which means the excel dialect: QUOTE_MINIMAL and a **CRLF**
 * line terminator. Getting the line ending wrong is the difference between an
 * export that is byte-identical to CHIRP's and one that merely looks right.
 */

export const CRLF = '\r\n'

/** Quote only when required, as Python's QUOTE_MINIMAL does. */
export function quoteField(value: string, delimiter = ','): string {
  const needsQuote =
    value.includes(delimiter) || value.includes('"') || value.includes('\r') || value.includes('\n')
  if (!needsQuote) return value
  return `"${value.replaceAll('"', '""')}"`
}

export function writeRow(fields: readonly string[], delimiter = ','): string {
  return fields.map((f) => quoteField(f, delimiter)).join(delimiter) + CRLF
}

/**
 * Split CSV text into rows of fields.
 *
 * Handles quoted fields containing delimiters, doubled quotes, and embedded
 * newlines, and accepts CRLF, LF or CR line endings on input - CHIRP writes
 * CRLF but plenty of tools that produce "CHIRP CSV" do not, and rejecting those
 * would help nobody.
 */
export function parseCsv(text: string, delimiter = ','): string[][] {
  // Strip a UTF-8 BOM: CHIRP reads with utf-8-sig and Excel loves to add one.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let sawAny = false

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }

    if (c === '"' && field === '') {
      inQuotes = true
      sawAny = true
      continue
    }
    if (c === delimiter) {
      row.push(field)
      field = ''
      sawAny = true
      continue
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      sawAny = false
      continue
    }
    field += c
    sawAny = true
  }

  if (field !== '' || row.length > 0 || sawAny) {
    row.push(field)
    rows.push(row)
  }

  return rows
}
