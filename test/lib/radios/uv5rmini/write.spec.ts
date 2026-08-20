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
  /**
   * A transport that answers like the radio, and records what it was sent.
   *
   * The previous version of this test built a fake port, never handed it to
   * anything, and asserted that no frames were produced - so it passed whether
   * the driver sent 521 blocks, one block, or none. Reintroducing the sparse
   * write left the whole suite green. This one drives `writeImage` for real.
   */
  function scriptedRadio() {
    const writes: number[] = []
    const memory = new Map<number, Uint8Array>()
    let pending: Uint8Array[] = []

    const push = (b: Uint8Array) => pending.push(b)

    return {
      writes,
      transport: {
        async write(bytes: Uint8Array) {
          // Identify, then the three magics, then read and write frames.
          if (bytes.length === 16) return push(Uint8Array.from([0x06]))
          if (bytes.length === 1 && bytes[0] === 0x46) return push(new Uint8Array(16))
          if (bytes.length === 1 && bytes[0] === 0x4d) return push(new Uint8Array(15))
          if (bytes.length === 25) return push(Uint8Array.from([0x06]))

          const addr = ((bytes[1]! << 8) | bytes[2]!) >>> 0
          if (bytes[0] === 0x57) {
            writes.push(addr)
            memory.set(addr, bytes.slice(4))
            return push(Uint8Array.from([0x06]))
          }
          if (bytes[0] === 0x52) {
            const head = Uint8Array.from([0x52, bytes[1]!, bytes[2]!, bytes[3]!])
            const body = memory.get(addr) ?? new Uint8Array(0x40)
            const out = new Uint8Array(head.length + body.length)
            out.set(head, 0)
            out.set(body, head.length)
            return push(out)
          }
        },
        async readExactly(n: number) {
          const next = pending.shift() ?? new Uint8Array(n)
          return next.subarray(0, n)
        },
        async resync() {
          pending = []
          return new Uint8Array(0)
        },
      } as never,
    }
  }

  it('sends every block of every region, not only the ones that changed', async () => {
    /*
     * This radio erases a flash page before programming and writes back only
     * the block it was handed, so a sparse write wipes everything sharing that
     * page. On a real radio, writing one block to name channel 1 erased
     * channels 3-21.
     *
     * Nothing else catches a regression here. Each frame is acknowledged, each
     * block reads back correctly, and the round-trip invariant stays
     * byte-identical - because the block that was sent genuinely is right.
     */
    const img = image()
    const doc = writable.decode(img)
    doc.channels.set(1, { ...doc.channels.get(1)!, name: 'BOOF' })
    const edited = writable.encode(doc, img)

    const radio = scriptedRadio()
    const ident = {
      radioId: 'uv5rmini' as const,
      variant: '5RMINI',
      layout: 'uv5rmini',
      raw: new Uint8Array(0),
      caps: { read: true, write: true },
      identHash: 'match',
    }
    /*
     * baseImage is supplied because the real flow always supplies it - that is
     * how the other three drivers know which blocks changed. Omitting it here
     * would leave the dangerous path untested: a reintroduced sparse write only
     * skips blocks when it has a base to compare against, so a test without one
     * passes no matter what the driver does.
     */
    const report = await writable.writeImage(radio.transport, edited, {
      backup: { id: 'b', identHash: 'match', createdAt: '2026-08-20T00:00:00.000Z' },
      ident,
      baseImage: img,
    })

    const expected: number[] = []
    for (const r of variant.regions) {
      for (let off = 0; off < r.size; off += 0x40) expected.push(r.start + off)
    }

    expect(radio.writes).toEqual(expected)
    expect(radio.writes).toHaveLength(521)
    expect(report.blocksWritten).toBe(521)
    expect(report.verified).toBe(true)
  })

  it('sends the same count when nothing was edited at all', async () => {
    // A sparse implementation would send zero here. This one still sends the
    // image, because a partial write is what does the damage.
    const img = image()
    const radio = scriptedRadio()
    const ident = {
      radioId: 'uv5rmini' as const,
      variant: '5RMINI',
      layout: 'uv5rmini',
      raw: new Uint8Array(0),
      caps: { read: true, write: true },
      identHash: 'match',
    }
    await writable.writeImage(radio.transport, img, {
      backup: { id: 'b', identHash: 'match', createdAt: '2026-08-20T00:00:00.000Z' },
      ident,
      baseImage: img,
    })
    expect(radio.writes).toHaveLength(521)
  })

  it('covers all three regions of the image', () => {
    const img = image()
    expect(img.regions.map((r) => r.start)).toEqual([0x0000, 0x9000, 0xa000])
    expect(img.regions.reduce((n, r) => n + r.data.length, 0)).toBe(0x8240)
  })
})

describe('programming an empty slot', () => {
  it('does not inherit the erased flash bits', () => {
    /*
     * An erased record is 32 bytes of 0xFF, so every bit this build does not
     * model reads as set - scramble, FHSS, squelch mode and the unknown runs.
     * Patching only the known fields left a brand-new channel carrying features
     * the user never chose and the UI never shows.
     */
    const img = image()
    const doc = writable.decode(img)
    const empty = variant.channelCount - 1
    const at = CHANNEL_BASE + empty * CHANNEL_SIZE
    expect(img.regions[0]!.data[at]).toBe(0xff)

    doc.channels.set(empty + 1, {
      ...doc.channels.get(1)!,
      index: empty + 1,
      name: 'NEW',
    })

    const mem = channels(writable.encode(doc, img))
    const record = mem.subarray(at, at + CHANNEL_SIZE)

    // The bytes this build does not model must be clear, not inherited 0xFF.
    expect([...record.subarray(0x10, 0x14)]).toEqual([0, 0, 0, 0])
    expect(record[0x0f]! & 0b1000_0001).toBe(0)
  })

  it('still leaves an untouched empty slot exactly as found', () => {
    const img = image()
    const before = channels(img).slice()
    writable.encode(writable.decode(img), img)
    expect(equalBytes(channels(img), before)).toBe(true)
  })
})
