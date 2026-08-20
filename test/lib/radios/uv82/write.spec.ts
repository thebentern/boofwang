// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { BackupRequiredError, DriverError, type BackupRef } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv82Driver, encodeChannel } from '#core/radios/uv82/driver.js'
import { CHANNEL_COUNT, REGIONS, UV82_CHANNEL, channelAddr, ownedRanges } from '#core/radios/uv82/layout.js'
import { IDENT_SIZE, MAIN_SIZE, NEVER_WRITE, WRITE_BLOCK_SIZE } from '#core/radios/uv82/protocol.js'

const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv82-N822413.bin', import.meta.url))),
)

function image(): RadioImage {
  return {
    radioId: 'uv82',
    variant: 'N822413',
    layout: 'uv82',
    createdAt: '2026-08-20T00:00:00.000Z',
    regions: REGIONS.map((r) => ({
      start: r.start,
      data: RAW.slice(r.start, r.start + r.length),
      label: r.label,
      readOnly: r.readOnly,
    })),
    meta: {},
    sha256: '',
  }
}

const driver = createUv82Driver()
const writable = createUv82Driver({ enableWrite: true })
const memOf = (img: RadioImage) => img.regions[0]!.data

describe('the round-trip invariant, on real radio bytes', () => {
  it('encode(decode(image), image) is byte-identical', () => {
    const img = image()
    const out = writable.encode(writable.decode(img), img)
    expect(equalBytes(memOf(out), memOf(img))).toBe(true)
  })

  it('does not mutate the image it was given', () => {
    const img = image()
    const before = memOf(img).slice()
    writable.encode(writable.decode(img), img)
    expect(equalBytes(memOf(img), before)).toBe(true)
  })

  it('leaves an already-empty slot exactly as found', () => {
    // This radio marks an empty slot with 0xFF in its first byte and leaves the
    // rest as stale data. Filling the record would invent bytes the radio never
    // had - and it is what broke the invariant on the first attempt.
    const img = image()
    const mem = memOf(img)
    const empty: number[] = []
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      if (mem[channelAddr(i)] === 0xff) empty.push(i)
    }
    expect(empty.length).toBeGreaterThan(0)

    const patched = mem.slice()
    for (const i of empty) encodeChannel(patched, i, null)
    for (const i of empty) {
      const a = channelAddr(i)
      expect(
        equalBytes(patched.subarray(a, a + UV82_CHANNEL.size), mem.subarray(a, a + UV82_CHANNEL.size)),
        `slot ${i + 1}`,
      ).toBe(true)
    }
  })


  it('keeps whichever receive-only marker the channel already carried', () => {
    // This family marks "do not transmit" by filling the transmit frequency,
    // and CHIRP accepts both all-0xFF and all-0x00. Normalising one to the
    // other rewrites four bytes to say what they already said, which breaks
    // the round trip and puts pointless bytes on the wire. Found by an
    // adversarial review before this path ever reached a radio.
    for (const fill of [0xff, 0x00] as const) {
      const img = image()
      const mem = memOf(img)
      let slot = -1
      for (let i = 0; i < CHANNEL_COUNT; i++) {
        if (mem[channelAddr(i)] !== 0xff) { slot = i; break }
      }
      expect(slot).toBeGreaterThanOrEqual(0)

      const at = channelAddr(slot)
      mem.fill(fill, at + 0x04, at + 0x08)
      const before = mem.slice(at, at + UV82_CHANNEL.size)

      const decoded = writable.decode(img)
      expect(decoded.channels.get(slot + 1)?.txAllowed, `fill 0x${fill.toString(16)}`).toBe(false)

      const after = memOf(writable.encode(decoded, img)).slice(at, at + UV82_CHANNEL.size)
      expect(equalBytes(after, before), `fill 0x${fill.toString(16)} was rewritten`).toBe(true)
    }
  })

  it('marks a deliberately cleared slot the way the radio does', () => {
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()][0]!
    doc.channels.delete(slot)

    const mem = memOf(writable.encode(doc, img))
    expect(mem[channelAddr(slot - 1)]).toBe(0xff)
  })
})

describe('what a channel edit touches', () => {
  it('changes only that channel and its name', () => {
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()][0]!
    const ch = doc.channels.get(slot)!
    doc.channels.set(slot, { ...ch, name: 'ZZTOP' })

    const before = memOf(img)
    const after = memOf(writable.encode(doc, img))
    const changed: number[] = []
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(i)

    const owned = ownedRanges()
    for (const at of changed) {
      expect(
        owned.some(([s, e]) => at >= s && at < e),
        `byte 0x${at.toString(16)} is outside the ranges this driver owns`,
      ).toBe(true)
    }
  })

  it('never lands a change in a window CHIRP skips', () => {
    // Those two windows sit outside both owned ranges, so a diff-driven write
    // cannot reach them. This asserts the arithmetic rather than trusting it.
    const owned = ownedRanges()
    for (const [ns, ne] of NEVER_WRITE) {
      for (const [os, oe] of owned) {
        const overlaps = ns < oe && ne > os
        expect(overlaps, `0x${ns.toString(16)} overlaps an owned range`).toBe(false)
      }
    }
  })

  it('keeps both owned ranges aligned to the write block size', () => {
    // Blocks are sent as 16 bytes at a radio address; a range that started
    // mid-block would force a read-modify-write nobody has written.
    for (const [s, e] of ownedRanges()) {
      expect((s - IDENT_SIZE) % WRITE_BLOCK_SIZE, `start 0x${s.toString(16)}`).toBe(0)
      expect((e - IDENT_SIZE) % WRITE_BLOCK_SIZE, `end 0x${e.toString(16)}`).toBe(0)
    }
  })

  it('keeps every owned byte inside the main block', () => {
    for (const [s, e] of ownedRanges()) {
      expect(s).toBeGreaterThanOrEqual(IDENT_SIZE)
      expect(e).toBeLessThanOrEqual(IDENT_SIZE + MAIN_SIZE)
    }
  })
})

