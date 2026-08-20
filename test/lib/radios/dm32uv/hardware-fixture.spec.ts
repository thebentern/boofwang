// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { equalBytes } from '#core/codec/struct.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { DM32_CHANNEL, DM32_ZONE, talkgroupOffset } from '#core/radios/dm32uv/layout.js'
import { PAGE_SIZE, handshake, parseRange } from '#core/radios/dm32uv/protocol.js'
import { LoopbackDetectedError } from '#core/radio/driver.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { describeBlock, isAllocated } from '#core/radios/dm32uv/pagemap.js'

/**
 * A real Baofeng DM-32UV, read over an FTDI cable: it reports itself as
 * DP570UV on firmware DM32.01.01.040, 59 allocated 4 KiB pages out of 200.
 *
 * **The encryption key material has been redacted** - the 32-byte key field of
 * every record position in block 0x10 is zeroed, not merely the first
 * `KEY_SLOTS` of them. The slot ids, names and types are real, so the structure
 * is still exercised, but nobody's AES-256 keys live in this repository.
 *
 * The first redaction pass derived its bounds from `KEY_SLOTS`, which was 8
 * when the radio actually has 22, so it zeroed eight slots and left fourteen
 * real AES-256 keys in the file - and the test below passed anyway, because it
 * asked the decoder, which stopped at the same wrong number. The guard is now
 * written against the raw bytes and knows nothing about the layout constants.
 */
const BLOB = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.blocks.bin', import.meta.url))),
)
const INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.index.json', import.meta.url)), 'utf8'),
) as { model: string; firmware: string; region: [number, number]; tails: Record<string, number>; blocks: { id: number; physical: number; offset: number }[] }

function image(): RadioImage {
  return {
    radioId: 'dm32uv',
    variant: INDEX.firmware,
    layout: INDEX.model,
    createdAt: '2026-08-19T21:30:00.000Z',
    regions: INDEX.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: BLOB.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
    meta: { placements: INDEX.blocks.map((b) => ({ blockId: b.id, physical: b.physical })) },
    sha256: '',
  }
}

const driver = createDm32uvDriver()

