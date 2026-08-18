// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  BWP_MAGIC,
  BwpFormatError,
  decodeBwp,
  decodeRawBin,
  encodeBwp,
  encodeRawBin,
  looksLikeBwp,
  peekBwpHeader,
} from '#core/io/bwp.js'
import { imagesEqual } from '#core/radio/image.js'
import { REGIONS } from '#core/radios/uvk5/layout.js'
import { CHIRP_CHANNELS, buildEeprom, imageFrom } from '../radios/uvk5/fixture.js'

const eeprom = buildEeprom([{ slot: 0, record: CHIRP_CHANNELS.SIMPLEX, name: 'CALLING' }])
eeprom.set(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]), 0x1d00)
const image = imageFrom(eeprom)

describe('.bwp round trip', () => {
  it('restores an image byte for byte', async () => {
    const back = await decodeBwp(await encodeBwp(image))
    expect(imagesEqual(back, image)).toBe(true)
  })

  it('carries the radio identity a raw dump cannot', async () => {
    const back = await decodeBwp(await encodeBwp(image))
    expect(back.radioId).toBe('uvk5')
    expect(back.variant).toBe('k5_2.01.26')
    expect(back.layout).toBe('stock')
    expect(back.meta).toMatchObject({ firmware: 'k5_2.01.26' })
  })

  it('preserves which regions are read-only', async () => {
    // Losing this would let the calibration region into an upload.
    const back = await decodeBwp(await encodeBwp(image))
    expect(back.regions.map((r) => [r.label, r.readOnly])).toEqual([
      ['programmable', false],
      ['calibration', true],
    ])
  })

  it('preserves calibration bytes', async () => {
    const back = await decodeBwp(await encodeBwp(image))
    expect([...back.regions[1]!.data.subarray(0, 4)]).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('starts with the BWPK signature', async () => {
    const bytes = await encodeBwp(image)
    expect([...bytes.subarray(0, 4)]).toEqual([...BWP_MAGIC])
    expect(looksLikeBwp(bytes)).toBe(true)
  })

  it('exposes its header without decoding the payload', async () => {
    const header = peekBwpHeader(await encodeBwp(image))
    expect(header).toMatchObject({ radioId: 'uvk5', variant: 'k5_2.01.26', producer: 'boofwang' })
    expect(header!.sha256).toHaveLength(64)
  })
})

describe('.bwp refuses damaged files', () => {
  it('rejects a file without the signature', async () => {
    await expect(decodeBwp(new Uint8Array(64))).rejects.toBeInstanceOf(BwpFormatError)
    expect(looksLikeBwp(new Uint8Array(64))).toBe(false)
  })

  it('rejects a payload that no longer matches its checksum', async () => {
    // This is the case that matters: a file silently corrupted on disk or in
    // transit must never reach a radio.
    const bytes = await encodeBwp(image)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    await expect(decodeBwp(bytes)).rejects.toThrow(/failed its checksum/)
  })

  it('rejects a truncated payload', async () => {
    const bytes = await encodeBwp(image)
    await expect(decodeBwp(bytes.subarray(0, bytes.length - 32))).rejects.toThrow(/truncated or padded/)
  })

  it('rejects a truncated header', async () => {
    const bytes = await encodeBwp(image)
    await expect(decodeBwp(bytes.subarray(0, 10))).rejects.toThrow(/truncated/)
  })

  it('rejects a corrupt header rather than guessing', async () => {
    const bytes = await encodeBwp(image)
    bytes[9] = 0x00
    await expect(decodeBwp(bytes)).rejects.toThrow(/not valid JSON/)
  })

  it('refuses a file from a newer boofwang, explaining why', async () => {
    const bytes = await encodeBwp(image)
    bytes[4] = 99
    await expect(decodeBwp(bytes)).rejects.toThrow(/newer version of boofwang/)
  })
})

describe('raw .bin', () => {
  it('is the concatenation of every region', () => {
    const raw = encodeRawBin(image)
    expect(raw.length).toBe(0x2000)
    expect([...raw.subarray(0x1d00, 0x1d04)]).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('round-trips when told which radio it is', async () => {
    const raw = encodeRawBin(image)
    const back = await decodeRawBin(raw, {
      radioId: 'uvk5',
      variant: 'k5_2.01.26',
      layout: 'stock',
      regions: REGIONS.map((r) => ({ start: r.start, length: r.length, label: r.label, readOnly: r.readOnly })),
    })
    expect(imagesEqual(back, image)).toBe(true)
  })

  it('rejects a file of the wrong size instead of importing garbage', async () => {
    // The most likely mistake is a dump from a different radio; the size is the
    // only signal a raw binary offers, so it has to be checked.
    await expect(
      decodeRawBin(new Uint8Array(0x8240), {
        radioId: 'uvk5',
        variant: '',
        layout: 'stock',
        regions: REGIONS.map((r) => ({ start: r.start, length: r.length, label: r.label })),
      }),
    ).rejects.toThrow(/probably from a different radio/)
  })
})
