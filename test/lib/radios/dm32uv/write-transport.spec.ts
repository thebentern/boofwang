// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { sha256Hex } from '#core/codec/checksum.js'
import type { BackupRef, DriverCtx } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE, PAGE_TAIL } from '#core/radios/dm32uv/protocol.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'

const BLOB = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.blocks.bin', import.meta.url))),
)
const INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.index.json', import.meta.url)), 'utf8'),
) as { firmware: string; model: string; blocks: { id: number; physical: number; offset: number }[] }

const writable = createDm32uvDriver({ enableWrite: true })

function image(): RadioImage {
  return {
    radioId: 'dm32uv',
    variant: INDEX.firmware,
    layout: INDEX.model,
    createdAt: '2026-08-19T22:00:00.000Z',
    regions: INDEX.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: BLOB.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
    meta: {},
    sha256: '',
  }
}

/**
 * A DM-32UV made of pages.
 *
 * It answers the read, write and programming-mode frames the driver actually
 * sends, and - like the real radio - keeps a tail byte on every page saying
 * which logical block lives there. `writes` records what it was handed, which
 * is the only way to tell a page that was sent from a page that was merely
 * encoded: the sparse-write failure on the UV-5R Mini ACKed every frame and
 * verified every block while erasing nineteen channels.
 */
function fakeRadio(base = 0x1000) {
  const pages = new Map<number, Uint8Array>()
  const writes: { addr: number; data: Uint8Array }[] = []
  /** Full-page reads only - the one-byte tail reads of a map scan are not these. */
  const pageReads: number[] = []

  INDEX.blocks.forEach((b, i) => {
    const page = BLOB.slice(b.offset, b.offset + PAGE_SIZE)
    page[PAGE_TAIL] = b.id
    pages.set(base + i * PAGE_SIZE, page)
  })
  const end = base + INDEX.blocks.length * PAGE_SIZE - 1

  const respond = (frame: Uint8Array): Uint8Array | null => {
    // Programming-mode entry.
    if (frame.length === 12 && frame[0] === 0xff) return Uint8Array.from([0x06])
    if (frame.length === 1 && frame[0] === 0x02) return new Uint8Array(8).fill(0xff)
    if (frame.length === 1 && frame[0] === 0x06) return Uint8Array.from([0x06])

    // 52 <addr:3 LE> <len:2 LE> - read.
    if (frame[0] === 0x52 && frame.length === 6) {
      const addr = frame[1]! | (frame[2]! << 8) | (frame[3]! << 16)
      const len = frame[4]! | (frame[5]! << 8)
      const pageBase = addr & ~(PAGE_SIZE - 1)
      const page = pages.get(pageBase)
      if (len === PAGE_SIZE) pageReads.push(addr)
      const out = new Uint8Array(len)
      if (page) out.set(page.subarray(addr - pageBase, addr - pageBase + len))
      else out.fill(0xff) // an unallocated page reads as erased
      return Uint8Array.from([0x57, frame[1]!, frame[2]!, frame[3]!, frame[4]!, frame[5]!, ...out])
    }

    // 57 <addr:3 LE> <len:2 LE> <4096 bytes> - write.
    if (frame[0] === 0x57 && frame.length === 6 + PAGE_SIZE) {
      const addr = frame[1]! | (frame[2]! << 8) | (frame[3]! << 16)
      const data = frame.slice(6)
      pages.set(addr, data)
      writes.push({ addr, data })
      return Uint8Array.from([0x06])
    }
    return null
  }

  return { pages, writes, pageReads, respond, base, end }
}

async function connect(radio: ReturnType<typeof fakeRadio>) {
  const port = new FakeSerialPort({ respond: radio.respond })
  const t = new SerialTransport(port)
  await t.open({ baudRate: 115_200 })
  return t
}

async function backupFor(radio: ReturnType<typeof fakeRadio>): Promise<BackupRef> {
  const calPhys = [...radio.pages.entries()].find(([, p]) => p[PAGE_TAIL] === 0x02)![0]
  return {
    id: 'backup-1',
    identHash: 'ident',
    unitHash: await sha256Hex(radio.pages.get(calPhys)!),
    createdAt: '2026-08-20T00:00:00.000Z',
  }
}