describe('what encode refuses', () => {
  it('refuses a codeplug for a different radio', () => {
    const img = image()
    const doc = writable.decode(img)
    expect(() => writable.encode({ ...doc, radio: 'uvk5' }, img)).toThrow(DriverError)
  })

  it('refuses an image from a different radio', () => {
    const img = image()
    expect(() => writable.encode(writable.decode(img), { ...img, radioId: 'uvk5' })).toThrow(DriverError)
  })
})

describe('the write gate', () => {
  const backup: BackupRef = { id: 'b', identHash: 'nope', createdAt: '2026-08-20T00:00:00.000Z' }
  const transport = {} as never

  it('refuses when the driver is not cleared to write', async () => {
    await expect(driver.writeImage(transport, image(), { backup })).rejects.toThrow(/not enabled|UV-82/)
  })

  it('refuses without a backup', async () => {
    await expect(writable.writeImage(transport, image(), {})).rejects.toThrow(BackupRequiredError)
  })

  it('refuses an image from a different radio before touching the port', async () => {
    await expect(
      writable.writeImage(transport, { ...image(), radioId: 'uvk5' }, { backup }),
    ).rejects.toThrow(DriverError)
  })

  it('reads the radio when no base image is supplied, so a restore has something to diff against', async () => {
    /*
     * A restore deliberately supplies no base: it expects the radio to differ
     * from the image being restored, which is the point of restoring. Refusing
     * there left no way back from a bad write. Reading the radio first keeps the
     * write to what actually differs instead of rewriting six kilobytes.
     *
     * With a transport that cannot talk, that read is what fails - which is
     * itself the proof that it was attempted rather than refused outright.
     */
    const img = image()
    const ident = {
      radioId: 'uv82' as const,
      variant: 'N822413',
      layout: 'uv82',
      raw: new Uint8Array(0),
      caps: { read: true, write: true },
      identHash: 'match',
    }
    await expect(
      writable.writeImage(transport, img, { backup: { ...backup, identHash: 'match' }, ident }),
    ).rejects.toThrow(/t\.write is not a function/)
  })
})

describe('receive-only, which is the one that matters', () => {
  it('writes the marker CHIRP recognises when a channel becomes receive-only', () => {
    /*
     * CHIRP's `_is_txinh` accepts exactly one marker: FF FF FF FF. A transmit
     * frequency of zero is read as a split with tx 0.000 MHz - transmit
     * ENABLED. Getting this wrong is how a weather or public-safety frequency
     * ends up in a radio someone can key up.
     */
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()].find((s) => doc.channels.get(s)!.txAllowed)!
    const ch = doc.channels.get(slot)!
    doc.channels.set(slot, { ...ch, txAllowed: false, txInhibitReason: 'receive only' })

    const mem = memOf(writable.encode(doc, img))
    const at = channelAddr(slot - 1)
    expect([...mem.subarray(at + 4, at + 8)]).toEqual([0xff, 0xff, 0xff, 0xff])
  })

  it('leaves an existing marker alone, in either spelling', () => {
    // Both fillings decode as inhibited, so normalising one to the other would
    // change four bytes to say what they already said and put them on the wire.
    for (const fill of [0xff, 0x00] as const) {
      const img = image()
      const mem0 = memOf(img)
      const slot = 2
      const at = channelAddr(slot - 1)
      const patched = mem0.slice()
      patched.fill(fill, at + 4, at + 8)

      const patchedImage: RadioImage = {
        ...img,
        regions: [{ ...img.regions[0]!, data: patched }],
      }
      const out = memOf(writable.encode(writable.decode(patchedImage), patchedImage))
      expect([...out.subarray(at + 4, at + 8)], `fill 0x${fill.toString(16)}`).toEqual(
        new Array(4).fill(fill),
      )
    }
  })

  it('round-trips a CHIRP-programmed receive-only channel byte for byte', () => {
    // The fixture has none, which is exactly why this patches one in.
    const img = image()
    const at = channelAddr(1)
    const patched = memOf(img).slice()
    patched.fill(0xff, at + 4, at + 8)
    const patchedImage: RadioImage = { ...img, regions: [{ ...img.regions[0]!, data: patched }] }

    const out = memOf(writable.encode(writable.decode(patchedImage), patchedImage))
    expect(equalBytes(out, patched)).toBe(true)
  })
})

describe('radios this build will not write', () => {
  it('refuses the tri-power HP, which has a power level this build cannot express', () => {
    // The HP shares the plain UV-82's magic and three power levels are indexed
    // by the same two-bit field. Modelling two would rewrite a Low channel as
    // High, promoting a channel the user never touched to 8 W.
    const schema = writable.schema
    expect(schema.capabilities.write).toBe(true)
    expect(schema.aliases).toContain('UV-82HP')
  })
})
