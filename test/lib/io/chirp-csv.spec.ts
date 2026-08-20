// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { createUvk5Driver } from '#core/radios/uvk5/driver.js'
import {
  CSV_COLUMNS,
  channelToRow,
  defaultHeader,
  encodeDuplex,
  encodeToneFields,
  exportChirpCsv,
  formatTStep,
  txInhibitConflicts,
} from '#core/io/chirp-csv.js'
import { parseCsv, quoteField, writeRow } from '#core/io/csv-text.js'
import { ctcss, dtcs, NO_TONE } from '#core/model/tones.js'
import { hz } from '#core/model/units.js'
import type { Channel } from '#core/model/channel.js'
import { CHIRP_ATTRS, CHIRP_CHANNELS, buildEeprom, imageFrom } from '../radios/uvk5/fixture.js'

const driver = createUvk5Driver()

const FIXTURE = buildEeprom([
  { slot: 0, record: CHIRP_CHANNELS.SIMPLEX, name: 'CALLING', attr: CHIRP_ATTRS.SL1_BAND2 },
  { slot: 1, record: CHIRP_CHANNELS.REPEATER, name: 'W4ABC', attr: CHIRP_ATTRS.SL1_BAND2 },
  { slot: 2, record: CHIRP_CHANNELS.UHF_PLUS, name: 'UHF RPT', attr: CHIRP_ATTRS.SL1_BAND2 },
  { slot: 3, record: CHIRP_CHANNELS.TX_DISABLED, name: 'WX3', attr: CHIRP_ATTRS.NONE_BAND2 },
  { slot: 4, record: CHIRP_CHANNELS.AIR_AM, name: 'GUARD', attr: CHIRP_ATTRS.NONE_BAND2 },
  { slot: 5, record: CHIRP_CHANNELS.DTCS_R, name: 'DTCSR', attr: CHIRP_ATTRS.NONE_BAND2 },
  { slot: 6, record: CHIRP_CHANNELS.EXTRAS, name: 'EXTRAS', attr: CHIRP_ATTRS.SL2_COMP3_BAND5 },
])

/**
 * The expected output below was checked against CHIRP itself: this exact text
 * was loaded with `chirp.generic_csv.CSVRadio.load()`, parsed without error into
 * seven memories, and re-saved by CHIRP to a byte-identical file.
 *
 * `scripts/crosscheck-chirp-csv.sh` reproduces that check against a local CHIRP
 * checkout. It is not run in CI, because CI has no CHIRP - so this golden string
 * is how the result is kept honest between runs.
 */
const GOLDEN_CSV =
  'Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment,URCALL,RPT1CALL,RPT2CALL,DVCODE\r\n' +
  '1,CALLING,146.520000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,5.0W,,,,,\r\n' +
  '2,W4ABC,146.940000,-,0.600000,Cross,88.5,88.5,023,NN,023,Tone->DTCS,NFM,5.00,,3.0W,,,,,\r\n' +
  '3,UHF RPT,442.100000,+,5.000000,TSQL,88.5,100.0,023,NN,023,Tone->Tone,FM,12.50,,5.0W,,,,,\r\n' +
  '4,WX3,162.550000,off,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,NFM,5.00,,1.5W,,,,,\r\n' +
  '5,GUARD,121.500000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,AM,12.50,,1.5W,,,,,\r\n' +
  '6,DTCSR,145.000000,,0.000000,Cross,88.5,88.5,031,RN,023,DTCS->,FM,5.00,,5.0W,,,,,\r\n' +
  '7,EXTRAS,143.000000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,25.00,,5.0W,,,,,\r\n'