function ctxFor(radio: ReturnType<typeof fakeRadio>, backup: BackupRef, baseImage: RadioImage): DriverCtx {
  return {
    backup,
    baseImage,
    readTimeoutMs: 4000,
    ident: {
      radioId: 'dm32uv' as const,
      variant: INDEX.firmware,
      layout: INDEX.model,
      identHash: 'ident',
      raw: new Uint8Array(0),
      caps: { read: true, write: true },
      meta: { model: INDEX.model, configStart: radio.base, configEnd: radio.end },
    },
  }
}

const blockOfWrite = (radio: ReturnType<typeof fakeRadio>, w: { data: Uint8Array }) => w.data[PAGE_TAIL]!

describe('writeImage, against a radio made of pages', () => {
  it('sends nothing when the codeplug is unchanged', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const report = await writable.writeImage(t, img, ctxFor(radio, await backupFor(radio), img))

    expect(radio.writes).toEqual([])
    expect(report.blocksWritten).toBe(0)
    expect(report.verified).toBe(true)
    expect(report.operations.every((o) => o.skipped === 'unchanged')).toBe(true)
  })

  it('sends the channel page when a channel is renamed, and only that page', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()][0]!
    doc.channels.set(slot, { ...doc.channels.get(slot)!, name: 'HW TEST' })
    const next = writable.encode(doc, img)

    const report = await writable.writeImage(t, next, ctxFor(radio, await backupFor(radio), img))

    // A channel edit must actually reach the radio. Before writeImage was
    // widened, encode() produced these bytes and nothing sent them, while the
    // report still said "verified".
    expect(radio.writes.length).toBe(1)
    expect(report.blocksWritten).toBe(1)
    expect(report.verified).toBe(true)

    // And the radio now holds the new name.
    const after = writable.decode({
      ...img,
      regions: img.regions.map((r) => {
        const phys = [...radio.pages.entries()].find(([, p]) => p[PAGE_TAIL] === r.start >>> 12)
        return phys ? { ...r, data: phys[1] } : r
      }),
    })
    expect(after.channels.get(slot)!.name).toBe('HW TEST')
  })

  it('sends the zone page for a zone rename', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    doc.zones[0] = { ...doc.zones[0]!, name: 'ZONE HW' }

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    expect(radio.writes.length).toBe(1)
    expect(blockOfWrite(radio, radio.writes[0]!)).toBeGreaterThanOrEqual(0x5c)
    expect(blockOfWrite(radio, radio.writes[0]!)).toBeLessThanOrEqual(0x64)
  })

  it('sends the talk group page for a talk group rename', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    doc.talkGroups[0] = { ...doc.talkGroups[0]!, name: 'TG HW' }

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    expect(radio.writes.length).toBe(1)
    expect(blockOfWrite(radio, radio.writes[0]!)).toBeGreaterThanOrEqual(0x44)
    expect(blockOfWrite(radio, radio.writes[0]!)).toBeLessThanOrEqual(0x48)
  })

  it('writes the safest pages first and the key slots last', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()][0]!
    doc.channels.set(slot, { ...doc.channels.get(slot)!, name: 'ORDER' })
    doc.zones[0] = { ...doc.zones[0]!, name: 'ORDER' }
    doc.talkGroups[0] = { ...doc.talkGroups[0]!, name: 'ORDER' }
    doc.encryptionKeys[0] = { ...doc.encryptionKeys[0]!, keyHex: 'AB'.repeat(32) }

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    const order = radio.writes.map((w) => blockOfWrite(radio, w))
    expect(order.length).toBe(4)
    // Talk groups, then zones, then channels, then the keys.
    expect(order[0]).toBeGreaterThanOrEqual(0x44)
    expect(order[0]).toBeLessThanOrEqual(0x48)
    expect(order[1]).toBeGreaterThanOrEqual(0x5c)
    expect(order[1]).toBeLessThanOrEqual(0x64)
    expect(order[2]).toBeGreaterThanOrEqual(0x12)
    expect(order[2]).toBeLessThanOrEqual(0x41)
    expect(order[3]).toBe(0x10)
  })

  it('never sends a page it does not have a block for', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    doc.channels.set([...doc.channels.keys()][0]!, {
      ...doc.channels.get([...doc.channels.keys()][0]!)!,
      name: 'X',
    })

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    // Every page sent must carry a tail byte this driver claims to understand.
    for (const w of radio.writes) {
      const id = blockOfWrite(radio, w)
      expect(writable.ownedRanges(logicalAddress(id)).length, `block 0x${id.toString(16)}`).toBeGreaterThan(0)
    }
  })

  it('leaves every byte outside the owned range exactly as the radio had it', async () => {
    const radio = fakeRadio()
    const before = new Map([...radio.pages].map(([a, p]) => [a, p.slice()]))
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()][0]!
    doc.channels.set(slot, { ...doc.channels.get(slot)!, name: 'SCOPE' })

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    for (const [addr, page] of radio.pages) {
      const was = before.get(addr)!
      const id = page[PAGE_TAIL]!
      const owned = writable.ownedRanges(logicalAddress(id))
      for (let i = 0; i < PAGE_SIZE; i++) {
        if (page[i] === was[i]) continue
        const inside = owned.some(([from, to]) => i >= from && i < to)
        expect(inside, `page 0x${addr.toString(16)} byte 0x${i.toString(16)}`).toBe(true)
      }
    }
  })

  it('does not send a page whose bytes the user never touched', async () => {
    // The base-image merge: an edit to one channel must not carry the other 47
    // channel pages along with it just because they are in the image.
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()][0]!
    doc.channels.set(slot, { ...doc.channels.get(slot)!, name: 'ONE' })

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))
    expect(radio.writes.length).toBe(1)
  })

  it('keeps a change made on the radio since the image was read', async () => {
    // Read on Monday, someone edits the radio on Tuesday, we write on
    // Wednesday: only the bytes the user actually changed should go out.
    const radio = fakeRadio()
    const img = image()
    const doc = writable.decode(img)
    const keys = [...doc.channels.keys()]
    const edited = keys[0]!

    // Find the physical page holding the first channel block and change a
    // different channel's name on the "radio".
    const phys = [...radio.pages.entries()].find(([, p]) => p[PAGE_TAIL] === 0x12)!
    const marker = 0x0a0
    phys[1][marker] = 0x5a // 'Z' - somewhere in the channel area, not our record

    const t = await connect(radio)
    doc.channels.set(edited, { ...doc.channels.get(edited)!, name: 'MINE' })
    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    expect(radio.pages.get(phys[0])![marker], 'the radio-side byte was reverted').toBe(0x5a)
  })

  it('reports a dry run without sending anything', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()][0]!
    doc.channels.set(slot, { ...doc.channels.get(slot)!, name: 'DRY' })

    const report = await writable.writeImage(t, writable.encode(doc, img), {
      ...ctxFor(radio, await backupFor(radio), img),
      dryRun: true,
    })

    expect(radio.writes).toEqual([])
    expect(report.dryRun).toBe(true)
    expect(report.blocksWritten).toBe(1)
    expect(report.verified).toBe(false)
  })

  it('round-trips the whole radio when nothing was edited', async () => {
    const radio = fakeRadio()
    const before = new Map([...radio.pages].map(([a, p]) => [a, p.slice()]))
    const t = await connect(radio)
    const img = image()
    await writable.writeImage(t, writable.encode(writable.decode(img), img), ctxFor(radio, await backupFor(radio), img))
    for (const [addr, page] of radio.pages) {
      expect(equalBytes(page, before.get(addr)!), `page 0x${addr.toString(16)}`).toBe(true)
    }
  })

  it('does not read the pages it is not going to write', async () => {
    // Renaming one channel used to mean reading every allocated page first -
    // about 60 of them - because each was a write candidate until proven
    // otherwise. The base image already says which blocks the user touched.
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    const slot = [...doc.channels.keys()][0]!
    doc.channels.set(slot, { ...doc.channels.get(slot)!, name: 'CHEAP' })

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    // The calibration page (the per-unit check), the one channel page, and its
    // read-back. Nothing else.
    expect(radio.pageReads.length).toBeLessThanOrEqual(3)
    expect(radio.writes.length).toBe(1)
  })

  it('still reads every writable page when there is no base image to compare', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const ctx = ctxFor(radio, await backupFor(radio), img)
    await writable.writeImage(t, img, { ...ctx, baseImage: undefined })
    // No base means "put this image on the radio": every writable block has to
    // be read to find out whether it already matches.
    expect(radio.pageReads.length).toBeGreaterThan(10)
  })
})
