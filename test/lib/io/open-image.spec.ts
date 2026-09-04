// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHIRP_MAGIC, encodeChirpImg, looksLikeChirpImg, splitChirpImg } from '#core/io/chirp-img.js'
import { encodeRawBin } from '#core/io/bwp.js'
import { dm32BinToImage, looksLikeDm32Bin, openImageFile, RAW_LAYOUTS } from '#core/io/open-image.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import type { RadioImage } from '#core/radio/image.js'

const UVK5 = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../fixtures/images/uvk5-2.01.32.bin', import.meta.url))),
)
const DM32 = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../fixtures/images/dm32uv-DM32.01.01.040.blocks.bin', import.meta.url))),
)
const DM32_INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/images/dm32uv-DM32.01.01.040.index.json', import.meta.url)), 'utf8'),
) as { blocks: { id: number; offset: number }[] }

function uvk5Image(): RadioImage {
  return {
    radioId: 'uvk5',
    variant: '2.01.32',
    layout: 'stock',
    createdAt: '2026-08-20T00:00:00.000Z',
    regions: [
      { start: 0x0000, data: UVK5.slice(0, 0x1d00), label: 'programmable' },
      { start: 0x1d00, data: UVK5.slice(0x1d00), label: 'calibration', readOnly: true },
    ],
    meta: {},
    sha256: '',
  }
}

describe('every raw layout is distinguishable by size', () => {
  it('has no two layouts of the same length', () => {
    // The size guess is only safe while the totals are unique. If a radio is
    // added whose image is the same length as another's, this fails rather
    // than the app quietly opening one as the other.
    const totals = RAW_LAYOUTS.map((l) => l.regions.reduce((n, r) => n + r.length, 0))
    expect(new Set(totals).size).toBe(totals.length)
  })

  it('covers every radio that can be read, less the deliberate absences', () => {
    // The DM-32UV describes itself page by page and needs no size guess. The
    // UV-5G and the UV-5R are missing because they CANNOT be here: their
    // images are the same 6,472 bytes as the UV-82's, and a second entry of
    // that length would turn the size guess into a coin toss. A bare .bin of
    // either opens as a UV-82; the identity survives in .bwp and CHIRP .img
    // instead.
    const ids = new Set(RAW_LAYOUTS.map((l) => l.radioId))
    expect([...ids].sort()).toEqual(['uv5rmini', 'uv82', 'uvk5'])
  })
})

describe('a UV-5G, which shares its length with the UV-82', () => {
  const UV5G = new Uint8Array(
    readFileSync(fileURLToPath(new URL('../../fixtures/images/uv5g-HN5RV011.bin', import.meta.url))),
  )
  const uv5gImage = (): RadioImage => ({
    radioId: 'uv5g',
    variant: 'HN5RV011',
    layout: 'uv5g',
    createdAt: '2026-08-30T00:00:00.000Z',
    regions: [{ start: 0, data: UV5G.slice(), label: 'image' }],
    meta: {},
    sha256: '',
  })

  it('keeps its identity through a CHIRP .img, which carries the driver class', async () => {
    const img = await encodeChirpImg(uv5gImage())
    const opened = await openImageFile(img)
    expect(opened.image.radioId).toBe('uv5g')
    expect(opened.image.layout).toBe('uv5g')
    expect(opened.image.regions[0]!.data.length).toBe(UV5G.length)
  })

  it('opens as a UV-82 from a bare .bin, which carries nothing', async () => {
    const opened = await openImageFile(UV5G.slice())
    expect(opened.note).toEqual({ kind: 'raw', guessedFrom: 'size' })
    expect(opened.image.radioId).toBe('uv82')
  })
})

