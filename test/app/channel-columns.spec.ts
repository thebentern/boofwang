// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The optional columns have to stay in step across three places.
 *
 * `OPTIONAL_COLUMNS` supplies the width that builds the CSS grid template, the
 * header row draws a label, and the body row draws a cell. Miss one and nothing
 * throws: the grid gets a track with no content, or content with no track, and
 * every column after it shifts by one. On a table of four thousand channels
 * that reads as "the frequencies are wrong" rather than as a layout bug.
 *
 * A source check, matching the rest of this suite: there is no Vue harness
 * here, and what is being guarded is that three lists agree.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../app/components/ChannelTable.vue', import.meta.url)),
  'utf8',
)

/** The declared columns, in order, with their widths. */
const declared = [...SOURCE.matchAll(/\{ key: '(\w+)', label: '([^']*)', width: (\d+) \}/g)].map((m) => ({
  key: m[1]!,
  label: m[2]!,
  width: Number(m[3]),
}))

describe('the optional channel columns', () => {
  it('declares the ones the toolbar offers', () => {
    expect(declared.map((c) => c.key)).toEqual(['tone', 'mode', 'bandwidth', 'step', 'power', 'flag'])
  })

  it('gives every one a width, or the grid has a track with no size', () => {
    for (const c of declared) expect(c.width, c.key).toBeGreaterThan(0)
  })

  it('draws a header cell for every declared column', () => {
    for (const c of declared) {
      expect(SOURCE, `no header cell for ${c.key}`).toMatch(new RegExp(`v-if="optional\\.${c.key}"`))
    }
  })

  it('draws exactly one body cell for every declared column', () => {
    // Two references each: the header and the body. Three would mean a stray
    // cell and a shifted grid, one would mean a missing cell and the same.
    for (const c of declared) {
      const uses = [...SOURCE.matchAll(new RegExp(`v-if="optional\\.${c.key}"`, 'g'))].length
      expect(uses, `${c.key} appears ${uses} times, expected header + body`).toBe(2)
    }
  })

  it('has a default for every declared column', () => {
    const defaults = SOURCE.slice(SOURCE.indexOf('const optional = reactive({'))
    const line = defaults.slice(0, defaults.indexOf('})') + 2)
    for (const c of declared) expect(line, `${c.key} has no default`).toMatch(new RegExp(`\\b${c.key}:`))
  })

  it('builds a row value for every declared column', () => {
    // The view object the body reads from. A column with no value renders
    // undefined, which shows as an empty cell rather than an error.
    for (const c of declared) {
      expect(SOURCE, `no row value for ${c.key}`).toMatch(new RegExp(`\\n\\s+${c.key}: `))
    }
  })
})

describe('bandwidth', () => {
  it('comes from the frequency, not from the mode string', () => {
    // Mode is FM or NFM, which is the same fact rounded to a word. The point of
    // the column is the number the regulations are actually written in: 47 CFR
    // 95.2763 says 11.25 kHz, not "narrow".
    expect(SOURCE).toMatch(/bandwidth: c \? \(c\.bandwidthHz \/ 1000\)\.toFixed\(2\) : /)
  })

  it('is shown by default, beside Mode', () => {
    const keys = declared.map((c) => c.key)
    expect(keys.indexOf('bandwidth')).toBe(keys.indexOf('mode') + 1)
    expect(SOURCE).toMatch(/const optional = reactive\(\{[^}]*bandwidth: true/)
  })
})