describe('the flash translation layer', () => {
  it('scanned the whole 200-page configuration region', () => {
    expect(Object.keys(INDEX.tails)).toHaveLength(200)
    expect(INDEX.region).toEqual([0x001000, 0x0c8fff])
  })

  it('found 59 allocated pages, the rest free or superseded', () => {
    const tails = Object.values(INDEX.tails)
    expect(tails.filter(isAllocated)).toHaveLength(59)
    expect(tails.filter((b) => b === 0xff)).toHaveLength(35)
    expect(tails.filter((b) => b === 0x00)).toHaveLength(106)
  })

  it('gives every allocated block exactly one physical page', () => {
    const ids = INDEX.blocks.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('places blocks at addresses that bear no relation to their id', () => {
    // The whole reason nothing may be hardcoded: on this radio block 0x07 is
    // at the very bottom of the region while 0x02 is near the top.
    const at = (id: number) => INDEX.blocks.find((b) => b.id === id)!.physical
    expect(at(0x07)).toBe(0x001000)
    expect(at(0x02)).toBe(0x0aa000)
    expect(at(0x03)).toBe(0x011000)
    // Sorting by id does not sort by address.
    const byId = [...INDEX.blocks].sort((a, b) => a.id - b.id).map((b) => b.physical)
    expect(byId).not.toEqual([...byId].sort((a, b) => a - b))
  })

  it('addresses blocks logically, so a relocation cannot move them', () => {
    const img = image()
    expect(img.regions.find((r) => r.start === logicalAddress(0x10))).toBeDefined()
    expect(logicalAddress(0x10)).toBe(0x10000)
  })

  it('knows which blocks it cannot explain', () => {
    const undocumented = INDEX.blocks.filter((b) => describeBlock(b.id) === 'not documented')
    // 22 of 59 on this radio. They are still captured, byte for byte.
    expect(undocumented).toHaveLength(22)
    expect(describeBlock(0x10)).toMatch(/encryption/)
    expect(describeBlock(0x02)).toBe('calibration')
  })

  it('marks calibration read-only', () => {
    expect(image().regions.find((r) => r.start === logicalAddress(0x02))!.readOnly).toBe(true)
  })
})

describe('channels', () => {
  const cp = driver.decode(image())

  it('finds the 45 channels the radio reports', () => {
    expect(cp.channels.size).toBe(45)
  })

  it('decodes the GMRS block correctly', () => {
    expect(cp.channels.get(1)).toMatchObject({ name: 'GMRS 1', rxFreq: 462_562_500, modulation: 'FM' })
    expect(cp.channels.get(8)).toMatchObject({ name: 'GMRS 8', rxFreq: 467_562_500 })
    expect(cp.channels.get(15)).toMatchObject({ name: 'GMRS 15', rxFreq: 462_550_000 })
  })

  it('reads frequencies as little-endian packed BCD in units of 10 Hz', () => {
    // 462.5625 MHz is the case that breaks a truncating implementation.
    const raw = DM32_CHANNEL.read(image().regions.find((r) => r.start === logicalAddress(0x12))!.data, 0x10)
    expect(raw.rxFreq).toBe(462_562_500)
  })
})

describe('zones', () => {
  const cp = driver.decode(image())

  it('reads the count as a single byte, not a word', () => {
    // The specification's header layout gives 1796 here. This radio has four
    // zones, and the neighbouring byte is something else entirely.
    const zoneBlock = image().regions.find((r) => r.start === logicalAddress(0x5c))!.data
    expect(zoneBlock[0]).toBe(4)
    expect(zoneBlock[0]! | (zoneBlock[1]! << 8)).toBe(1796)
    expect(cp.zones).toHaveLength(4)
  })

  it('decodes each zone with its channel list', () => {
    expect(cp.zones.map((z) => z.name)).toEqual(['Tactical', 'GMRS', 'MURS', 'Repeaters'])
    expect(cp.zones[0]!.channels).toHaveLength(14)
    expect(cp.zones[0]!.channels.slice(0, 4)).toEqual([28, 29, 30, 31])
    expect(cp.zones[1]!.channels).toHaveLength(22)
    expect(cp.zones[1]!.channels.slice(0, 3)).toEqual([1, 2, 3])
    expect(cp.zones[2]!.channels).toEqual([23, 24, 25, 26, 27])
    expect(cp.zones[3]!.channels).toEqual([42, 43, 44, 45])
  })
})

describe('talk groups', () => {
  const cp = driver.decode(image())

  it('uses the spec’s record formula, with empty slots skipped', () => {
    // Records are 24 bytes, the first at offset 1 and the rest at
    // 25 + (N-2)*24. On this radio the populated names land exactly on
    // 0x02, 0x32, 0x4A, 0x7A, 0x92 and 0xDA.
    expect(talkgroupOffset(1)).toBe(1)
    expect(talkgroupOffset(3)).toBe(0x31)
    expect(talkgroupOffset(10)).toBe(0xd9)
  })

  it('decodes real Brandmeister talk groups', () => {
    const byName = Object.fromEntries(cp.talkGroups.map((t) => [t.name, t]))
    expect(byName['ARKANSAS']).toMatchObject({ number: 3105, callType: 'group' })
    expect(byName['USA']).toMatchObject({ number: 3100, callType: 'group' })
    expect(byName['LITTLE ROCK METR']).toMatchObject({ number: 310501, callType: 'group' })
    expect(byName['Test']).toMatchObject({ number: 98 })
    expect(byName['All Call']).toMatchObject({ number: 0xffffff, callType: 'allCall' })
  })
})

describe('encryption keys', () => {
  const cp = driver.decode(image())

  it('finds all twenty-two slots with their names and types', () => {
    // Twenty-two, not the eight the specification claims. Counted off the
    // radio: ids 1-22, every one AES-256, named "Encrypt 1".."Encrypt 22",
    // followed by zeroed records.
    expect(cp.encryptionKeys).toHaveLength(22)
    expect(cp.encryptionKeys.map((k) => k.slot)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1),
    )
    expect(cp.encryptionKeys.every((k) => k.type === 'aes256')).toBe(true)
    expect(cp.encryptionKeys[0]!.name).toBe('Encrypt 1')
    expect(cp.encryptionKeys[21]!.name).toBe('Encrypt 22')
  })

  it('carries the whole 32-byte field rather than trimming it', () => {
    // The specification says AES-256 is "right-aligned at +0x24", derived from
    // two samples. On this radio all 32 bytes from +0x0C are the key, so a
    // decoder that read only the last eight would silently truncate it. The
    // field travels verbatim.
    expect(cp.encryptionKeys[0]!.keyHex).toHaveLength(64)
  })

  it('is redacted in this fixture, deliberately', () => {
    // Real keys were read from the radio and zeroed before the fixture was
    // committed. If this ever fails, someone has checked in key material.
    expect(cp.encryptionKeys.every((k) => /^0+$/.test(k.keyHex))).toBe(true)
  })

  it('has no key material anywhere in block 0x10, whatever the layout says', () => {
    // Deliberately does not use KEY_SLOTS, KEY_BASE or the decoder. The
    // previous version of this guard asked the decoder how many slots there
    // were, the decoder said eight, and fourteen real keys sat in the file
    // underneath a green test. Walk every record position the block can hold.
    const block = image().regions.find((r) => r.start === logicalAddress(0x10))!.data
    const nonZero: string[] = []
    for (let off = 0x300; off + 0x2c <= block.length; off += 0x2c) {
      const field = block.subarray(off + 0x0c, off + 0x2c)
      if (field.some((b) => b !== 0)) nonZero.push(`0x${off.toString(16)}`)
    }
    expect(nonZero).toEqual([])
  })

  it('has no 32-byte run of distinct high-entropy bytes in the key table', () => {
    // A second, layout-blind net: real AES-256 keys are 32 bytes with almost no
    // repeats. Structured codeplug data is not.
    const block = image().regions.find((r) => r.start === logicalAddress(0x10))!.data
    let worst = 0
    for (let i = 0x300; i + 32 <= block.length; i++) {
      worst = Math.max(worst, new Set(block.subarray(i, i + 32)).size)
    }
    expect(worst).toBeLessThan(28)
  })
})

describe('the round-trip invariant, on real radio bytes', () => {
  const img = image()

  it('reading and writing back every channel record changes nothing', () => {
    const data = img.regions.find((r) => r.start === logicalAddress(0x12))!.data.slice()
    const before = data.slice()
    for (let i = 0; i * 48 + 0x10 + 48 < PAGE_SIZE; i++) {
      const off = 0x10 + i * 48
      DM32_CHANNEL.write(data, off, DM32_CHANNEL.read(data, off))
    }
    expect(equalBytes(data, before)).toBe(true)
  })

  it('reading and writing back every zone changes nothing', () => {
    const data = img.regions.find((r) => r.start === logicalAddress(0x5c))!.data.slice()
    const before = data.slice()
    for (let i = 0; 0x10 + (i + 1) * 145 < PAGE_SIZE; i++) {
      const off = 0x10 + i * 145
      DM32_ZONE.write(data, off, DM32_ZONE.read(data, off))
    }
    expect(equalBytes(data, before)).toBe(true)
  })

  it('holds for arbitrary mutations of a real channel record', () => {
    const base = img.regions.find((r) => r.start === logicalAddress(0x12))!.data
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.uint8Array({ minLength: 48, maxLength: 48 }), (slot, noise) => {
        const data = base.slice()
        const off = 0x10 + slot * 48
        for (let i = 0; i < 48; i++) data[off + i] = data[off + i]! ^ noise[i]!
        const before = data.slice()
        DM32_CHANNEL.write(data, off, DM32_CHANNEL.read(data, off))
        expect(equalBytes(data, before)).toBe(true)
      }),
      { numRuns: 250 },
    )
  })
})

