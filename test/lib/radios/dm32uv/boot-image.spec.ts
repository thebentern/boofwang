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
  writeBootImageRegion,
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
function fakeRadio(opts: { nackAt?: number; dropWrites?: boolean } = {}) {
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
      // `dropWrites` acknowledges and stores nothing, which is exactly the
      // failure the read-back pass exists to catch: this radio has no checksum
      // in either direction and judges a write by one 0x06 byte.
      if (!opts.dropWrites) memory.set(frame.subarray(6, 6 + length), address - BOOT_IMAGE_REGION_START)
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
 * The write is reachable now, and the rule that guards it is the thing to pin.
 *
 * This used to assert that nothing in the application imported the write at
 * all, because the 2,048-byte frame had never been sent to a radio and the
 * "read it before you replace it" rule had nowhere to live. Both are settled:
 * the region is a whole number of pages so the derived frame is not needed, and
 * the rule lives in `useBootImage`.
 *
 * So the guard changes rather than goes. The region at 0x150000 is outside
 * every backup boofwang takes - a codeplug can be rebuilt from a CSV, the
 * factory picture cannot be rebuilt from anything - and the only copy that will
 * ever exist is the one read before the first write. A route to the radio that
 * skips that read is a one-way door with no handle on the other side.
 *
 * The rule used to live only in the composable. It is enforced in
 * `writeBootImageRegion` now - the function takes the held region and throws
 * without it, the way `writeImage` throws BackupRequiredError - and what the
 * composable keeps is the explanation: a warning toast instead of a thrown
 * error. The gate explains; the driver enforces. The checks below on the
 * composable are about that explanation still being in place, not about it
 * being the thing that keeps the radio safe.
 */
describe('the way to the radio goes through the backup rule', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const TARGET = join(root, 'lib/radios/dm32uv/boot-image.ts')
  const GATEKEEPER = join(root, 'app/composables/useBootImage.ts')

  function sources(dir: string): string[] {
    return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') || f.endsWith('.vue'))
      .map((f) => join(root, dir, f))
  }

  /**
   * Resolve a specifier the way the bundler will.
   *
   * Matching the text `dm32uv/boot-image` would miss the likeliest way this
   * gets reached, which is `./boot-image.js` from the driver next to it.
   */
  function resolves(file: string, specifier: string): boolean {
    const asSource = specifier.replace(/\.js$/, '.ts')
    if (asSource.startsWith('.')) return resolve(dirname(file), asSource) === TARGET
    if (asSource.startsWith('#core/')) return join(root, 'lib', asSource.slice('#core/'.length)) === TARGET
    if (asSource.startsWith('~/')) return join(root, 'app', asSource.slice('~/'.length)) === TARGET
    return false
  }

  const importers = () =>
    [...sources('lib'), ...sources('app')].filter((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].some((m) => resolves(file, m[1]!))
    })

  it('is reached from exactly one place, the composable that enforces the rule', () => {
    expect(importers().map((f) => f.slice(root.length))).toEqual(['app/composables/useBootImage.ts'])
  })

  it('explains, before the driver refuses, when nothing has been read', () => {
    // A source check, because there is no Vue harness in this suite. This is
    // the explaining half; the enforcing half is tested against a fake radio
    // in the describe below, and is what actually stops the write.
    const text = readFileSync(GATEKEEPER, 'utf8')
    const write = text.slice(text.indexOf('async function writeToRadio'))
    const body = write.slice(0, write.indexOf('\n  }') + 1)
    expect(body).toMatch(/const held = backup\.value/)
    expect(body).toMatch(/if \(!held\)/)
    // And it returns before reaching the radio rather than merely warning.
    expect(body.indexOf('return false')).toBeLessThan(body.indexOf('writeBootImageRegion'))
  })

  it('sends the whole region, so the derived short frame is never used', () => {
    const text = readFileSync(GATEKEEPER, 'utf8')
    expect(text).toMatch(/writeBootImageRegion/)
    expect(text).not.toMatch(/writeBootImageTail/)
  })

  it('would notice if something else imported it', () => {
    // The check above passes trivially if the resolver is broken, and a test
    // that cannot fail is worse than no test on a rule like this one.
    const driver = join(root, 'lib/radios/dm32uv/driver.ts')
    expect(resolves(driver, './boot-image.js')).toBe(true)
    expect(resolves(join(root, 'app/pages/dmr.vue'), '#core/radios/dm32uv/boot-image.js')).toBe(true)
    expect(resolves(driver, './protocol.js')).toBe(false)
    expect(resolves(join(root, 'app/x.vue'), '#core/io/boot-image.js')).toBe(false)
  })
})

/**
 * The enforcing half, against a fake radio.
 *
 * `writeBootImageRegion` will not write without the region that is about to be
 * overwritten. This is in lib, where anything that imports the function meets
 * it - the composable's toast can be bypassed by the next caller, this cannot.
 */
describe('writeBootImageRegion refuses without the picture it is replacing', () => {
  const range = { start: BOOT_IMAGE_REGION_START, end: BOOT_IMAGE_REGION_END }

  it('throws before any frame goes out when nothing is held', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    await expect(writeBootImageRegion(t, range, pattern(REGION_SIZE), null)).rejects.toThrow(/has not been read/)
    await expect(writeBootImageRegion(t, range, pattern(REGION_SIZE), undefined)).rejects.toThrow(/has not been read/)
    expect(radio.writes, 'a frame was sent before the refusal').toEqual([])
    await t.close()
  })

  it('throws when the held region is not the size the radio reports', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    await expect(
      writeBootImageRegion(t, range, pattern(REGION_SIZE), new Uint8Array(REGION_SIZE - 4096)),
    ).rejects.toThrow(/does not match the region/)
    expect(radio.writes).toEqual([])
    await t.close()
  })

  it('writes when the held region is present and the right size', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const want = pattern(REGION_SIZE)
    await writeBootImageRegion(t, range, want, new Uint8Array(REGION_SIZE).fill(0xff))
    expect(radio.writes).toHaveLength(REGION_SIZE / PAGE_SIZE)
    await t.close()
  })
})