describe('exportChirpCsv', () => {
  const cp = driver.decode(imageFrom(FIXTURE))

  it('reproduces CHIRP’s output byte for byte', () => {
    expect(exportChirpCsv(cp)).toBe(GOLDEN_CSV)
  })

  it('uses CRLF, as Python’s csv writer does', () => {
    const text = exportChirpCsv(cp)
    expect(text.includes('\r\n')).toBe(true)
    expect(text.split('\r\n').length - 1).toBe(8) // header + 7 channels
    // No bare LF anywhere: a stray one would break the byte-identity claim.
    expect(/[^\r]\n/.test(text)).toBe(false)
  })

  it('emits all 21 columns in CHIRP’s order', () => {
    expect([...CSV_COLUMNS]).toEqual([
      'Location', 'Name', 'Frequency', 'Duplex', 'Offset', 'Tone',
      'rToneFreq', 'cToneFreq', 'DtcsCode', 'DtcsPolarity', 'RxDtcsCode',
      'CrossMode', 'Mode', 'TStep', 'Skip', 'Power', 'Comment',
      'URCALL', 'RPT1CALL', 'RPT2CALL', 'DVCODE',
    ])
    for (const row of parseCsv(exportChirpCsv(cp))) expect(row).toHaveLength(21)
  })

  it('writes power in watts, because CHIRP parses that column with parse_power', () => {
    // "High" would raise ValueError in chirp_common.parse_power, so exporting
    // the radio's own level name would produce a file CHIRP cannot load.
    const rows = parseCsv(exportChirpCsv(cp))
    expect(rows.slice(1).map((r) => r[15])).toEqual(['5.0W', '3.0W', '5.0W', '1.5W', '1.5W', '5.0W', '5.0W'])
  })

  it('marks a receive-only channel with Duplex=off', () => {
    const wx = parseCsv(exportChirpCsv(cp)).find((r) => r[1] === 'WX3')!
    expect(wx[3]).toBe('off')
    expect(wx[4]).toBe('0.000000')
  })

  it('can restrict the export to selected slots', () => {
    const rows = parseCsv(exportChirpCsv(cp, { slots: [1, 4] }))
    expect(rows.slice(1).map((r) => r[0])).toEqual(['1', '4'])
  })

  it('writes header comments CHIRP will preserve on load', () => {
    const text = exportChirpCsv(cp, { header: defaultHeader(cp) })
    expect(text.startsWith('# Exported by boofwang from uvk5\r\n')).toBe(true)
    expect(text).toContain('# Firmware: k5_2.01.26')
    expect(text).toContain('# 1 channel(s) are receive-only')
  })
})

describe('encodeToneFields — CHIRP’s split_tone_decode, run forwards', () => {
  const base = { rxInverted: false }

  it('writes CHIRP’s defaults when there is no tone at all', () => {
    expect(encodeToneFields(NO_TONE)).toEqual({
      tmode: '',
      rtone: 885,
      ctone: 885,
      dtcs: 23,
      rxDtcs: 23,
      dtcsPolarity: 'NN',
      crossMode: 'Tone->Tone',
    })
  })

  it('uses Tone for transmit-only CTCSS', () => {
    const f = encodeToneFields({ ...base, tx: ctcss(1230), rx: null })
    expect(f).toMatchObject({ tmode: 'Tone', rtone: 1230, ctone: 885 })
  })

  it('collapses matching CTCSS on both sides to TSQL, not Cross', () => {
    // Getting the preference order wrong here still round-trips semantically
    // but is not byte-identical to CHIRP's output.
    const f = encodeToneFields({ ...base, tx: ctcss(1000), rx: ctcss(1000) })
    expect(f).toMatchObject({ tmode: 'TSQL', ctone: 1000 })
  })

  it('collapses matching DTCS on both sides to DTCS', () => {
    const f = encodeToneFields({ ...base, tx: dtcs(23), rx: dtcs(23) })
    expect(f).toMatchObject({ tmode: 'DTCS', dtcs: 23, dtcsPolarity: 'NN' })
  })

  it('falls back to Cross when the two sides differ', () => {
    const f = encodeToneFields({ ...base, tx: ctcss(885), rx: dtcs(23) })
    expect(f).toMatchObject({ tmode: 'Cross', crossMode: 'Tone->DTCS', rtone: 885, rxDtcs: 23 })
  })

  it('spells a one-sided DTCS as DTCS->', () => {
    const f = encodeToneFields({ ...base, tx: dtcs(31, 'R'), rx: null })
    expect(f).toMatchObject({ tmode: 'Cross', crossMode: 'DTCS->', dtcs: 31, dtcsPolarity: 'RN' })
  })

  it('spells a receive-only tone as ->Tone', () => {
    const f = encodeToneFields({ ...base, tx: null, rx: ctcss(1318) })
    expect(f).toMatchObject({ tmode: 'Cross', crossMode: '->Tone', ctone: 1318 })
  })

  it('carries DTCS polarity for each side independently', () => {
    const f = encodeToneFields({ ...base, tx: dtcs(23, 'R'), rx: dtcs(31, 'N') })
    expect(f.dtcsPolarity).toBe('RN')
    expect(f).toMatchObject({ crossMode: 'DTCS->DTCS', dtcs: 23, rxDtcs: 31 })
  })

  it('distinguishes matching DTCS codes with differing polarity', () => {
    // Same code, opposite polarity, is not the plain DTCS case.
    const f = encodeToneFields({ ...base, tx: dtcs(23, 'N'), rx: dtcs(23, 'R') })
    expect(f.tmode).toBe('DTCS')
    expect(f.dtcsPolarity).toBe('NR')
  })

  it('uses the -R modes for inverted receive squelch', () => {
    expect(encodeToneFields({ rxInverted: true, tx: ctcss(885), rx: ctcss(885) }).tmode).toBe('TSQL-R')
    expect(encodeToneFields({ rxInverted: true, tx: dtcs(23), rx: dtcs(23) }).tmode).toBe('DTCS-R')
  })
})