describe('writing', () => {
  it('is off by default, so the schema the UI reads says so', () => {
    expect(driver.schema.capabilities.write).toBe(false)
  })

  it('claims nothing outside the key block, whatever else is enabled', () => {
    expect(driver.ownedRanges(0)).toEqual([])
    expect(driver.ownedRanges(logicalAddress(0x12))).toEqual([])
  })

  it('requires a power cycle after an interrupted session', () => {
    // There is no command to leave programming mode.
    expect(driver.abortPolicy).toBe('power-cycle')
  })
})

describe('the handshake, against a radio that talks first', () => {
  /**
   * Observed on hardware. This radio emits initialisation bytes after the port
   * opens; they sit in the receive buffer and are then mistaken for a reply.
   * The symptom is misleading - PSEARCH appears to succeed on the stray bytes,
   * every read afterwards is one response behind, and the error names PASSSTA:
   * `expected 50, received 90 fe 98`. The fix is to drain before speaking.
   */
  it('drains stray bytes before sending PSEARCH', async () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const port = new FakeSerialPort({
      // Three bytes of noise the radio emitted while the port settled.
      greeting: Uint8Array.from([0x90, 0xfe, 0x98]),
      respond: (written) => {
        const text = new TextDecoder().decode(written)
        if (text === 'PSEARCH') return Uint8Array.from([0x06, ...enc('DP570UV')])
        if (text === 'PASSSTA') return Uint8Array.from([0x50, 0x00, 0x00])
        if (text === 'SYSINFO') return Uint8Array.from([0x06])
        return null
      },
    })
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115_200 })
    await expect(handshake(t, { timeoutMs: 2000 })).resolves.toMatchObject({ model: 'DP570UV' })
    await t.close()
  })

  it('refuses a radio that is not a DM-32UV', async () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const port = new FakeSerialPort({
      respond: (w) =>
        new TextDecoder().decode(w) === 'PSEARCH' ? Uint8Array.from([0x06, ...enc('OTHER99')]) : null,
    })
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115_200 })
    await expect(handshake(t, { timeoutMs: 1000 })).rejects.toThrow(/not a DM-32UV/)
    await t.close()
  })
})

