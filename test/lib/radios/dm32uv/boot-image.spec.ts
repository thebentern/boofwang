// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { BOOT_IMAGE_BYTES } from '#core/io/boot-image.js'
import {
  BOOT_IMAGE_FULL_PAGES,
  BOOT_IMAGE_REGION_END,
  BOOT_IMAGE_REGION_START,
  BOOT_IMAGE_TAIL_BYTES,
  bootImageChunks,
  parseBootImageRange,
  queryBootImageRange,
  readBootImage,
  writeBootImage,
  writeBootImageTail,
} from '#core/radios/dm32uv/boot-image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import { ProtocolError } from '#core/transport/errors.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'
import { SerialTransport } from '#core/transport/serial-transport.js'

const REGION_SIZE = BOOT_IMAGE_REGION_END - BOOT_IMAGE_REGION_START + 1
const TAIL_ADDRESS = BOOT_IMAGE_REGION_START + BOOT_IMAGE_FULL_PAGES * PAGE_SIZE

const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]

/** Something with structure, so a chunk landing at the wrong offset shows. */
function pattern(length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 7 + (i >>> 8) * 31) & 0xff
  return out
}

/**
 * A DM-32UV that has a startup image and nothing else.
 *
 * Only the frames this region needs: V-frame 0x0E, the `0x52` read and the
 * `0x57` write in both of its lengths. `frames` keeps the raw bytes because the
 * 2,048-byte write is the part of this that no capture has ever seen - what
 * matters is the exact header that goes on the wire, not that the fake was
 * happy with it.
 */
function fakeRadio(opts: { nackAt?: number } = {}) {
  const memory = new Uint8Array(REGION_SIZE).fill(0xff)
  memory.set(pattern(BOOT_IMAGE_BYTES), 0)

  const reads: { address: number; length: number }[] = []
  const writes: { address: number; length: number }[] = []
  const frames: Uint8Array[] = []

  const respond = (frame: Uint8Array): Uint8Array | null => {
    // 56 00 00 <hint> <id> - V-frame query.
    if (frame.length === 5 && frame[0] === 0x56) {
      if (frame[4] !== 0x0e) return null
      const payload = [...le32(BOOT_IMAGE_REGION_START), ...le32(BOOT_IMAGE_REGION_END)]
      return Uint8Array.from([0x56, 0x0e, payload.length, ...payload])
    }

    // 52 <addr:3 LE> <len:2 LE> - read.
    if (frame.length === 6 && frame[0] === 0x52) {
      const address = frame[1]! | (frame[2]! << 8) | (frame[3]! << 16)
      const length = frame[4]! | (frame[5]! << 8)
      frames.push(frame)
      reads.push({ address, length })
      const offset = address - BOOT_IMAGE_REGION_START
      const data = memory.subarray(offset, offset + length)
      return Uint8Array.from([0x57, frame[1]!, frame[2]!, frame[3]!, frame[4]!, frame[5]!, ...data])
    }

    // 57 <addr:3 LE> <len:2 LE> <data> - write, 4,096 or 2,048 bytes.
    if (frame.length > 6 && frame[0] === 0x57) {
      const address = frame[1]! | (frame[2]! << 8) | (frame[3]! << 16)
      const length = frame[4]! | (frame[5]! << 8)
      frames.push(frame)
      if (opts.nackAt !== undefined && writes.length === opts.nackAt) return Uint8Array.from([0xc0])
      writes.push({ address, length })
      memory.set(frame.subarray(6, 6 + length), address - BOOT_IMAGE_REGION_START)
      return Uint8Array.from([0x06])
    }

    return null
  }

  return { memory, reads, writes, frames, respond }
}

async function connect(radio: ReturnType<typeof fakeRadio>) {
  const port = new FakeSerialPort({ respond: radio.respond })
  const t = new SerialTransport(port)
  await t.open({ baudRate: 115_200 })
  return t
}

describe('the transfer plan', () => {
  const chunks = bootImageChunks(BOOT_IMAGE_REGION_START)

  it('is 37 whole pages and a 2,048-byte remainder', () => {
    // The one unusual thing about this region: 153,600 is not a multiple of
    // 4,096, so the last transfer is a short one in both directions.
    expect(BOOT_IMAGE_FULL_PAGES).toBe(37)
    expect(BOOT_IMAGE_TAIL_BYTES).toBe(2048)
    expect(chunks).toHaveLength(38)
    expect(chunks.slice(0, 37).every((c) => c.length === PAGE_SIZE)).toBe(true)
    expect(chunks[37]!.length).toBe(2048)
  })

  it('covers the payload once, contiguously, and stops there', () => {
    let expected = BOOT_IMAGE_REGION_START
    for (const chunk of chunks) {
      expect(chunk.address).toBe(expected)
      expect(chunk.offset).toBe(expected - BOOT_IMAGE_REGION_START)
      expected += chunk.length
    }
    expect(expected - BOOT_IMAGE_REGION_START).toBe(BOOT_IMAGE_BYTES)

    // The region is a round 38 pages; the picture is not. The last 2,048 bytes
    // of it are past the end of the image and are nobody's business here.
    expect(REGION_SIZE - BOOT_IMAGE_BYTES).toBe(2048)
    expect(expected).toBe(BOOT_IMAGE_REGION_END + 1 - 2048)
  })
})