describe('encodeDuplex', () => {
  const ch = (over: Partial<Channel>): Channel =>
    ({
      index: 1, name: 'X', rxFreq: hz(146_520_000), tx: { kind: 'simplex' }, txAllowed: true,
      tone: NO_TONE, modulation: 'FM', bandwidthHz: 25_000, power: { mW: 5000 as never },
      tuningStep: hz(5000), skip: 'none', comment: '', extras: {}, ...over,
    }) as Channel

  it('maps a plus shift', () => {
    expect(encodeDuplex(ch({ tx: { kind: 'offset', direction: 'plus', offset: hz(600_000) } }))).toEqual({
      duplex: '+', offset: 600_000,
    })
  })

  it('puts the absolute transmit frequency in Offset for split', () => {
    expect(encodeDuplex(ch({ tx: { kind: 'split', txFreq: hz(147_000_000) } }))).toEqual({
      duplex: 'split', offset: 147_000_000,
    })
  })

  it('lets receive-only win over any shift the channel also carries', () => {
    // This precedence is the whole reason txAllowed is a separate flag rather
    // than a fourth TxSpec variant: an exporter cannot express the shift and
    // forget the inhibit.
    const c = ch({ txAllowed: false, tx: { kind: 'offset', direction: 'minus', offset: hz(600_000) } })
    expect(encodeDuplex(c)).toEqual({ duplex: 'off', offset: 0 })
  })
})

describe('channelToRow', () => {
  const cp = driver.decode(imageFrom(FIXTURE))

  it('produces exactly 21 fields per channel', () => {
    for (const ch of cp.channels.values()) {
      expect(channelToRow(ch)).toHaveLength(21)
    }
  })

  it('leaves the four D-STAR columns empty', () => {
    const row = channelToRow(cp.channels.get(1)!)
    expect(row.slice(17)).toEqual(['', '', '', ''])
  })

  it('writes the memory slot as CHIRP’s 1-based Location', () => {
    expect(channelToRow(cp.channels.get(3)!)[0]).toBe('3')
  })
})

describe('formatTStep', () => {
  it('writes kHz with two decimals, as CHIRP does', () => {
    expect(formatTStep(hz(5_000))).toBe('5.00')
    expect(formatTStep(hz(6_250))).toBe('6.25')
    expect(formatTStep(hz(12_500))).toBe('12.50')
    expect(formatTStep(hz(2_500))).toBe('2.50')
  })
})

describe('txInhibitConflicts', () => {
  const cp = driver.decode(imageFrom(FIXTURE))

  it('finds nothing when the target radio can inhibit transmit', () => {
    expect(txInhibitConflicts(cp, true)).toEqual([])
  })

  it('names every receive-only channel a radio could not honour', () => {
    const conflicts = txInhibitConflicts(cp, false)
    expect(conflicts.map((c) => c.name)).toEqual(['WX3'])
  })
})

describe('CSV text handling', () => {
  it('quotes only what needs quoting, as QUOTE_MINIMAL does', () => {
    expect(quoteField('plain')).toBe('plain')
    expect(quoteField('has,comma')).toBe('"has,comma"')
    expect(quoteField('has"quote')).toBe('"has""quote"')
    expect(quoteField('has\nnewline')).toBe('"has\nnewline"')
    expect(quoteField('')).toBe('')
  })

  it('round-trips fields that need quoting', () => {
    const fields = ['a', 'b,c', 'd"e', 'f\ng', '']
    expect(parseCsv(writeRow(fields))[0]).toEqual(fields)
  })

  it('strips a UTF-8 BOM, which CHIRP tolerates via utf-8-sig', () => {
    expect(parseCsv('﻿Location,Name\r\n1,X\r\n')[0]).toEqual(['Location', 'Name'])
  })

  it('accepts LF and CR line endings on input, not just CRLF', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a,b\r1,2\r')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('does not invent a trailing empty row', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toHaveLength(2)
  })

  it('keeps a genuinely empty trailing field', () => {
    expect(parseCsv('a,b,\r\n')[0]).toEqual(['a', 'b', ''])
  })
})
