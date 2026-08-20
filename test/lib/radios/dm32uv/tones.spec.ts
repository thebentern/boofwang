// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { CTCSS_DECIHZ, DTCS_CODES } from '#core/model/tones.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { CHANNEL_BLOCK_FIRST, CHANNEL_SIZE, decodeToneWord } from '#core/radios/dm32uv/layout.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import { exportChirpCsv } from '#core/io/chirp-csv.js'

const BLOB = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.blocks.bin', import.meta.url))),
)
const INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.index.json', import.meta.url)), 'utf8'),
) as { firmware: string; model: string; blocks: { id: number; offset: number }[] }

/**
 * Worked values transcribed from `reference/dm32/05-DATA-STRUCTURES.md`.
 *
 * Bytes are documented as `[low, high]` and read as a little-endian u16, so a
 * documented pair `70 06` is the word 0x0670.
 */
const word = (low: number, high: number) => low | (high << 8)

describe('decodeToneWord', () => {
  it('reads the CTCSS values the specification works through', () => {
    expect(decodeToneWord(word(0x70, 0x06))).toEqual({ kind: 'ctcss', deciHz: 670 })
    expect(decodeToneWord(word(0x00, 0x10))).toEqual({ kind: 'ctcss', deciHz: 1000 })
    expect(decodeToneWord(word(0x73, 0x12))).toEqual({ kind: 'ctcss', deciHz: 1273 })
    expect(decodeToneWord(word(0x35, 0x20))).toEqual({ kind: 'ctcss', deciHz: 2035 })
  })

  it('reads the one hardware-attested value', () => {
    // The single non-FF tone in either OEM capture: channel "RATS UHF", 74.4 Hz.
    expect(decodeToneWord(word(0x44, 0x07))).toEqual({ kind: 'ctcss', deciHz: 744 })
  })

  it('reads DCS codes and keeps their polarity', () => {
    expect(decodeToneWord(word(0x23, 0x80))).toEqual({ kind: 'dtcs', code: 23, polarity: 'N' })
    expect(decodeToneWord(word(0x23, 0xc0))).toEqual({ kind: 'dtcs', code: 23, polarity: 'R' })
    expect(decodeToneWord(word(0x54, 0x87))).toEqual({ kind: 'dtcs', code: 754, polarity: 'N' })
    expect(decodeToneWord(word(0x54, 0xc7))).toEqual({ kind: 'dtcs', code: 754, polarity: 'R' })
  })

  it('treats both documented empty patterns as no tone', () => {
    // The radio writes FF FF; some other tools write 00 00.
    expect(decodeToneWord(0xffff)).toBeNull()
    expect(decodeToneWord(0x0000)).toBeNull()
  })

  it('does not read the word as tenths of a hertz', () => {
    // The regression this file exists for. Read as deciHz, 127.3 Hz becomes
    // 472.3 Hz - outside CHIRP's 50..300 range, so the channel is dropped on
    // import - and D023 becomes 3.5 Hz.
    const decoded = decodeToneWord(word(0x73, 0x12))
    expect(decoded).not.toEqual({ kind: 'ctcss', deciHz: 4723 })
    expect(decoded).toEqual({ kind: 'ctcss', deciHz: 1273 })
  })

  it('produces tones CHIRP will accept, across every standard CTCSS value', () => {
    // Every tone the radio can hold must survive export. CHIRP's VALIDTONE
    // check is 50 < v < 300, and a value it rejects makes the channel vanish.
    for (const deciHz of CTCSS_DECIHZ) {
      const hundreds = Math.floor(deciHz / 1000)
      const tens = Math.floor(deciHz / 100) % 10
      const ones = Math.floor(deciHz / 10) % 10
      const tenths = deciHz % 10
      const encoded = word((ones << 4) | tenths, (hundreds << 4) | tens)
      const back = decodeToneWord(encoded)
      expect(back, `deciHz ${deciHz}`).toEqual({ kind: 'ctcss', deciHz })
      const hz = deciHz / 10
      expect(hz > 50 && hz < 300, `${hz} Hz is outside CHIRP's valid range`).toBe(true)
    }
  })

  it('round-trips every DCS code in both polarities', () => {
    for (const code of DTCS_CODES) {
      for (const [polarity, flag] of [['N', 0x80] as const, ['R', 0xc0] as const]) {
        const low = (Math.floor(code / 10) % 10 << 4) | code % 10
        const high = flag | Math.floor(code / 100)
        expect(decodeToneWord(word(low, high)), `D${code}${polarity}`).toEqual({
          kind: 'dtcs',
          code,
          polarity,
        })
      }
    }
  })
})

