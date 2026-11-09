// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { LoopbackDetectedError, NoRadioResponseError } from '#core/radio/driver.js'
import { createDriver } from '#core/radio/registry.js'
import { IDENT_UV9R, createUv9rDriver } from '#core/radios/uv9r/driver.js'
import {
  BLOCK_SIZE,
  IDENT_OFFSET,
  IMAGE_SIZE,
  MAGIC_WP970I,
  MEM_SIZE,
  firmwareVersion,
} from '#core/radios/uv9r/protocol.js'
import { MAGIC_UV82 } from '#core/radios/uv82/protocol.js'
import { MAGIC_UV5G } from '#core/radios/uv5g/protocol.js'
import { MAGIC_UV5R_291 } from '#core/radios/uv5r/protocol.js'
import { MAGIC_UV9G } from '#core/radios/uv9g/protocol.js'
import { type AckModel, drive, fakeRadio } from './fake-radio.js'

/**
 * The WP970I family's wire protocol, against a scripted radio.
 *
 * Not against hardware - nobody here has one of these radios - but against
 * CHIRP's baofeng_common.py written as the other end of the conversation, and
 * run under both readings of the one thing CHIRP leaves open (see
 * fake-radio.ts). What this pins is that the driver says what CHIRP says, in
 * the order CHIRP says it.
 */
const SYNTHETIC = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv9r-chirp-synthetic.bin', import.meta.url))),
)
const MEMORY = SYNTHETIC.slice(0, MEM_SIZE)
// CHIRP's UV-9G test image, whose 0x1FCF holds data, so CHIRP's dropped-byte
// test stays quiet and a read is the plain 0x40 sweep.
const UV9G_MEMORY = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv9g-chirp-test.bin', import.meta.url))),
).slice(0, MEM_SIZE)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const registry = createDriver('uv9r')
const writable = createUv9rDriver({ enableWrite: true })
const MODELS: readonly AckModel[] = ['answers-host-ack', 'acks-each-read']

describe('the magic', () => {
  it("is CHIRP's MSTRING_WP970I, which seven of CHIRP's models share", () => {
    expect([...MAGIC_WP970I]).toEqual([0x50, 0xbb, 0xff, 0x20, 0x14, 0x04, 0x13])
  })

  it('is not any other magic boofwang sends', () => {
    for (const other of [MAGIC_UV82, MAGIC_UV5G, MAGIC_UV5R_291, MAGIC_UV9G]) {
      expect([...MAGIC_WP970I]).not.toEqual([...other])
    }
  })
})

describe.each(MODELS)('identify, when the radio %s', (ackModel) => {
  it('sends the magic whole and reads an eight-byte ident', async () => {
    const radio = fakeRadio(MEMORY, { magic: MAGIC_WP970I, ident: IDENT_UV9R, ackModel })
    const ident = await drive(registry.identify(radio.transport, {}))
    expect(ident.radioId).toBe('uv9r')
    expect([...ident.raw]).toEqual([...IDENT_UV9R])
    // The firmware probe, block for block: 0x1E80 first and discarded, then the
    // window at 0x1EC0, then 0x1FC0 for the dropped-byte test.
    expect(radio.reads).toEqual([
      { addr: 0x1e80, size: BLOCK_SIZE },
      { addr: 0x1ec0, size: BLOCK_SIZE },
      { addr: 0x1fc0, size: BLOCK_SIZE },
    ])
  })

  it('reports read and not write from the registry build, with nothing to explain', async () => {
    const radio = fakeRadio(MEMORY, { magic: MAGIC_WP970I, ident: IDENT_UV9R, ackModel })
    const ident = await drive(registry.identify(radio.transport, {}))
    // The schema says why, through the write gate; the ident has no reason of
    // its own because nothing is wrong with the radio.
    expect(ident.caps).toEqual({ read: true, write: false })
  })

  it('would offer writing on a known ident, if the build allowed it', async () => {
    const radio = fakeRadio(MEMORY, { magic: MAGIC_WP970I, ident: IDENT_UV9R, ackModel })
    const ident = await drive(writable.identify(radio.transport, {}))
    expect(ident.caps).toEqual({ read: true, write: true })
  })
})

