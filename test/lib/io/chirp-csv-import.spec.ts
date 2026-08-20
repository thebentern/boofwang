// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { importChirpCsv } from '#core/io/chirp-csv-import.js'
import { exportChirpCsv } from '#core/io/chirp-csv.js'
import { emptyCodeplug, type Channel, type Codeplug } from '#core/model/index.js'
import { NO_TONE, ctcss, dtcs } from '#core/model/tones.js'
import { hz, mW } from '#core/model/units.js'

function channel(over: Partial<Channel> & { index: number }): Channel {
  return {
    name: 'CH',
    rxFreq: hz(145_500_000),
    tx: { kind: 'simplex' },
    txAllowed: true,
    tone: NO_TONE,
    modulation: 'FM',
    bandwidthHz: 12_500,
    power: { mW: mW(5000), label: 'High' },
    tuningStep: hz(5000),
    skip: 'none',
    comment: '',
    extras: {},
    ...over,
  }
}

function plug(channels: Channel[]): Codeplug {
  const cp = emptyCodeplug('uvk5', '2026-08-20T00:00:00.000Z')
  for (const c of channels) cp.channels.set(c.index, c)
  return cp
}

/** Export then import: whatever survives that is what interop actually means. */
function roundTrip(channels: Channel[]) {
  return importChirpCsv(exportChirpCsv(plug(channels), { header: [] }))
}

describe('importing a CHIRP CSV', () => {
  it('round-trips the fields the format carries', () => {
    const source = channel({
      index: 7,
      name: 'REPEATER',
      rxFreq: hz(145_230_000),
      tx: { kind: 'offset', direction: 'minus', offset: hz(600_000) },
      tone: { rx: ctcss(885), tx: ctcss(885), rxInverted: false },
      modulation: 'FM',
      bandwidthHz: 25_000,
      power: { mW: mW(4000), label: 'High' },
      skip: 'skip',
      comment: 'club machine',
    })
    const { channels, issues } = roundTrip([source])
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    const got = channels[0]!

    expect(got.index).toBe(7)
    expect(got.name).toBe('REPEATER')
    expect(got.rxFreq).toBe(145_230_000)
    expect(got.tx).toEqual({ kind: 'offset', direction: 'minus', offset: 600_000 })
    expect(got.tone.rx).toEqual(ctcss(885))
    expect(got.tone.tx).toEqual(ctcss(885))
    expect(got.bandwidthHz).toBe(25_000)
    expect(got.power.mW).toBe(4000)
    expect(got.skip).toBe('skip')
    expect(got.comment).toBe('club machine')
  })

  it('keeps a receive-only channel receive-only', () => {
    // The single most important thing a round trip must not lose. CHIRP spells
    // it Duplex=off, and a channel that comes back transmit-capable is the
    // failure that puts a weather frequency into a radio someone can key.
    const { channels } = roundTrip([channel({ index: 1, txAllowed: false })])
    expect(channels[0]!.txAllowed).toBe(false)
    expect(channels[0]!.txInhibitReason).toBeTruthy()
  })

  it('round-trips DTCS with its polarity', () => {
    const { channels } = roundTrip([
      channel({ index: 2, tone: { rx: dtcs(754, 'R'), tx: dtcs(754, 'R'), rxInverted: false } }),
    ])
    expect(channels[0]!.tone.rx).toEqual(dtcs(754, 'R'))
  })

  it('reads a transmit-only tone as transmit-only', () => {
    const { channels } = roundTrip([
      channel({ index: 3, tone: { rx: null, tx: ctcss(1273), rxInverted: false } }),
    ])
    expect(channels[0]!.tone.tx).toEqual(ctcss(1273))
    expect(channels[0]!.tone.rx).toBeNull()
  })

  it('leaves a tone-less channel without a tone', () => {
    // CHIRP writes 88.5 and 023 into every row regardless of mode. Reading a
    // value without checking the mode invents tones on every channel.
    const { channels } = roundTrip([channel({ index: 4 })])
    expect(channels[0]!.tone).toEqual(NO_TONE)
  })

  it('finds the header wherever it is, and skips comments', () => {
    const csv = [
      '# Exported by something',
      '',
      'Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment,URCALL,RPT1CALL,RPT2CALL,DVCODE',
      '1,TEST,146.520000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,5.0W,,,,,',
    ].join('\r\n')
    const { channels, issues } = importChirpCsv(csv)
    expect(channels).toHaveLength(1)
    expect(channels[0]!.rxFreq).toBe(146_520_000)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('reads columns by name, not by position', () => {
    // Exporters reorder. RepeaterBook adds its own columns. Reading positionally
    // would put an offset into the tone column and call it a tone.
    const csv = [
      'Name,Frequency,Location,Mode,Power,Tone,cToneFreq,Duplex,Offset',
      'SHUFFLED,147.000000,12,NFM,1.0W,TSQL,100.0,+,0.600000',
    ].join('\r\n')
    const { channels } = importChirpCsv(csv)
    const c = channels[0]!
    expect(c.index).toBe(12)
    expect(c.name).toBe('SHUFFLED')
    expect(c.rxFreq).toBe(147_000_000)
    expect(c.bandwidthHz).toBe(12_500)
    expect(c.power.mW).toBe(1000)
    expect(c.tone.rx).toEqual(ctcss(1000))
    expect(c.tx).toEqual({ kind: 'offset', direction: 'plus', offset: 600_000 })
  })

  it('reports a bad row against its line and keeps the rest', () => {
    const csv = [
      'Location,Name,Frequency',
      '1,GOOD,146.520000',
      '2,BAD,not-a-frequency',
      '3,ALSOGOOD,147.000000',
    ].join('\r\n')
    const { channels, issues } = importChirpCsv(csv)
    expect(channels.map((c) => c.name)).toEqual(['GOOD', 'ALSOGOOD'])
    expect(issues).toHaveLength(1)
    expect(issues[0]!.line).toBe(3)
  })

  it('refuses a file that is not a CHIRP CSV, without throwing', () => {
    const r = importChirpCsv('some,other,file\n1,2,3')
    expect(r.channels).toEqual([])
    expect(r.issues[0]!.severity).toBe('error')
  })

  it('names columns it does not understand rather than dropping them silently', () => {
    const csv = ['Location,Name,Frequency,RepeaterBookId', '1,X,146.520000,99'].join('\r\n')
    expect(importChirpCsv(csv).unknownColumns).toEqual(['RepeaterBookId'])
  })

  it('snaps a near-miss CTCSS tone and says it did', () => {
    const csv = ['Location,Name,Frequency,Tone,cToneFreq', '1,X,146.520000,TSQL,88.4'].join('\r\n')
    const { channels, issues } = importChirpCsv(csv)
    expect(channels[0]!.tone.rx).toEqual(ctcss(885))
    expect(issues.some((i) => i.severity === 'warning')).toBe(true)
  })

  it('drops an invalid DCS code rather than guessing', () => {
    // A wrong DCS code keeps squelch shut, which is worse than no tone at all.
    const csv = ['Location,Name,Frequency,Tone,DtcsCode', '1,X,146.520000,DTCS,999'].join('\r\n')
    const { channels, issues } = importChirpCsv(csv)
    expect(channels[0]!.tone.rx).toBeNull()
    expect(issues.some((i) => i.severity === 'error')).toBe(true)
  })
})