describe('a tone-bearing channel, all the way to CHIRP CSV', () => {
  // The decode bug was invisible because the hardware fixture has FF FF in
  // every tone field, so no test ever saw a channel with a tone. These patch
  // real tone words into the fixture and follow them out through the exporter.
  const CHANNEL_HEADER = 0x10

  function imageWithTones(pairs: [number, number][]): RadioImage {
    const regions = INDEX.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: BLOB.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    }))
    const ch = regions.find((r) => r.start === logicalAddress(CHANNEL_BLOCK_FIRST))!
    const data = ch.data.slice()
    pairs.forEach(([lo, hi], i) => {
      const off = CHANNEL_HEADER + i * CHANNEL_SIZE
      data[off + 0x21] = lo
      data[off + 0x22] = hi
      data[off + 0x23] = lo
      data[off + 0x24] = hi
    })
    ch.data = data
    return { radioId: 'dm32uv', variant: INDEX.firmware, layout: INDEX.model,
      createdAt: '2026-08-20T00:00:00.000Z', regions, meta: {}, sha256: '' }
  }

  const driver = createDm32uvDriver()

  it('carries CTCSS out as a value CHIRP accepts', () => {
    const doc = driver.decode(imageWithTones([[0x73, 0x12]]))
    expect(doc.channels.get(1)!.tone.rx).toEqual({ kind: 'ctcss', deciHz: 1273 })
    const row = exportChirpCsv(doc, { header: [] }).split('\r\n')[1]!.split(',')
    // Columns: Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,...
    expect(row[5]).toBe('TSQL')
    expect(row[7]).toBe('127.3')
    // CHIRP's VALIDTONE is 50 < v < 300; 472.3 was the old value and is rejected.
    expect(Number(row[7])).toBeGreaterThan(50)
    expect(Number(row[7])).toBeLessThan(300)
  })

  it('carries DCS out with its code and polarity intact', () => {
    const doc = driver.decode(imageWithTones([[0x54, 0xc7]]))
    expect(doc.channels.get(1)!.tone.rx).toEqual({ kind: 'dtcs', code: 754, polarity: 'R' })
    const row = exportChirpCsv(doc, { header: [] }).split('\r\n')[1]!.split(',')
    expect(row[5]).toBe('DTCS')
    expect(row[8]).toBe('754')
    expect(row[9]).toBe('RR')
  })

  it('emits a transmit tone, so a repeater channel will actually key up', () => {
    // tx was hardcoded null, which made every analog channel export as
    // Cross/->Tone with no transmit tone at all.
    const doc = driver.decode(imageWithTones([[0x44, 0x07]]))
    const ch = doc.channels.get(1)!
    expect(ch.tone.tx).toEqual({ kind: 'ctcss', deciHz: 744 })
    const row = exportChirpCsv(doc, { header: [] }).split('\r\n')[1]!.split(',')
    expect(row[5]).toBe('TSQL')
    expect(row[5]).not.toBe('Cross')
  })

  it('leaves a tone-less channel alone', () => {
    const doc = driver.decode(imageWithTones([]))
    expect(doc.channels.get(1)!.tone).toEqual({ rx: null, tx: null, rxInverted: false })
    expect(exportChirpCsv(doc, { header: [] }).split('\r\n')[1]!.split(',')[5]).toBe('')
  })
})
