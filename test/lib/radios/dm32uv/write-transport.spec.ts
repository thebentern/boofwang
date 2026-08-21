// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { sha256Hex } from '#core/codec/checksum.js'
import type { BackupRef, DriverCtx, IdentifyResult } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE, PAGE_TAIL } from '#core/radios/dm32uv/protocol.js'
import { KEY_AREA, DM32_CONTACT, contactSlot  } from '#core/radios/dm32uv/layout.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'

const BLOB = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.blocks.bin', import.meta.url))),
)
const INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.index.json', import.meta.url)), 'utf8'),
) as { firmware: string; model: string; blocks: { id: number; physical: number; offset: number }[] }

const writable = createDm32uvDriver({ enableWrite: true })

const CONTACTS_BASE = 0x278000
const CONTACT_COUNT = 60
const CONTACT_PAGES = 2

function image(): RadioImage {
  return {
    radioId: 'dm32uv',
    variant: INDEX.firmware,
    layout: INDEX.model,
    createdAt: '2026-08-19T22:00:00.000Z',
    regions: [
      ...INDEX.blocks.map((b) => ({
        start: logicalAddress(b.id),
        data: BLOB.slice(b.offset, b.offset + PAGE_SIZE),
        readOnly: b.id === 0x02,
        label: `block 0x${b.id.toString(16)}`,
      })),
      ...Array.from({ length: CONTACT_PAGES }, (_, i) => {
        const data = new Uint8Array(PAGE_SIZE).fill(0xff)
        if (i === 0) data.set([CONTACT_COUNT, 0, 0, 0], 0)
        for (let n = 0; n < CONTACT_COUNT; n++) {
          const slot = contactSlot(n)
          if (slot.page !== i) continue
          DM32_CONTACT.write(data, slot.offset, {
            name: `Contact ${n + 1}`, dmrId: 3_105_000 + n, callsign: '', city: '', province: '', country: '', remark: '',
          })
        }
        return { start: CONTACTS_BASE + i * PAGE_SIZE, data, label: `contacts page ${i + 1}` }
      }),
    ],
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
  /** One-byte tail probes, which is what a page-map scan is made of. */
  let tailReads = 0

  INDEX.blocks.forEach((b, i) => {
    const page = BLOB.slice(b.offset, b.offset + PAGE_SIZE)
    page[PAGE_TAIL] = b.id
    pages.set(base + i * PAGE_SIZE, page)
  })
  const end = base + INDEX.blocks.length * PAGE_SIZE - 1

  // The DMR address book: a raw region at a real address, no logical id in the
  // page, so its 0xFFF byte is ordinary data rather than a tag.
  for (let i = 0; i < CONTACT_PAGES; i++) {
    const page = new Uint8Array(PAGE_SIZE).fill(0xff)
    if (i === 0) page.set([CONTACT_COUNT, 0, 0, 0], 0)
    for (let n = 0; n < CONTACT_COUNT; n++) {
      const slot = contactSlot(n)
      if (slot.page !== i) continue
      DM32_CONTACT.write(page, slot.offset, {
        name: `Contact ${n + 1}`, dmrId: 3_105_000 + n, callsign: '', city: '', province: '', country: '', remark: '',
      })
    }
    pages.set(CONTACTS_BASE + i * PAGE_SIZE, page)
  }

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
      if (len === 1) tailReads++
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

  return { pages, writes, pageReads, respond, base, end, get tailReads() { return tailReads } }
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

  it('sends the talk group page AND its index for a rename', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    doc.talkGroups[0] = { ...doc.talkGroups[0]!, name: 'TG HW' }

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    // Two pages: the bank, and the index that orders it by name. A rename can
    // change that order, so a stale index would list the groups wrongly.
    const blocks = radio.writes.map((w) => blockOfWrite(radio, w))
    expect(blocks).toHaveLength(2)
    expect(blocks).toContain(0x0b)
    expect(blocks.some((b) => b >= 0x44 && b <= 0x48)).toBe(true)
    // The index goes out immediately after the bank it describes.
    expect(blocks.indexOf(0x0b)).toBeGreaterThan(blocks.findIndex((b) => b >= 0x44 && b <= 0x48))
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

  it('sends a contacts page when a contact is edited, and only that page', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    expect(doc.contacts).toHaveLength(CONTACT_COUNT)
    // Entry 50 is on the second page: 44 per page, and they do not straddle.
    doc.contacts[50] = { ...doc.contacts[50]!, name: 'EDITED' }

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    expect(radio.writes).toHaveLength(1)
    expect(radio.writes[0]!.addr).toBe(CONTACTS_BASE + PAGE_SIZE)
    expect(writable.decode({
      ...img,
      regions: img.regions.map((r) => (radio.pages.has(r.start) ? { ...r, data: radio.pages.get(r.start)! } : r)),
    }).contacts[50]!.name).toBe('EDITED')
  })

  it('does not rescan the page map for a raw region', async () => {
    // The address book cannot relocate - no translation layer touches it - and
    // a rescan is 200 one-byte reads. On a radio with 50,000 contacts that
    // would be a rescan per page.
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    doc.contacts[0] = { ...doc.contacts[0]!, name: 'ONE' }

    const before = radio.tailReads
    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))
    // One scan before the write, and none after it for the contacts page.
    expect(radio.writes).toHaveLength(1)
    expect(radio.tailReads - before).toBeLessThanOrEqual(INDEX.blocks.length + 1)
  })

  it('leaves the twelve unexplained bytes and the page tail alone', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const before = new Map([...radio.pages].map(([a, p]) => [a, p.slice()]))
    const doc = writable.decode(img)
    doc.contacts.splice(20)

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    const page0 = radio.pages.get(CONTACTS_BASE)!
    const was = before.get(CONTACTS_BASE)!
    expect(equalBytes(page0.subarray(4, 0x10), was.subarray(4, 0x10)), 'the twelve bytes after the count').toBe(true)
    expect(page0[PAGE_SIZE - 1], 'the last byte, which here is data').toBe(was[PAGE_SIZE - 1])
  })

  it('restores the address book from a backup', async () => {
    // The reason contacts could not be written before: a restore had no way to
    // put them back. It does now.
    const radio = fakeRadio()
    const pristine = new Map([...radio.pages].map(([a, p]) => [a, p.slice()]))
    const img = image()

    const doc = writable.decode(img)
    doc.contacts[3] = { ...doc.contacts[3]!, name: 'CLOBBERED' }
    const t1 = await connect(radio)
    await writable.writeImage(t1, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))
    expect(radio.pages.get(CONTACTS_BASE)).not.toEqual(pristine.get(CONTACTS_BASE))

    // Now restore the original image, the way the restore page does: no base.
    const t2 = await connect(radio)
    const ctx = ctxFor(radio, await backupFor(radio), img)
    await writable.writeImage(t2, img, { ...ctx, baseImage: undefined })

    for (const [addr, page] of radio.pages) {
      expect(equalBytes(page, pristine.get(addr)!), `page 0x${addr.toString(16)}`).toBe(true)
    }
  })

})