/**
 * Where a startup-image write is allowed to land.
 *
 * These exist because the guard that was supposed to enforce it could not. The
 * call read `assertInRegion(range.start, region.length, range)` - it compared
 * the reported start against itself, so the containment test was
 * `range.start !== range.start` and never fired, and the size test compared a
 * length derived from the same two numbers. The module exported
 * BOOT_IMAGE_REGION_START "for cross-checking" and never checked anything with
 * it. Nothing in this file exercised any of the three error paths.
 *
 * The consequence is specific to this radio: writes are judged by a single
 * 0x06 byte with no checksum in either direction, and the read-back pass reads
 * the same addresses it wrote - so a wrong base is confirmed rather than
 * caught, and 38 pages land on the codeplug and its page ids.
 */
describe('a startup-image write cannot leave its region', () => {
  it('refuses a reported region below where one can be', () => {
    // 0x015000 is 0x150000 with a digit dropped - the case the guard names.
    const payload = Uint8Array.from([...le32(0x01_5000), ...le32(0x03_afff)])
    expect(() => parseBootImageRange(payload)).toThrow(ProtocolError)
    expect(() => parseBootImageRange(payload)).toThrow(/below where one can be/)
  })

  it('still accepts the region the radio actually reports', () => {
    const payload = Uint8Array.from([...le32(BOOT_IMAGE_REGION_START), ...le32(BOOT_IMAGE_REGION_END)])
    expect(parseBootImageRange(payload)).toEqual({
      start: BOOT_IMAGE_REGION_START,
      end: BOOT_IMAGE_REGION_END,
    })
  })

  it('allows a region that has moved up, since nothing above it is ours', () => {
    const start = BOOT_IMAGE_REGION_START + 0x10_0000
    const payload = Uint8Array.from([...le32(start), ...le32(start + REGION_SIZE - 1)])
    expect(parseBootImageRange(payload).start).toBe(start)
  })

  it('writes nothing when the region would fall outside itself', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    // A range whose end is short of what the pages need: the per-page check has
    // to fire before any frame goes on the wire.
    const range = { start: BOOT_IMAGE_REGION_START, end: BOOT_IMAGE_REGION_START + PAGE_SIZE - 1 }
    await expect(
      writeBootImageRegion(t, range, new Uint8Array(REGION_SIZE).fill(0xab), new Uint8Array(REGION_SIZE).fill(0xab)),
    ).rejects.toThrow(ProtocolError)
    await t.close()
  })

  it('refuses an unaligned region rather than writing across page boundaries', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const range = { start: BOOT_IMAGE_REGION_START + 1, end: BOOT_IMAGE_REGION_START + REGION_SIZE }
    await expect(writeBootImageRegion(t, range, new Uint8Array(REGION_SIZE), new Uint8Array(REGION_SIZE))).rejects.toThrow(ProtocolError)
    expect(radio.writes, 'a frame went out before the check').toEqual([])
    await t.close()
  })
})

/**
 * The whole-region write, which had no test at all despite being the only path
 * the application can reach - `writeBootImage`, the short-frame form, is the
 * one that was covered.
 */
describe('writing the whole region', () => {
  it('writes 38 whole pages and reads every one of them back', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const want = pattern(REGION_SIZE)
    const range = { start: BOOT_IMAGE_REGION_START, end: BOOT_IMAGE_REGION_END }

    await writeBootImageRegion(t, range, want, want)

    expect(radio.writes).toHaveLength(REGION_SIZE / PAGE_SIZE)
    expect(radio.writes.every((w) => w.length === PAGE_SIZE)).toBe(true)
    expect(radio.writes[0]!.address).toBe(BOOT_IMAGE_REGION_START)
    expect(radio.writes.at(-1)!.address).toBe(BOOT_IMAGE_REGION_END + 1 - PAGE_SIZE)
    // Every page is read back, so the verify pass is as long as the write pass.
    expect(radio.reads).toHaveLength(REGION_SIZE / PAGE_SIZE)
    expect([...radio.memory]).toEqual([...want])
    await t.close()
  })

  it('every address it writes is inside the region it was given', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const range = { start: BOOT_IMAGE_REGION_START, end: BOOT_IMAGE_REGION_END }
    await writeBootImageRegion(t, range, pattern(REGION_SIZE), pattern(REGION_SIZE))
    for (const w of radio.writes) {
      expect(w.address).toBeGreaterThanOrEqual(range.start)
      expect(w.address + w.length - 1).toBeLessThanOrEqual(range.end)
    }
    await t.close()
  })

  it('throws when a page is acknowledged but not stored', async () => {
    // The whole point of reading back: every frame here is ACKed and none of
    // it lands. Without the verify pass this write reports success.
    const radio = fakeRadio({ dropWrites: true })
    const t = await connect(radio)
    const range = { start: BOOT_IMAGE_REGION_START, end: BOOT_IMAGE_REGION_END }
    await expect(writeBootImageRegion(t, range, pattern(REGION_SIZE), pattern(REGION_SIZE))).rejects.toThrow(ProtocolError)
    expect(radio.writes.length, 'it should have sent the pages first').toBeGreaterThan(0)
    await t.close()
  })
})