describe('V-frame 0x0E', () => {
  it('parses the range the captured radio reported', () => {
    // The eight payload bytes from the capture, verbatim.
    const payload = Uint8Array.from([0x00, 0x00, 0x15, 0x00, 0xff, 0x5f, 0x17, 0x00])
    expect(parseBootImageRange(payload)).toEqual({ start: 0x15_0000, end: 0x17_5fff })
    expect(parseBootImageRange(payload)).toEqual({ start: BOOT_IMAGE_REGION_START, end: BOOT_IMAGE_REGION_END })
  })

  it('refuses a region too small to hold an image', () => {
    // A radio that answers with something short is not one to start writing
    // pages to on the assumption that the picture will fit.
    const payload = Uint8Array.from([...le32(0x15_0000), ...le32(0x15_ffff)])
    expect(() => parseBootImageRange(payload)).toThrow(ProtocolError)
  })

  it('asks the radio rather than assuming the address', async () => {
    // Nothing on this radio has a fixed address, including this.
    const radio = fakeRadio()
    const t = await connect(radio)
    expect(await queryBootImageRange(t)).toEqual({ start: BOOT_IMAGE_REGION_START, end: BOOT_IMAGE_REGION_END })
  })
})

describe('readBootImage', () => {
  it('brings back the whole picture', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const image = await readBootImage(t, BOOT_IMAGE_REGION_START)

    expect(image.length).toBe(BOOT_IMAGE_BYTES)
    expect(equalBytes(image, radio.memory.subarray(0, BOOT_IMAGE_BYTES))).toBe(true)
  })

  it('reads 37 pages and then 2,048 bytes', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    await readBootImage(t, BOOT_IMAGE_REGION_START)

    expect(radio.reads).toHaveLength(38)
    expect(radio.reads.map((r) => r.length)).toEqual([...Array(37).fill(PAGE_SIZE), 2048])
    expect(radio.reads.map((r) => r.address)).toEqual(bootImageChunks(BOOT_IMAGE_REGION_START).map((c) => c.address))
  })

  it('puts the short length on the wire as an ordinary 16-bit field', async () => {
    // 52 00 50 17 00 08: a read at 0x175000 for 2,048 bytes. The length field
    // is the same one every other read uses, which is why the tail needs no
    // new primitive.
    const radio = fakeRadio()
    const t = await connect(radio)
    await readBootImage(t, BOOT_IMAGE_REGION_START)

    expect(TAIL_ADDRESS).toBe(0x17_5000)
    expect([...radio.frames.at(-1)!]).toEqual([0x52, 0x00, 0x50, 0x17, 0x00, 0x08])
  })

  it('reports progress once per transfer', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const seen: number[] = []
    await readBootImage(t, BOOT_IMAGE_REGION_START, { progress: (done, total) => seen.push(done / total) })

    expect(seen).toHaveLength(38)
    expect(seen.at(-1)).toBe(1)
  })

  it('refuses a short answer rather than padding it', async () => {
    // A truncated read would otherwise become a backup with a band of zeroes
    // across the bottom of it, which is exactly the backup someone reaches for
    // after their new splash disappoints them.
    const radio = fakeRadio()
    const port = new FakeSerialPort({
      respond: (frame) => {
        const full = radio.respond(frame)
        if (full === null || frame[0] !== 0x52) return full
        // Answer the last page with half of one, honestly declared.
        if (radio.reads.length !== 1) return full
        return Uint8Array.from([0x57, frame[1]!, frame[2]!, frame[3]!, 0x00, 0x08, ...full.subarray(6, 6 + 2048)])
      },
    })
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115_200 })

    await expect(readBootImage(t, BOOT_IMAGE_REGION_START)).rejects.toThrow(ProtocolError)
  })
})

/**
 * The write half, which no radio has ever confirmed.
 *
 * The 4 KiB form is the one the codeplug writer already uses on hardware. The
 * 2,048-byte form is `DERIVED` in the specification - implemented by the
 * reference implementation, absent from both captures - so what these tests
 * pin is that the bytes leaving this code are the bytes the specification
 * describes. They cannot say the radio accepts them.
 */