describe('identify, when something is wrong', () => {
  it('offers an ident no captured UV-9R has sent read-only, and says why', async () => {
    const odd = Uint8Array.from([0xaa, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0xdd])
    const radio = fakeRadio(MEMORY, { magic: MAGIC_WP970I, ident: odd })
    const ident = await drive(writable.identify(radio.transport, {}))
    expect(ident.caps.read).toBe(true)
    expect(ident.caps.write).toBe(false)
    expect(ident.caps.reason).toContain('aa 11 22 33 44 55 66 dd')
  })

  it('offers a radio that reports a firmware string read-only, and says why', async () => {
    // uv5r.py sends this magic to the BF-F8HP too, and the bench UV-82 sends
    // this family's ident: a UV-5R family radio can pass both. What it cannot
    // do is leave the firmware window empty, which every capture of this
    // family does. `BFP3V3 F` is one of the BF-F8HP's own basetypes.
    const f8hp = MEMORY.slice()
    f8hp.set(new TextEncoder().encode('BFP3V3 F'), 0x1ef0)
    const radio = fakeRadio(f8hp, { magic: MAGIC_WP970I, ident: IDENT_UV9R })
    const ident = await drive(writable.identify(radio.transport, {}))
    expect(ident.variant).toBe('BFP3V3 F')
    expect(ident.caps.read).toBe(true)
    expect(ident.caps.write).toBe(false)
    expect(ident.caps.reason).toMatch(/BFP3V3 F[\s\S]*BF-F8HP/)
  })

  it('refuses a reply that is not framed AA .. DD', async () => {
    const bad = Uint8Array.from([0xab, 0x30, 0x79, 0x04, 0x00, 0x05, 0x20, 0xdd])
    const radio = fakeRadio(MEMORY, { magic: MAGIC_WP970I, ident: bad })
    await expect(drive(registry.identify(radio.transport, {}))).rejects.toThrow(/identification reply/)
  })

  it('tries again when the first answer is a refusal', async () => {
    // The UV-5G's first contact after idling, and the UV-9G sends the UV-5G's
    // ident: one retry is the difference between a read and a refusal.
    const radio = fakeRadio(MEMORY, { magic: MAGIC_WP970I, ident: IDENT_UV9R, refuseFirstMagic: true })
    const ident = await drive(registry.identify(radio.transport, {}))
    expect([...ident.raw]).toEqual([...IDENT_UV9R])
  })

  it('says the radio is silent when it is', async () => {
    // A UV-9G behind the UV-9R's magic: a different radio, which answers
    // nothing rather than something wrong.
    const radio = fakeRadio(MEMORY, { magic: MAGIC_UV9G, ident: IDENT_UV9R })
    await expect(drive(registry.identify(radio.transport, {}))).rejects.toThrow(NoRadioResponseError)
  })

  it('names an adapter that echoes, on the first attempt', async () => {
    const radio = fakeRadio(MEMORY, { magic: MAGIC_WP970I, ident: IDENT_UV9R, loopback: true })
    await expect(drive(registry.identify(radio.transport, {}))).rejects.toThrow(LoopbackDetectedError)
  })
})

