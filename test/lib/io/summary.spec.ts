// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createUvk5Driver } from '#core/radios/uvk5/driver.js'
import {
  KEY_OMISSION_NOTE,
  RECEIVE_ONLY,
  SUMMARY_COLUMNS,
  buildSummary,
  summaryHtml,
  summaryMarkdown,
} from '#core/io/summary.js'
import { maskKey } from '#core/model/encryption.js'
import type { Channel } from '#core/model/channel.js'
import type { Codeplug } from '#core/model/codeplug.js'
import { CHIRP_ATTRS, CHIRP_CHANNELS, buildEeprom, imageFrom } from '../radios/uvk5/fixture.js'

const driver = createUvk5Driver()

const FIXTURE = buildEeprom([
  { slot: 0, record: CHIRP_CHANNELS.SIMPLEX, name: 'CALLING', attr: CHIRP_ATTRS.SL1_BAND2 },
  { slot: 1, record: CHIRP_CHANNELS.REPEATER, name: 'W4ABC', attr: CHIRP_ATTRS.SL1_BAND2 },
  { slot: 2, record: CHIRP_CHANNELS.UHF_PLUS, name: 'UHF RPT', attr: CHIRP_ATTRS.SL1_BAND2 },
  { slot: 3, record: CHIRP_CHANNELS.TX_DISABLED, name: 'WX3', attr: CHIRP_ATTRS.NONE_BAND2 },
])

/**
 * Key material that could not plausibly arrive any other way.
 *
 * All letters, so that a four-character run of it cannot be confused with a
 * frequency, a colour in the stylesheet or a word in the prose - which is what
 * makes the "not even partially" assertion below mean something.
 */
const SECRET_HEX = 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB'
const SECRET_SLOT_NAME = 'SHERIFF NARCOTICS TAC'

const AT = '2026-08-21T14:32:07.000Z'

function decode(): Codeplug {
  return driver.decode(imageFrom(FIXTURE))
}

/**
 * A codeplug carrying keys, and channels that point at them.
 *
 * Both halves matter. `encryptionKeys` is the obvious leak; `extras.vendor` is
 * the quiet one, because that is where the DM-32UV records which key slot a
 * channel uses, and a summary built by spreading a channel would carry it.
 */
function withKeys(): Codeplug {
  const cp = decode()
  cp.encryptionKeys = [
    { id: 'k1', slot: 1, name: SECRET_SLOT_NAME, type: 'aes128', keyHex: SECRET_HEX },
    { id: 'k2', slot: 2, name: 'SPARE', type: 'arc4', keyHex: 'FEDCBAFEDC' },
  ]
  for (const [index, channel] of cp.channels) {
    cp.channels.set(index, {
      ...channel,
      extras: { ...channel.extras, vendor: { ...channel.extras.vendor, encryptionKeyId: '1', keyHex: SECRET_HEX } },
    })
  }
  return cp
}

/** Every four-character run of a key, which is what "not even partially" comes down to. */
function windows(hex: string, size = 4): string[] {
  const out: string[] = []
  for (let i = 0; i + size <= hex.length; i++) out.push(hex.slice(i, i + size))
  return out
}

describe('a summary cannot carry key material', () => {
  const summary = buildSummary(withKeys(), { radio: 'Quansheng UV-K5', firmware: '2.01.32', generatedAt: AT })
  const html = summaryHtml(summary)
  const markdown = summaryMarkdown(summary)
  const outputs: [string, string][] = [
    ['HTML', html],
    ['Markdown', markdown],
    ['the summary model', JSON.stringify(summary)],
  ]

  it('never emits the key itself', () => {
    for (const [what, text] of outputs) {
      expect(text.includes(SECRET_HEX), `${what} contains the key`).toBe(false)
      expect(text.includes('FEDCBAFEDC'), `${what} contains the second key`).toBe(false)
    }
  })

  it('never emits part of a key either', () => {
    // A mask is not a redaction. Four characters of an AES key is a foothold,
    // and four of the ten in an ARC4 key is nearly the whole thing.
    for (const [what, text] of outputs) {
      const lower = text.toLowerCase()
      const found = windows(SECRET_HEX).filter((w) => lower.includes(w.toLowerCase()))
      expect([...new Set(found)], `${what} contains fragments of the key`).toEqual([])
    }
  })

  it('never emits a masked key', () => {
    const masked = maskKey(SECRET_HEX)
    for (const [what, text] of outputs) {
      expect(text.includes(masked), `${what} contains the masked key`).toBe(false)
      expect(text.includes('•'), `${what} contains mask characters`).toBe(false)
    }
  })

  it('never emits the name of a key slot', () => {
    // The name is the leak people forget. "SHERIFF NARCOTICS TAC" tells a
    // reader what the encrypted channel is for without disclosing a byte of it.
    for (const [what, text] of outputs) {
      expect(text.includes(SECRET_SLOT_NAME), `${what} names a key slot`).toBe(false)
      expect(text.toLowerCase().includes('sheriff'), `${what} names a key slot`).toBe(false)
    }
  })

  it('never emits the key slot a channel points at', () => {
    for (const [what, text] of outputs) {
      expect(text.includes('encryptionKeyId'), `${what} carries a channel's key slot`).toBe(false)
    }
  })

  it('says so in the file, because absence is not self-evident', () => {
    // Without the note, a reader cannot tell an omitted key from a radio that
    // had none - and those are very different facts about a channel plan.
    expect(html).toContain(KEY_OMISSION_NOTE)
    expect(markdown).toContain(KEY_OMISSION_NOTE)
  })

  it('is built without ever reading the codeplug’s keys', () => {
    // The assertions above are about one fixture; this is about the code. A
    // summary that never mentions key material cannot regress into emitting it
    // by way of a field someone adds to Channel or Codeplug later.
    const source = readFileSync(fileURLToPath(new URL('../../../lib/io/summary.ts', import.meta.url)), 'utf8')
    // Comments removed, because the file explains at length what it does not
    // read, and those sentences are the reason it does not.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const forbidden of ['encryptionKeys', 'keyHex', 'maskKey', 'extras']) {
      expect(code.includes(forbidden), `summary.ts reaches for ${forbidden}`).toBe(false)
    }
  })
})