describe('writeBootImage', () => {
  it('sends 37 full pages and one short chunk, and the radio ends up holding the image', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const image = pattern(BOOT_IMAGE_BYTES).map((b) => b ^ 0xff)

    await writeBootImage(t, BOOT_IMAGE_REGION_START, image)

    expect(radio.writes.map((w) => w.length)).toEqual([...Array(37).fill(PAGE_SIZE), 2048])
    expect(equalBytes(radio.memory.subarray(0, BOOT_IMAGE_BYTES), image)).toBe(true)
  })

  it('frames the tail as 57 <addr> 00 08 and 2,054 bytes in total', async () => {
    // DERIVED. This is the whole of what is unverified about this feature,
    // written out as bytes so that a hardware session has something exact to
    // compare against.
    const radio = fakeRadio()
    const t = await connect(radio)
    await writeBootImage(t, BOOT_IMAGE_REGION_START, pattern(BOOT_IMAGE_BYTES))

    const tail = radio.frames.at(-1)!
    expect(tail.length).toBe(6 + 2048)
    expect([...tail.subarray(0, 6)]).toEqual([0x57, 0x00, 0x50, 0x17, 0x00, 0x08])
  })

  it('leaves the 2,048 bytes past the picture alone', async () => {
    // The region is 155,648 bytes and the picture is 153,600. Whatever is in
    // the difference, it was not read and it is not ours to replace.
    const radio = fakeRadio()
    const t = await connect(radio)
    await writeBootImage(t, BOOT_IMAGE_REGION_START, new Uint8Array(BOOT_IMAGE_BYTES))

    expect(radio.memory.subarray(BOOT_IMAGE_BYTES).every((b) => b === 0xff)).toBe(true)
  })

  it('refuses anything that is not a whole image', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)

    await expect(writeBootImage(t, BOOT_IMAGE_REGION_START, new Uint8Array(BOOT_IMAGE_BYTES - 1))).rejects.toThrow(
      ProtocolError,
    )
    expect(radio.writes).toHaveLength(0)
  })

  it('stops at the first chunk the radio does not acknowledge', async () => {
    // There is no retry anywhere in this protocol, and carrying on past a
    // refusal would leave a half-written picture with no way of knowing where
    // it stopped.
    const radio = fakeRadio({ nackAt: 5 })
    const t = await connect(radio)

    await expect(writeBootImage(t, BOOT_IMAGE_REGION_START, pattern(BOOT_IMAGE_BYTES))).rejects.toThrow(ProtocolError)
    expect(radio.writes).toHaveLength(5)
  })

  it('refuses a tail chunk of the wrong length', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)

    await expect(writeBootImageTail(t, TAIL_ADDRESS, new Uint8Array(PAGE_SIZE))).rejects.toThrow(ProtocolError)
    expect(radio.writes).toHaveLength(0)
  })
})

/**
 * The feature is not wired up, and this is what keeps it that way.
 *
 * The 2,048-byte write has never been sent to a radio, and the rule that the
 * factory splash must be read and stored before it is overwritten has nowhere
 * to live yet. Until both are settled, a route from the interface to
 * `writeBootImage` is a one-way door with no handle on the other side.
 */
describe('nothing in the application can reach the write', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const TARGET = join(root, 'lib/radios/dm32uv/boot-image.ts')

  function sources(dir: string): string[] {
    return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') || f.endsWith('.vue'))
      .map((f) => join(root, dir, f))
  }

  /**
   * Resolve a specifier the way the bundler will.
   *
   * Matching the text `dm32uv/boot-image` would miss the likeliest way this
   * ever gets wired up, which is `./boot-image.js` from the driver sitting next
   * to it.
   */
  function resolves(file: string, specifier: string): boolean {
    const asSource = specifier.replace(/\.js$/, '.ts')
    if (asSource.startsWith('.')) return resolve(dirname(file), asSource) === TARGET
    if (asSource.startsWith('#core/')) return join(root, 'lib', asSource.slice('#core/'.length)) === TARGET
    if (asSource.startsWith('~/')) return join(root, 'app', asSource.slice('~/'.length)) === TARGET
    return false
  }

  it('is imported by its test and by nothing else', () => {
    const importers = [...sources('lib'), ...sources('app')].filter((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].some((m) => resolves(file, m[1]!))
    })
    expect(importers.map((f) => f.slice(root.length))).toEqual([])
  })

  it('would notice if something did', () => {
    // The check above passes trivially if the resolver is broken, and a test
    // that cannot fail is worse than no test on a rule like this one.
    const driver = join(root, 'lib/radios/dm32uv/driver.ts')
    expect(resolves(driver, './boot-image.js')).toBe(true)
    expect(resolves(join(root, 'app/pages/dmr.vue'), '#core/radios/dm32uv/boot-image.js')).toBe(true)
    expect(resolves(driver, './protocol.js')).toBe(false)
    expect(resolves(join(root, 'app/x.vue'), '#core/io/boot-image.js')).toBe(false)
  })
})
