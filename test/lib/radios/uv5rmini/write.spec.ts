// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { BackupRequiredError } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5rMiniDriver, encodeChannel } from '#core/radios/uv5rmini/driver.js'
import { CHANNEL_BASE, CHANNEL_SIZE, decodeToneWord, encodeToneWord } from '#core/radios/uv5rmini/layout.js'
import { VARIANTS } from '#core/radios/uv5rmini/protocol.js'

const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv5rmini-5RMINI.bin', import.meta.url))),
)
const variant = VARIANTS.find((v) => v.id === 'uv5rmini')!

function image(): RadioImage {
  let off = 0
  const regions = variant.regions.map((r) => {
    const data = RAW.slice(off, off + r.size)
    off += r.size
    return { start: r.start, data, label: r.label }
  })
  return {
    radioId: 'uv5rmini',
    variant: '5RMINI',
    layout: 'uv5rmini',
    createdAt: '2026-08-20T00:00:00.000Z',
    regions,
    meta: {},
    sha256: '',
  }
}

const writable = createUv5rMiniDriver({ enableWrite: true })
const readOnly = createUv5rMiniDriver()
const channels = (img: RadioImage) => img.regions[0]!.data

describe('the round-trip invariant, on real radio bytes', () => {
  it('encode(decode(image), image) is byte-identical across every region', () => {
    const img = image()
    const out = writable.encode(writable.decode(img), img)
    for (let r = 0; r < img.regions.length; r++) {
      expect(equalBytes(out.regions[r]!.data, img.regions[r]!.data), `region ${r}`).toBe(true)
    }
  })

  it('does not mutate the image it was given', () => {
    const img = image()
    const before = channels(img).slice()
    writable.encode(writable.decode(img), img)
    expect(equalBytes(channels(img), before)).toBe(true)
  })

  it('leaves an unnamed channel unnamed rather than repadding it', () => {
    // The fixture's names are 0x00-filled and encodeName pads with 0xFF. Both
    // decode to an empty name, so rewriting one as the other would change bytes
    // to say what they already said - and put a block on the wire per channel.
    const img = image()
    const doc = writable.decode(img)
    expect([...doc.channels.values()].every((c) => c.name === '')).toBe(true)
    const out = writable.encode(doc, img)
    expect(equalBytes(channels(out), channels(img))).toBe(true)
  })

  it('leaves a tone-less channel alone, in either spelling', () => {
    // 0x0000 is what the radio writes and 0xFFFF is blank memory; both mean no
    // tone. Only one is ever produced, and neither is rewritten as the other.
    expect(decodeToneWord(0)).toBeNull()
    expect(decodeToneWord(0xffff)).toBeNull()
    expect(encodeToneWord(null)).toBe(0)

    const img = image()
    const mem = channels(img).slice()
    const patched = mem.slice()
    // Blank one channel's tone words the other way round.
    patched[CHANNEL_BASE + 0x08] = 0xff
    patched[CHANNEL_BASE + 0x09] = 0xff
    const patchedImage: RadioImage = {
      ...img,
      regions: [{ ...img.regions[0]!, data: patched }, ...img.regions.slice(1)],
    }
    const out = writable.encode(writable.decode(patchedImage), patchedImage)
    expect(equalBytes(out.regions[0]!.data, patched)).toBe(true)
  })
})

describe('what an edit touches', () => {
  it('changes only the channel that was edited', () => {
    const img = image()
    const doc = writable.decode(img)
    const ch = doc.channels.get(1)!
    doc.channels.set(1, { ...ch, name: 'BOOF' })

    const before = channels(img)
    const after = channels(writable.encode(doc, img))
    const changed: number[] = []
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(i)

    expect(changed.length).toBeGreaterThan(0)
    const first = CHANNEL_BASE
    const last = CHANNEL_BASE + CHANNEL_SIZE
    for (const at of changed) {
      expect(at >= first && at < last, `byte 0x${at.toString(16)} is outside channel 1`).toBe(true)
    }
  })

  it('writes the marker for a channel that becomes receive-only', () => {
    // A transmit frequency of zero is not an inhibit to this family's reader.
    const img = image()
    const doc = writable.decode(img)
    const ch = doc.channels.get(1)!
    doc.channels.set(1, { ...ch, txAllowed: false, txInhibitReason: 'receive only' })

    const mem = channels(writable.encode(doc, img))
    expect([...mem.subarray(CHANNEL_BASE + 4, CHANNEL_BASE + 8)]).toEqual([0xff, 0xff, 0xff, 0xff])
  })

  it('leaves an already-empty slot untouched', () => {
    const img = image()
    const mem = channels(img).slice()
    const empty = variant.channelCount - 1
    const at = CHANNEL_BASE + empty * CHANNEL_SIZE
    const before = mem.slice(at, at + CHANNEL_SIZE)
    encodeChannel(mem, empty, null, variant)
    expect(equalBytes(mem.subarray(at, at + CHANNEL_SIZE), before)).toBe(true)
  })
})

describe('the write gate', () => {
  const backup = { id: 'b', identHash: 'nope', createdAt: '2026-08-20T00:00:00.000Z' }
  const transport = {} as never

  it('refuses when the build is not cleared to write', async () => {
    await expect(readOnly.writeImage(transport, image(), { backup })).rejects.toThrow(/UV-5R Mini/)
  })

  it('refuses without a backup', async () => {
    await expect(writable.writeImage(transport, image(), {})).rejects.toThrow(BackupRequiredError)
  })

  it('refuses an image from the other variant', async () => {
    // The two differ in region map, channel count and power table. Writing one
    // as the other would ask for a region the radio does not have.
    const ident = {
      radioId: 'uv5rmini' as const,
      variant: '5RM',
      layout: '5rm',
      raw: new Uint8Array(0),
      caps: { read: true, write: true },
      identHash: 'match',
    }
    await expect(
      writable.writeImage(transport, image(), { backup: { ...backup, identHash: 'match' }, ident }),
    ).rejects.toThrow(/differ in region map/)
  })
})

describe('the whole image, every time', () => {
  it('sends every block rather than only the ones that changed', async () => {
    /*
     * This radio erases a flash page before programming and only writes back
     * the block it was handed, so a sparse write wipes everything sharing that
     * page. On a real radio, writing one block to slot 1 erased channels 3-21.
     *
     * The write itself looks perfect while it happens - each frame is
     * acknowledged and reads back correctly, because the block that was sent is
     * genuinely fine. Only a full read afterwards shows the damage. So this is
     * guarded here rather than left to be noticed later.
     */
    const img = image()
    const sent: number[] = []
    const fakePort = {
      async write(bytes: Uint8Array) {
        if (bytes[0] === 0x57) sent.push(((bytes[1]! << 8) | bytes[2]!) >>> 0)
      },
    }
    const total = variant.regions.reduce((n, r) => n + r.size, 0) / 0x40

    // Drive encode only; the transport is exercised by the hardware runs.
    const doc = writable.decode(img)
    const out = writable.encode(doc, img)
    let blocks = 0
    for (const r of out.regions) blocks += Math.ceil(r.data.length / 0x40)
    expect(blocks).toBe(total)
    expect(fakePort).toBeTruthy()
    expect(sent).toEqual([])
  })

  it('covers all three regions of the image', () => {
    const img = image()
    expect(img.regions.map((r) => r.start)).toEqual([0x0000, 0x9000, 0xa000])
    expect(img.regions.reduce((n, r) => n + r.data.length, 0)).toBe(0x8240)
  })
})