describe('the summary itself', () => {
  const summary = buildSummary(decode(), { radio: 'Quansheng UV-K5', firmware: '2.01.32', generatedAt: AT })

  it('carries the radio, the firmware and the channel count', () => {
    expect(summary.radio).toBe('Quansheng UV-K5')
    expect(summary.firmware).toBe('2.01.32')
    expect(summary.channelCount).toBe(4)
    expect(summary.receiveOnlyCount).toBe(1)
    expect(summary.generatedAt).toBe(AT)
  })

  it('names the columns it emits, in order', () => {
    expect(summary.columns).toEqual([...SUMMARY_COLUMNS])
    expect(summary.showNotes).toBe(false)
  })

  it('marks receive-only in words, not in colour', () => {
    const wx = summary.rows.find((r) => r.name === 'WX3')!
    expect(wx.receiveOnly).toBe(true)
    expect(wx.tx).toBe(RECEIVE_ONLY)
    expect(summaryHtml(summary)).toContain(RECEIVE_ONLY)
    expect(summaryMarkdown(summary)).toContain(RECEIVE_ONLY)
    // Every other channel still shows a frequency, so the marking is a fact
    // about the channel rather than the state of the whole file.
    expect(summary.rows.filter((r) => r.tx === RECEIVE_ONLY)).toHaveLength(1)
  })

  it('keeps the transmit frequency a repeater channel actually uses', () => {
    const rpt = summary.rows.find((r) => r.name === 'UHF RPT')!
    expect(rpt.rx).toBe('442.100000')
    expect(rpt.tx).toBe('447.100000')
  })

  it('adds a notes column only when a channel has a note', () => {
    const cp = decode()
    const first = cp.channels.get(1)!
    cp.channels.set(1, { ...first, comment: 'net Tuesdays 1900' } satisfies Channel)
    const withNotes = buildSummary(cp, { generatedAt: AT })
    expect(withNotes.showNotes).toBe(true)
    expect(withNotes.columns.at(-1)).toBe('Notes')
    expect(summaryMarkdown(withNotes)).toContain('net Tuesdays 1900')
  })

  it('falls back to the radio id when nothing better is offered', () => {
    const bare = buildSummary(decode(), { generatedAt: AT })
    expect(bare.radio).toBe('uvk5')
    expect(bare.title).toBe('uvk5 channel plan')
  })
})

describe('the HTML is self-contained', () => {
  const cp = decode()
  const first = cp.channels.get(1)!
  cp.channels.set(1, { ...first, name: '<script>alert(1)</script>' })
  const html = summaryHtml(buildSummary(cp, { radio: 'Quansheng UV-K5', generatedAt: AT }))

  it('fetches nothing', () => {
    // The site has no external asset hosts, and neither does anything it
    // produces: a summary is opened offline as often as not.
    expect(html).not.toMatch(/<script[\s>]/)
    expect(html).not.toMatch(/<link[\s>]/)
    expect(html).not.toMatch(/\ssrc=/)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toContain('@import')
    expect(html).toContain('<style>')
  })

  it('escapes channel text rather than trusting it', () => {
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('is one document, with a head and a table', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<title>Quansheng UV-K5 channel plan</title>')
    expect(html.match(/<tr>/g) ?? []).toHaveLength(5) // header + four channels
  })
})

describe('the Markdown table', () => {
  const summary = buildSummary(decode(), { radio: 'Quansheng UV-K5', generatedAt: AT })
  const lines = summaryMarkdown(summary).split('\n')

  it('is a table with a row per channel', () => {
    const table = lines.filter((l) => l.startsWith('|'))
    expect(table).toHaveLength(2 + summary.channelCount)
    expect(table[0]).toBe(`| ${SUMMARY_COLUMNS.join(' | ')} |`)
    expect(table[1]).toBe(`| ${SUMMARY_COLUMNS.map(() => '---').join(' | ')} |`)
  })

  it('escapes a pipe rather than losing the column it would create', () => {
    const cp = decode()
    const first = cp.channels.get(1)!
    cp.channels.set(1, { ...first, name: 'A|B' })
    const md = summaryMarkdown(buildSummary(cp, { generatedAt: AT }))
    expect(md).toContain('A\\|B')
  })
})