/**
 * `readImage` against the same fake radio.
 *
 * The address book being tagged read-only lived here, and every fixture that
 * could have caught it built its contact pages by hand - a shape the real read
 * path never produces. So these drive the read path itself.
 */
describe('readImage, and the shape it hands the rest of the app', () => {
  const identFor = (radio: ReturnType<typeof fakeRadio>, contacts = true): IdentifyResult => ({
    radioId: 'dm32uv',
    variant: INDEX.firmware,
    layout: INDEX.model,
    identHash: 'ident',
    raw: new Uint8Array(0),
    caps: { read: true, write: true },
    meta: {
      model: INDEX.model,
      configStart: radio.base,
      configEnd: radio.end,
      ...(contacts ? { contactsStart: CONTACTS_BASE, contactsEnd: CONTACTS_BASE + 0x3b_cfff } : {}),
    },
  })

  it('brings the address book back writable', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = await writable.readImage(t, identFor(radio), {})

    const pages = img.regions.filter((r) => r.start >= CONTACTS_BASE)
    expect(pages.length).toBeGreaterThan(0)
    for (const p of pages) {
      expect(p.readOnly, 'a contacts page came back read-only and cannot be written').toBeFalsy()
    }
    expect(writable.decode(img).contacts).toHaveLength(CONTACT_COUNT)
  })

  it('reads one page more than the contacts fill, so one can be added', async () => {
    // The encoder can only write pages the reader brought back. 60 contacts fit
    // in two pages exactly at 44 per page, so without the spare there is
    // nowhere to put a 61st.
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = await writable.readImage(t, identFor(radio), {})

    const used = Math.floor((CONTACT_COUNT - 1) / 44) + 1
    expect(img.regions.filter((r) => r.start >= CONTACTS_BASE)).toHaveLength(used + 1)

    const doc = writable.decode(img)
    doc.contacts.push({
      id: 'c-new', name: 'ADDED', dmrId: 3_105_999,
      callsign: '', city: '', province: '', country: '', remark: '',
    })
    expect(() => writable.encode(doc, img)).not.toThrow()
    expect(writable.decode(writable.encode(doc, img)).contacts.at(-1)!.name).toBe('ADDED')
  })

  it('reads a page even when the address book is empty', async () => {
    // Otherwise there is no page at all and every added contact is dropped in
    // silence - which is what a radio fresh out of the box looks like.
    const radio = fakeRadio()
    radio.pages.get(CONTACTS_BASE)!.set([0, 0, 0, 0], 0)
    const t = await connect(radio)
    const img = await writable.readImage(t, identFor(radio), {})

    expect(img.regions.filter((r) => r.start >= CONTACTS_BASE).length).toBeGreaterThanOrEqual(1)
    const doc = writable.decode(img)
    expect(doc.contacts).toEqual([])
    doc.contacts.push({
      id: 'c1', name: 'FIRST', dmrId: 1234,
      callsign: '', city: '', province: '', country: '', remark: '',
    })
    expect(writable.decode(writable.encode(doc, img)).contacts.map((c) => c.name)).toEqual(['FIRST'])
  })

  it('reads no contacts region when the radio reports none', async () => {
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = await writable.readImage(t, identFor(radio, false), {})
    expect(img.regions.filter((r) => r.start >= CONTACTS_BASE)).toEqual([])
    expect(writable.decode(img).contacts).toEqual([])
  })

  it('sends everything a block owns, not just the part with a special merge', async () => {
    // Block 0x10 carries the encryption key slots AND the eight emergency
    // system names, and the key slots get a merge of their own so that half an
    // old key and half a new one is impossible. That special case used to be
    // the ONLY merge applied to the page, so an emergency rename was encoded
    // into the image and then dropped on the way out - encoded, ACKed, read
    // back, and reported verified, with the name unchanged on the radio.
    //
    // Hardware caught this, not the suite. This is the test that should have.
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    expect(doc.emergency.length, 'the fixture has no emergency systems').toBeGreaterThan(0)
    doc.emergency[0] = { ...doc.emergency[0]!, name: 'SENT' }

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    expect(radio.writes).toHaveLength(1)
    expect(radio.writes[0]!.data[PAGE_TAIL], 'the page written').toBe(0x10)
    const onRadio = radio.pages.get(radio.writes[0]!.addr)!
    expect(
      writable.decode({ ...img, regions: img.regions.map((r) => (r.start === logicalAddress(0x10) ? { ...r, data: onRadio } : r)) })
        .emergency[0]!.name,
      'the emergency name never left the encoder',
    ).toBe('SENT')
  })

  it('sends a whole key slot when only part of it was edited', async () => {
    // The discriminator between the two merges, and the reason the key slots
    // have one of their own.
    //
    // Someone reads on Monday, changes a key on the radio's own keypad on
    // Tuesday, then opens Monday's codeplug and edits one byte of that key.
    // A byte-wise merge sends that one byte onto Tuesday's key and leaves the
    // radio holding half of each - a key that decrypts nothing, and unlike a
    // channel you cannot look at the radio and see it is wrong.
    const radio = fakeRadio()
    const img = image()
    const doc = writable.decode(img)
    const slot = doc.encryptionKeys[0]!
    const bytes = slot.keyHex.length / 2

    // Tuesday: a different key on the radio than in the image.
    const onRadioBefore = [...radio.pages.entries()].find(([, p]) => p[PAGE_TAIL] === 0x10)!
    const keyAt = KEY_AREA[0] + 0x0c
    onRadioBefore[1].fill(0x11, keyAt, keyAt + bytes)

    // Wednesday: edit one byte of the key the image holds.
    const edited = 'FF' + slot.keyHex.slice(2)
    doc.encryptionKeys[0] = { ...slot, keyHex: edited }

    const t = await connect(radio)
    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    const after = radio.pages.get(radio.writes[0]!.addr)!
    const back = writable.decode({
      ...img,
      regions: img.regions.map((r) => (r.start === logicalAddress(0x10) ? { ...r, data: after } : r)),
    })
    expect(back.encryptionKeys[0]!.keyHex.toUpperCase(), 'the radio holds half of each key').toBe(
      edited.toUpperCase(),
    )
    expect(
      [...after.subarray(keyAt, keyAt + bytes)].some((b) => b === 0x11),
      'a byte of the key that was on the radio survived into the merged slot',
    ).toBe(false)
  })

  it('still merges the key slots a whole slot at a time', async () => {
    // The reason block 0x10 has a merge of its own: byte granularity here would
    // let half an old key and half a new one reach the radio, and unlike a
    // channel you cannot look at the radio and see that it is wrong.
    const radio = fakeRadio()
    const t = await connect(radio)
    const img = image()
    const doc = writable.decode(img)
    const slot = doc.encryptionKeys[0]!
    doc.encryptionKeys[0] = { ...slot, keyHex: 'AB'.repeat(slot.keyHex.length / 2) }

    await writable.writeImage(t, writable.encode(doc, img), ctxFor(radio, await backupFor(radio), img))

    const onRadio = radio.pages.get(radio.writes[0]!.addr)!
    const back = writable.decode({
      ...img,
      regions: img.regions.map((r) => (r.start === logicalAddress(0x10) ? { ...r, data: onRadio } : r)),
    })
    expect(back.encryptionKeys[0]!.keyHex.toUpperCase()).toBe('AB'.repeat(slot.keyHex.length / 2))
    // And the other slots are untouched.
    expect(back.encryptionKeys.slice(1)).toEqual(doc.encryptionKeys.slice(1))
  })
})