describe('a radio that is not ready', () => {
  /**
   * Measured on hardware. A fresh port opened at increasing gaps after a close
   * gets no reply at 0, 0.5, 1 and 2 seconds, and a correct one at 3. Retrying
   * on the *same* open port never recovers however long it waits - tried, four
   * attempts, identical failure - because the specification's state machine
   * resets the radio on "close port (DTR reset)". The close is the reset, so a
   * driver holding the port open has already missed its chance.
   *
   * The driver therefore does not retry. It explains, and the next connection
   * works.
   */
  const enc = (s: string) => new TextEncoder().encode(s)

  it('explains itself when the radio stays silent', async () => {
    const port = new FakeSerialPort({ respond: () => null })
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115_200 })
    const err = (await handshake(t, { timeoutMs: 800 }).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/not ready/)
    expect(err.message).toMatch(/about three seconds/)
    expect(err.message).toMatch(/try again/)
    await t.close()
  })

  it('blames the state, not the wrong command, when PASSSTA gets noise', async () => {
    // The original message read `PASSSTA failed: received 90 fe 98`, which
    // points at a step that was working perfectly.
    const port = new FakeSerialPort({
      respond: (w) => {
        const text = new TextDecoder().decode(w)
        if (text === 'PSEARCH') return Uint8Array.from([0x06, ...enc('DP570UV')])
        if (text === 'PASSSTA') return Uint8Array.from([0x90, 0xfe, 0x98])
        return null
      },
    })
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115_200 })
    const err = (await handshake(t, { timeoutMs: 800 }).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/not ready/)
    expect(err.message).toMatch(/answered PSEARCH but not PASSSTA/)
    expect(err.message).toMatch(/90 fe 98/)
    await t.close()
  })
})

describe('the reported memory range', () => {
  const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]

  it('accepts the range this radio actually reports', () => {
    const payload = Uint8Array.from([...le32(0x001000), ...le32(0x0c8fff)])
    expect(parseRange(payload)).toEqual({ start: 0x001000, end: 0x0c8fff })
  })

  it('refuses a range that ends before it starts', () => {
    // A V-frame shifted by an idle heartbeat parses cleanly into nonsense.
    // Accepting it produced an image with no regions - an empty "backup" that
    // still satisfied the requirement to have one before writing.
    const payload = Uint8Array.from([...le32(0x0c8fff), ...le32(0x001000)])
    expect(() => parseRange(payload)).toThrow(/ends before it starts/)
  })

  it('refuses a range smaller than a single page', () => {
    const payload = Uint8Array.from([...le32(0x001000), ...le32(0x001800)])
    expect(() => parseRange(payload)).toThrow(/smaller than one page/)
  })

  it('refuses a range past the end of the address space', () => {
    // The read command carries a 3-byte address; nothing above 0xFFFFFF can be
    // asked for, so a range claiming otherwise did not come from this radio.
    const payload = Uint8Array.from([...le32(0x001000), ...le32(0x1000_0000)])
    expect(() => parseRange(payload)).toThrow(/past the end/)
  })

  it('still refuses a payload too short to hold a range', () => {
    expect(() => parseRange(Uint8Array.from([1, 2, 3]))).toThrow(/too short/)
  })
})

describe('an echoing adapter', () => {
  it('is named as the cause, rather than blamed on the radio', () => {
    // A counterfeit adapter that shorts TX to RX echoes the seven bytes of
    // "PSEARCH" and nothing more. Waiting for eight bytes before inspecting any
    // of them turned that into "the radio did not answer at all" plus advice to
    // wait and retry - advice that can never work, and precisely the
    // misdiagnosis this error type was added to stop.
    return expect(
      (async () => {
        const port = new FakeSerialPort({ respond: (w) => w })
        const t = new SerialTransport(port)
        await t.open({ baudRate: 115_200 })
        try {
          await handshake(t, { timeoutMs: 600 })
        } finally {
          await t.close().catch(() => {})
        }
      })(),
    ).rejects.toThrow(LoopbackDetectedError)
  })
})