describe('a UV-5R, which shares its length with the UV-82 and the UV-5G', () => {
  const FAMILY = new Uint8Array(
    readFileSync(fileURLToPath(new URL('../../fixtures/images/uv5g-HN5RV011.bin', import.meta.url))),
  )
  /*
   * Not a UV-5R capture - there is none. These are the UV-5G's bytes with a
   * UV-5R's identity stamped on them, which is all this check needs: what it
   * is about is whether the metadata survives the trip and resolves back to
   * the radio it names, not what the memory holds.
   */
  const uv5rImage = (): RadioImage => ({
    radioId: 'uv5r',
    variant: 'BFB297',
    layout: 'uv5r',
    createdAt: '2026-09-04T00:00:00.000Z',
    regions: [{ start: 0, data: FAMILY.slice(), label: 'image' }],
    meta: {},
    sha256: '',
  })

  it('keeps its identity through a CHIRP .img, which carries the driver class', async () => {
    const img = await encodeChirpImg(uv5rImage())
    const opened = await openImageFile(img)
    expect(opened.image.radioId).toBe('uv5r')
    expect(opened.image.layout).toBe('uv5r')
  })

  it('is stamped with the class CHIRP actually registers, not the base class', async () => {
    // `BaofengUV5R` is the unregistered base class of the whole family;
    // `BaofengUV5RGeneric` is the plain radio CHIRP will open. A file carrying
    // the former would round-trip here and be refused by CHIRP.
    const { metadata } = splitChirpImg(await encodeChirpImg(uv5rImage()))
    expect(metadata.rclass).toBe('BaofengUV5RGeneric')
    expect(metadata.vendor).toBe('Baofeng')
    expect(metadata.model).toBe('UV-5R')
  })

  /** A CHIRP trailer written by hand, so metadata boofwang never emits can be read. */
  const withMetadata = (memory: Uint8Array, meta: Record<string, unknown>): Uint8Array => {
    const b64 = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64')
    return Uint8Array.from([...memory, ...CHIRP_MAGIC, ...new TextEncoder().encode(b64)])
  }

  it('still opens a file that names the base class, which boofwang never writes', async () => {
    // `BaofengUV5R` is not a registered CHIRP driver, but the name turns up in
    // files and in every subclass's `__bases__`. Accepted on the way in and
    // never emitted on the way out.
    const opened = await openImageFile(withMetadata(FAMILY.slice(), { rclass: 'BaofengUV5R' }))
    expect(opened.image.radioId).toBe('uv5r')
  })

  it('falls back to the model name when the class is one it has never heard of', async () => {
    const opened = await openImageFile(withMetadata(FAMILY.slice(), { rclass: 'SomeFutureUV5R', model: 'UV-5R' }))
    expect(opened.image.radioId).toBe('uv5r')
  })

  it('leaves an unrecognised classic-family file as a UV-82, rather than guessing', async () => {
    const opened = await openImageFile(withMetadata(FAMILY.slice(), { rclass: 'Nonsense', model: 'Nonsense' }))
    expect(opened.image.radioId).toBe('uv82')
  })

  it('opens as a UV-82 from a bare .bin, which carries nothing', async () => {
    const opened = await openImageFile(FAMILY.slice())
    expect(opened.image.radioId).toBe('uv82')
  })
})

describe('a CHIRP .img', () => {
  it('is memory, then the magic, then base64 metadata', async () => {
    const img = await encodeChirpImg(uvk5Image())
    expect(looksLikeChirpImg(img)).toBe(true)
    const { memory, metadata } = splitChirpImg(img)
    expect(memory.length).toBe(UVK5.length)
    expect([...memory]).toEqual([...UVK5])
    expect(metadata.vendor).toBe('Quansheng')
    expect(metadata.model).toBe('UV-K5')
  })

  it('writes an empty variant and puts the firmware where CHIRP looks for it', async () => {
    // CHIRP matches on vendor + model + the driver class's VARIANT, which is ''
    // for every radio here. Writing the firmware string into `variant` makes
    // CHIRP reject the file as an unsupported model.
    const { metadata } = splitChirpImg(await encodeChirpImg(uvk5Image()))
    expect(metadata.variant).toBe('')
    expect(metadata.uvk5_firmware).toBe('2.01.32')
  })

  it('round-trips back to the same regions and the same hash as the memory', async () => {
    const img = await encodeChirpImg(uvk5Image())
    const opened = await openImageFile(img)
    expect(opened.note.kind).toBe('chirp-img')
    expect(opened.image.radioId).toBe('uvk5')
    expect(opened.image.regions.map((r) => r.start)).toEqual([0x0000, 0x1d00])
    expect(opened.image.regions[1]!.readOnly).toBe(true)
    // The hash must cover the memory only: fold the metadata in and this file
    // would never match a fresh read of the same radio.
    const bare = await openImageFile(encodeRawBin(uvk5Image()))
    expect(opened.image.sha256).toBe(bare.image.sha256)
  })

  it('finds the trailer even when the memory contains the magic', async () => {
    // CHIRP takes the *first* occurrence, which those 13 bytes can hit by
    // chance inside real memory. Searching from the end does not.
    const image = uvk5Image()
    const poisoned = image.regions[0]!.data.slice()
    poisoned.set(CHIRP_MAGIC, 0x100)
    const img = await encodeChirpImg({
      ...image,
      regions: [{ ...image.regions[0]!, data: poisoned }, image.regions[1]!],
    })
    const { memory } = splitChirpImg(img)
    expect(memory.length).toBe(UVK5.length)
  })

  it('survives a damaged metadata blob rather than losing the codeplug', async () => {
    const img = await encodeChirpImg(uvk5Image())
    const broken = img.slice(0, img.length - 4)
    broken.set([0x21, 0x21, 0x21, 0x21], broken.length - 4)
    const { memory, metadata } = splitChirpImg(broken)
    expect(memory.length).toBe(UVK5.length)
    expect(metadata).toEqual({})
  })

  it('takes the UV-K5 layout from the firmware string, not from the size', async () => {
    // Stock and egzumer images are both 8,192 bytes, so size cannot separate
    // them - and reading one as the other puts the calibration boundary 256
    // bytes out. The hello string CHIRP records is what decides.
    const egzumer = await encodeChirpImg({ ...uvk5Image(), variant: 'EGZUMER v0.22', layout: 'egzumer' })
    const opened = await openImageFile(egzumer)
    expect(opened.image.layout).toBe('egzumer')
    expect(opened.image.regions.map((r) => r.start)).toEqual([0x0000, 0x1e00])
    expect(opened.image.regions[0]!.data.length).toBe(0x1e00)
    expect(opened.image.regions[1]!.readOnly).toBe(true)
  })

  it('falls back to the size guess for a firmware string it does not recognise', async () => {
    // Guessing a layout from an unknown firmware is the thing the variant table
    // exists to refuse, so an unrecognised string is treated as no information.
    const odd = await encodeChirpImg({ ...uvk5Image(), variant: 'SOMEONES-FORK-9' })
    const opened = await openImageFile(odd)
    expect(opened.image.layout).toBe('stock')
    expect(opened.image.regions.map((r) => r.start)).toEqual([0x0000, 0x1d00])
  })

  it('refuses to write one for a radio CHIRP has no driver for', async () => {
    // A .img exists so CHIRP can open it. Producing one for the DM-32UV would
    // be a promise nothing can keep.
    await expect(
      encodeChirpImg({ ...uvk5Image(), radioId: 'dm32uv' }),
    ).rejects.toThrow(/no driver/i)
  })
})