describe.each(MODELS)('reading, when the radio %s', (ackModel) => {
  it('returns the whole memory with the ident after it, as CHIRP saves it', async () => {
    const radio = fakeRadio(MEMORY, { magic: MAGIC_WP970I, ident: IDENT_UV9R, ackModel })
    const ident = await drive(registry.identify(radio.transport, {}))
    const image = await drive(registry.readImage(radio.transport, ident, {}))
    const data = image.regions[0]!.data
    expect(image.regions).toHaveLength(1)
    expect(data.length).toBe(IMAGE_SIZE)
    expect(equalBytes(data.subarray(0, MEM_SIZE), MEMORY)).toBe(true)
    expect([...data.subarray(IDENT_OFFSET)]).toEqual([...IDENT_UV9R])
    expect(equalBytes(data, SYNTHETIC)).toBe(true)
  })

  it('reads in 0x40 blocks and acknowledges every one', async () => {
    const radio = fakeRadio(UV9G_MEMORY, { magic: MAGIC_WP970I, ident: IDENT_UV9R, ackModel })
    const ident = await drive(registry.identify(radio.transport, {}))
    await drive(registry.readImage(radio.transport, ident, {}))
    const sweep = radio.reads.slice(3)
    expect(sweep).toHaveLength(MEM_SIZE / BLOCK_SIZE)
    expect(sweep.every((r, i) => r.addr === i * BLOCK_SIZE && r.size === BLOCK_SIZE)).toBe(true)
    // `_read_block` and `_download` send 0x06 after every block received.
    expect(radio.hostAcks).toBe(radio.reads.length)
  })
})

describe('a radio that drops the byte at 0x1FCF', () => {
  it('is detected the way CHIRP detects it, and its tail is read in sixteens', async () => {
    const radio = fakeRadio(MEMORY, { magic: MAGIC_WP970I, ident: IDENT_UV9R, droppedByte: true })
    const ident = await drive(registry.identify(radio.transport, {}))
    expect(ident.meta?.droppedByte).toBe(true)
    const image = await drive(registry.readImage(radio.transport, ident, {}))
    // The 0x40 read would have shifted the tail; the sixteens do not.
    expect(equalBytes(image.regions[0]!.data, SYNTHETIC)).toBe(true)
    expect(radio.reads.slice(-4)).toEqual([0x1fc0, 0x1fd0, 0x1fe0, 0x1ff0].map((addr) => ({ addr, size: 0x10 })))
  })

  it('is suspected on an honest radio too, when that byte is erased', async () => {
    const radio = fakeRadio(MEMORY, { magic: MAGIC_WP970I, ident: IDENT_UV9R })
    const ident = await drive(registry.identify(radio.transport, {}))
    // The synthetic image's limits end at 0x1FCE and what follows is erased
    // 0xFF, which is all CHIRP's test looks for - so a radio whose 0x40 read
    // is honest still takes the slow path. That is CHIRP's behavior and it
    // costs three reads; pinned so nobody "fixes" it into disagreeing.
    expect(MEMORY[0x1fcf]).toBe(0xff)
    expect(ident.meta?.droppedByte).toBe(true)
  })

  it('is not suspected where that byte holds data', async () => {
    expect(UV9G_MEMORY[0x1fcf]).toBe(0x15)
    const radio = fakeRadio(UV9G_MEMORY, { magic: MAGIC_WP970I, ident: IDENT_UV9R })
    const ident = await drive(registry.identify(radio.transport, {}))
    expect(ident.meta?.droppedByte).toBe(false)
  })
})

describe('the firmware window', () => {
  it("reads the factory's question marks as no firmware at all", () => {
    expect(firmwareVersion(new TextEncoder().encode('???????'))).toBe('')
    expect(firmwareVersion(Uint8Array.from([0x3f, 0x3f, 0x3f, 0xff, 0xff]))).toBe('')
  })

  it('reads an erased window as no firmware', () => {
    expect(firmwareVersion(new Uint8Array(14).fill(0xff))).toBe('')
  })

  it('keeps a real string, which is what the BF-A58 reports there', () => {
    // CHIRP's `_fileid` for the BF-A58: the one member of the family known to
    // put something in this window.
    expect(firmwareVersion(Uint8Array.from([...new TextEncoder().encode('BFT515 '), 0xff]))).toBe('BFT515')
  })
})