describe('a raw .bin', () => {
  it('opens a UV-K5 dump by size', async () => {
    const opened = await openImageFile(UVK5)
    expect(opened.image.radioId).toBe('uvk5')
    expect(opened.note).toEqual({ kind: 'raw', guessedFrom: 'size' })
  })

  it('round-trips a UV-K5 image through flatten and reopen', async () => {
    const image = uvk5Image()
    const reopened = (await openImageFile(encodeRawBin(image))).image
    expect(reopened.regions.map((r) => [r.start, r.data.length])).toEqual(
      image.regions.map((r) => [r.start, r.data.length]),
    )
    for (let i = 0; i < image.regions.length; i++) {
      expect([...reopened.regions[i]!.data]).toEqual([...image.regions[i]!.data])
    }
  })

  it('refuses a file that matches nothing, and says why', async () => {
    await expect(openImageFile(new Uint8Array(1234))).rejects.toThrow(/does not match any radio/)
  })
})

describe('a DM-32UV .bin, which describes itself', () => {
  const dm32Image = (): RadioImage => ({
    radioId: 'dm32uv',
    variant: '',
    layout: 'DP570UV',
    createdAt: '2026-08-20T00:00:00.000Z',
    regions: DM32_INDEX.blocks
      .map((b) => ({
        start: logicalAddress(b.id),
        data: DM32.slice(b.offset, b.offset + PAGE_SIZE),
        readOnly: b.id === 0x02,
        label: `block 0x${b.id.toString(16)}`,
      }))
      .sort((a, b) => a.start - b.start),
    meta: {},
    sha256: '',
  })

  it('is recognised from the block id in each page tail', () => {
    const flat = encodeRawBin(dm32Image())
    expect(looksLikeDm32Bin(flat)).toBe(true)
  })

  it('rebuilds every region, in the same order and with the same bytes', async () => {
    const image = dm32Image()
    const rebuilt = await dm32BinToImage(encodeRawBin(image))
    expect(rebuilt.regions.length).toBe(image.regions.length)
    expect(rebuilt.regions.map((r) => r.start)).toEqual(image.regions.map((r) => r.start))
    for (let i = 0; i < image.regions.length; i++) {
      expect([...rebuilt.regions[i]!.data], `region ${i}`).toEqual([...image.regions[i]!.data])
    }
  })

  it('keeps calibration marked read-only', async () => {
    const rebuilt = await dm32BinToImage(encodeRawBin(dm32Image()))
    const cal = rebuilt.regions.find((r) => r.start === logicalAddress(0x02))!
    expect(cal.readOnly).toBe(true)
  })

  it('is opened by the ordinary entry point', async () => {
    const opened = await openImageFile(encodeRawBin(dm32Image()))
    expect(opened.image.radioId).toBe('dm32uv')
    expect(opened.note).toEqual({ kind: 'raw', guessedFrom: 'page-ids' })
  })

  it('does not mistake an unrelated file of the right length for one', () => {
    // Duplicate ids are what give it away: real pages each carry a distinct one.
    // Four zeroed pages all claim block 0x00.
    expect(looksLikeDm32Bin(new Uint8Array(PAGE_SIZE * 4))).toBe(false)
    // 0xFF is the erased-page marker, never a real block id.
    expect(looksLikeDm32Bin(new Uint8Array(PAGE_SIZE * 4).fill(0xff))).toBe(false)
    // Not a whole number of pages.
    expect(looksLikeDm32Bin(new Uint8Array(PAGE_SIZE + 1))).toBe(false)
  })
})
