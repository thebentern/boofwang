// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { diffImages } from '#core/radio/diff.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver, decodeTalkGroupIndex } from '#core/radios/dm32uv/driver.js'
import { decodeTxContact, encodeTxContact, txContactSlot,
  CONTACT_REGION_HEADER,
  CONTACT_SIZE,
  DM32_CONTACT,
  DM32_KEY_FUNCTIONS,
  DM32_RADIOID,
  RADIOID_BLOCK,
  RADIOID_HEADER,
  RADIOID_SIZE,
  RXGROUP_BLOCK,
  RXGROUP_HEADER,
  SCANLIST_BLOCK,
  SCANLIST_HEADER,
  SCANLIST_SIZE,
  SETTINGS_BLOCK,
  ZONE_BLOCK_FIRST,
  ZONE_HEADER,
  ZONE_SIZE,
  contactSlot } from '#core/radios/dm32uv/layout.js'
import { contactPages, contactsBase, logicalAddress } from '#core/radios/dm32uv/image.js'
import { DM32UV_SETTINGS_GROUPS as SCHEMA_SETTINGS } from '#core/radios/dm32uv/schema.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'

const BLOB = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.blocks.bin', import.meta.url))),
)
const INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.index.json', import.meta.url)), 'utf8'),
) as { firmware: string; model: string; blocks: { id: number; offset: number }[] }

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

const d = createDm32uvDriver({ enableWrite: true })
const page = (img: RadioImage, id: number) => img.regions.find((r) => r.start === logicalAddress(id))!.data

describe('scan lists', () => {
  it('decodes this radio’s two lists with their channels', () => {
    const cp = d.decode(image())
    expect(cp.scanLists.map((s) => s.name)).toEqual(['Scan List 1', 'Scan List 2'])
    expect(cp.scanLists[1]!.channels).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('stops at the count, not at the first blank record', () => {
    // Records 3-7 are initialised blank templates, not zeros. A reader that
    // scanned for emptiness would agree here by luck; one that trusted a 16-bit
    // count would report 21,250 lists, because 0x001 is already the 'S' of
    // "Scan List 1".
    const data = page(image(), SCANLIST_BLOCK)
    expect(data[0]).toBe(2)
    expect(String.fromCharCode(data[SCANLIST_HEADER]!)).toBe('S')
  })

  it('round-trips a renamed list and keeps its channels', () => {
    const img = image()
    const doc = d.decode(img)
    const before = doc.scanLists[0]!.channels
    doc.scanLists[0] = { ...doc.scanLists[0]!, name: 'RENAMED' }
    const back = d.decode(d.encode(doc, img)).scanLists[0]!
    expect(back.name).toBe('RENAMED')
    expect(back.channels).toEqual(before)
  })

  it('reads the members from +0x18, which is the only reading that fits', () => {
    // The reference reads them from +0x1A with fifteen slots and calls
    // +0x18-0x19 an opaque word. This radio's first list has a count of 16, and
    // fifteen slots cannot hold sixteen members - so that reading is
    // arithmetically impossible here whatever the vendor capture shows.
    const data = page(image(), SCANLIST_BLOCK)
    const rec = SCANLIST_HEADER
    expect(data[rec + 0x0b], 'the count this all turns on').toBe(16)

    const word = (at: number) => data[at]! | (data[at + 1]! << 8)
    const from18 = Array.from({ length: 16 }, (_, i) => word(rec + 0x18 + 2 * i))
    const from1a = Array.from({ length: 15 }, (_, i) => word(rec + 0x1a + 2 * i))
    expect(from18.filter((v) => v !== 0 && v !== 0xffff)).toHaveLength(16)
    expect(from1a.filter((v) => v !== 0 && v !== 0xffff)).toHaveLength(15)

    // And the second record is off by exactly one the same way.
    const rec2 = SCANLIST_HEADER + SCANLIST_SIZE
    expect(data[rec2 + 0x0b]).toBe(9)
    const second18 = Array.from({ length: 16 }, (_, i) => word(rec2 + 0x18 + 2 * i))
    expect(second18.filter((v) => v !== 0 && v !== 0xffff)).toHaveLength(9)
  })

  it('writes a new member list and the count that bounds it', () => {
    const img = image()
    const doc = d.decode(img)
    doc.scanLists[1] = { ...doc.scanLists[1]!, channels: [23, 24, 25] }
    const out = d.encode(doc, img)
    expect(d.decode(out).scanLists[1]!.channels).toEqual([23, 24, 25])

    const rec = SCANLIST_HEADER + SCANLIST_SIZE
    const data = page(out, SCANLIST_BLOCK)
    expect(data[rec + 0x0b], 'the count').toBe(3)
    expect(data[rec + 0x18]! | (data[rec + 0x19]! << 8), 'the first member sits at +0x18').toBe(23)
  })

  it('leaves the bytes before the members alone', () => {
    // 0x15-0x17 carry data on hardware and the reference marks them preserve.
    const img = image()
    const doc = d.decode(img)
    doc.scanLists[0] = { ...doc.scanLists[0]!, channels: [1] }
    const out = d.encode(doc, img)
    const from = SCANLIST_HEADER + 0x0c
    const to = SCANLIST_HEADER + 0x18
    expect(equalBytes(page(out, SCANLIST_BLOCK).subarray(from, to), page(img, SCANLIST_BLOCK).subarray(from, to))).toBe(true)
  })

  it('drops a member the channel bank cannot resolve', () => {
    const img = image()
    const doc = d.decode(img)
    doc.scanLists[0] = { ...doc.scanLists[0]!, channels: [1, 9999, 2] }
    expect(d.decode(d.encode(doc, img)).scanLists[0]!.channels).toEqual([1, 2])
  })

  it('caps a list at the sixteen slots a record holds', () => {
    const img = image()
    const doc = d.decode(img)
    doc.scanLists[0] = { ...doc.scanLists[0]!, channels: [...Array(40).keys()].map((n) => n + 1) }
    expect(d.decode(d.encode(doc, img)).scanLists[0]!.channels).toHaveLength(16)
  })

  it('adds and removes lists by moving the count byte', () => {
    const img = image()
    const doc = d.decode(img)
    doc.scanLists.push({ id: 'scan-3', name: 'THIRD', channels: [1, 2] })
    const added = d.encode(doc, img)
    expect(page(added, SCANLIST_BLOCK)[0]).toBe(3)
    expect(d.decode(added).scanLists[2]!.name).toBe('THIRD')

    const doc2 = d.decode(img)
    doc2.scanLists.pop()
    const removed = d.encode(doc2, img)
    expect(page(removed, SCANLIST_BLOCK)[0]).toBe(1)
    expect(d.decode(removed).scanLists).toHaveLength(1)
  })
})

describe('RX groups', () => {
  it('reads the first four bytes as a bitmask, not a count', () => {
    // 0x1F read as an integer says 31 groups. It means bits 0-4: five.
    const data = page(image(), RXGROUP_BLOCK)
    expect(data[0]).toBe(0x1f)
    expect(d.decode(image()).rxGroups).toHaveLength(5)
  })

  it('decodes members as raw DMR numbers', () => {
    const groups = d.decode(image()).rxGroups
    expect(groups[0]!.name).toBe('TAC')
    expect(groups[1]!.name).toBe('AR')
    expect(groups[1]!.dmrIds).toEqual([3105, 310501, 3100])
  })

  it('round-trips a renamed group with its members', () => {
    const img = image()
    const doc = d.decode(img)
    doc.rxGroups[1] = { ...doc.rxGroups[1]!, name: 'ARK' }
    const back = d.decode(d.encode(doc, img)).rxGroups[1]!
    expect(back.name).toBe('ARK')
    expect(back.dmrIds).toEqual([3105, 310501, 3100])
  })

  it('writes members and keeps the bitmask in step', () => {
    const img = image()
    const doc = d.decode(img)
    doc.rxGroups[0] = { ...doc.rxGroups[0]!, dmrIds: [1, 2, 3] }
    doc.rxGroups.pop()
    const out = d.encode(doc, img)
    expect(page(out, RXGROUP_BLOCK)[0]).toBe(0x0f) // four groups, bits 0-3
    expect(d.decode(out).rxGroups).toHaveLength(4)
    expect(d.decode(out).rxGroups[0]!.dmrIds).toEqual([1, 2, 3])
  })

  it('leaves the header bytes between the mask and the records alone', () => {
    const img = image()
    const doc = d.decode(img)
    doc.rxGroups[0] = { ...doc.rxGroups[0]!, name: 'X' }
    const out = d.encode(doc, img)
    expect(equalBytes(page(out, RXGROUP_BLOCK).subarray(4, RXGROUP_HEADER), page(img, RXGROUP_BLOCK).subarray(4, RXGROUP_HEADER))).toBe(true)
  })
})

describe('radio IDs', () => {
  it('decodes the ID as 24-bit little endian with its name', () => {
    const ids = d.decode(image()).radioIds
    expect(ids).toHaveLength(1)
    expect(ids[0]!.name).toBe('FERN')
    expect(ids[0]!.dmrId).toBe(103)
  })

  it('round-trips a changed ID and name', () => {
    const img = image()
    const doc = d.decode(img)
    doc.radioIds[0] = { ...doc.radioIds[0]!, name: 'W1AW', dmrId: 3_105_001 }
    const back = d.decode(d.encode(doc, img)).radioIds[0]!
    expect(back.name).toBe('W1AW')
    expect(back.dmrId).toBe(3_105_001)
  })

  it('refuses an ID too large for the 24 bits the radio stores', () => {
    const img = image()
    const doc = d.decode(img)
    doc.radioIds[0] = { ...doc.radioIds[0]!, dmrId: 20_000_000 }
    expect(() => d.encode(doc, img)).toThrow(/24 bits/)
  })

  it('adds a second ID and moves the count', () => {
    const img = image()
    const doc = d.decode(img)
    doc.radioIds.push({ id: 'rid-2', name: 'SECOND', dmrId: 3_105_002 })
    const out = d.encode(doc, img)
    expect(page(out, RADIOID_BLOCK)[0]).toBe(2)
    const back = d.decode(out).radioIds
    expect(back).toHaveLength(2)
    expect(back[1]!.dmrId).toBe(3_105_002)
    // The second record sits one stride along, after the 16-byte header.
    expect(page(out, RADIOID_BLOCK)[RADIOID_HEADER + RADIOID_SIZE]).toBe(3_105_002 & 0xff)
  })

  it('leaves the fifteen unexplained header bytes alone', () => {
    const img = image()
    const doc = d.decode(img)
    doc.radioIds[0] = { ...doc.radioIds[0]!, name: 'X' }
    const out = d.encode(doc, img)
    expect(equalBytes(page(out, RADIOID_BLOCK).subarray(1, RADIOID_HEADER), page(img, RADIOID_BLOCK).subarray(1, RADIOID_HEADER))).toBe(true)
  })
})

describe('zone membership', () => {
  it('decodes every entry to a channel that exists', () => {
    const cp = d.decode(image())
    const numbers = new Set([...cp.channels.keys()])
    for (const zone of cp.zones) {
      for (const c of zone.channels) expect(numbers.has(c), `zone ${zone.name} -> channel ${c}`).toBe(true)
    }
    expect(cp.zones.map((z) => z.channels.length)).toEqual([14, 22, 5, 4])
  })

  it('writes a new membership list and the count that bounds it', () => {
    const img = image()
    const doc = d.decode(img)
    doc.zones[0] = { ...doc.zones[0]!, channels: [1, 2, 3] }
    const out = d.encode(doc, img)
    expect(d.decode(out).zones[0]!.channels).toEqual([1, 2, 3])
    expect(page(out, ZONE_BLOCK_FIRST)[ZONE_HEADER + 0x10]).toBe(3)
  })

  it('leaves the entries past the count exactly as the radio had them', () => {
    // This radio's first zone carries stale pointers to channels 43-48 past its
    // count of 14, and the radio is untroubled by them. Writing a shorter list
    // must not tidy them away - that is a larger diff for no proven benefit,
    // and it destroys the evidence of what the zone used to hold.
    const img = image()
    const doc = d.decode(img)
    doc.zones[0] = { ...doc.zones[0]!, channels: [1, 2] }
    const out = d.encode(doc, img)
    const from = ZONE_HEADER + 0x11 + 2 * 14
    expect(equalBytes(page(out, ZONE_BLOCK_FIRST).subarray(from, ZONE_HEADER + ZONE_SIZE), page(img, ZONE_BLOCK_FIRST).subarray(from, ZONE_HEADER + ZONE_SIZE))).toBe(true)
  })

  it('never writes a zero as a terminator', () => {
    // The reference records a hardware regression from doing so: the radio
    // showed null slots and lost channels.
    const img = image()
    const doc = d.decode(img)
    doc.zones[1] = { ...doc.zones[1]!, channels: [7] }
    const out = d.encode(doc, img)
    const rec = ZONE_HEADER + ZONE_SIZE
    expect(page(out, ZONE_BLOCK_FIRST)[rec + 0x10]).toBe(1)
    // Entry 2 is whatever the radio had, not a zero we invented.
    const entry2 = page(out, ZONE_BLOCK_FIRST).subarray(rec + 0x11 + 2, rec + 0x11 + 4)
    expect(equalBytes(entry2, page(img, ZONE_BLOCK_FIRST).subarray(rec + 0x11 + 2, rec + 0x11 + 4))).toBe(true)
  })

  it('drops a member the channel bank cannot resolve', () => {
    const img = image()
    const doc = d.decode(img)
    doc.zones[2] = { ...doc.zones[2]!, channels: [1, 500, 2] }
    expect(d.decode(d.encode(doc, img)).zones[2]!.channels).toEqual([1, 2])
  })

  it('caps a membership list at what a zone record can hold', () => {
    const img = image()
    const doc = d.decode(img)
    doc.zones[0] = { ...doc.zones[0]!, channels: Array.from({ length: 100 }, (_, i) => (i % 45) + 1) }
    expect(d.decode(d.encode(doc, img)).zones[0]!.channels.length).toBe(64)
  })
})

describe('settings', () => {
  it('decodes this radio’s own power-on message and colours', () => {
    const s = d.decode(image()).settings
    expect(s.powerOnLine1).toBe('EchoMike')
    expect(s.powerOnLine2).toBe('DM-32UV')
    expect(s['callsignColour.colour']).toBe(2)
    expect(s['zoneAColour.colour']).toBe(0)
    expect(s.backlightBrightness).toBe(5)
  })

  it('round-trips a changed setting', () => {
    const img = image()
    const doc = d.decode(img)
    doc.settings.powerOnLine1 = 'BOOFWANG'
    doc.settings.backlightBrightness = 3
    const back = d.decode(d.encode(doc, img)).settings
    expect(back.powerOnLine1).toBe('BOOFWANG')
    expect(back.backlightBrightness).toBe(3)
  })

  it('writes one bit of a bitfield without disturbing its neighbours', () => {
    const img = image()
    const doc = d.decode(img)
    const before = page(img, SETTINGS_BLOCK)[0x40]!
    doc.settings['gpsFlags.gpsSwitch'] = 0
    const after = page(d.encode(doc, img), SETTINGS_BLOCK)[0x40]!
    expect(after & 0x01).toBe(0)
    expect(after & ~0x01).toBe(before & ~0x01)
  })

  it('ignores a settings key this build does not model', () => {
    const img = image()
    const doc = d.decode(img)
    doc.settings.somethingInvented = 42
    expect(() => d.encode(doc, img)).not.toThrow()
    const out = d.encode(doc, img)
    expect(equalBytes(page(out, SETTINGS_BLOCK), page(img, SETTINGS_BLOCK))).toBe(true)
  })

  it('claims only the bytes it models, not the whole page', () => {
    const claimed = d.ownedRanges(logicalAddress(SETTINGS_BLOCK))
    const total = claimed.reduce((n, [a, b]) => n + (b - a), 0)
    expect(total).toBeGreaterThan(0)
    // The page is 4096 bytes and most of it has no established meaning.
    expect(total).toBeLessThan(200)
  })
})

describe('the talk group index the radio keeps for itself', () => {
  it('agrees with the talk group bank', () => {
    const img = image()
    const index = decodeTalkGroupIndex(img)!
    expect(index.live).toEqual([1, 3, 4, 6, 7, 10])
    // Six live slots, six talk groups decoded, and the name-sorted table names
    // the same six.
    expect(d.decode(img).talkGroups).toHaveLength(index.live.length)
    expect([...index.byName].sort((a, b) => a - b)).toEqual(index.live)
  })

  it('is never written', () => {
    expect(d.ownedRanges(logicalAddress(0x0b))).toEqual([])
  })
})

describe('everything together', () => {
  it('still round-trips the whole radio byte for byte', () => {
    const img = image()
    const out = d.encode(d.decode(img), img)
    for (const region of out.regions) {
      const original = img.regions.find((r) => r.start === region.start)!
      expect(equalBytes(region.data, original.data), `block 0x${(region.start >>> 12).toString(16)}`).toBe(true)
    }
  })

  it('never moves a byte outside the ranges it claims', () => {
    const img = image()
    const doc = d.decode(img)
    doc.zones[0] = { ...doc.zones[0]!, name: 'Z', channels: [1, 2] }
    doc.scanLists[0] = { ...doc.scanLists[0]!, name: 'S', channels: [3] }
    doc.rxGroups[0] = { ...doc.rxGroups[0]!, name: 'R', dmrIds: [9] }
    doc.radioIds[0] = { ...doc.radioIds[0]!, name: 'I', dmrId: 7 }
    doc.settings.powerOnLine1 = 'P'
    doc.talkGroups[0] = { ...doc.talkGroups[0]!, name: 'T' }
    const slot = [...doc.channels.keys()][0]!
    doc.channels.set(slot, { ...doc.channels.get(slot)!, name: 'C' })

    expect(diffImages(img, d.encode(doc, img), d).unowned).toEqual([])
  })
})

describe('membership follows the channel bank', () => {
  it('drops a zone member whose slot holds no channel, not merely one out of range', () => {
    // The bank count is 45 here, so 44 is "in range". If nothing is programmed
    // there it is still not a channel, and pointing a zone at it is the one
    // case this radio's own bytes could not settle.
    const img = image()
    const doc = d.decode(img)
    const missing = [...Array(45).keys()].map((n) => n + 1).find((n) => !doc.channels.has(n))
    doc.zones[0] = { ...doc.zones[0]!, channels: missing ? [1, missing, 2] : [1, 2] }
    const back = d.decode(d.encode(doc, img)).zones[0]!.channels
    expect(back).toEqual([1, 2])
  })

  it('keeps every member that does resolve', () => {
    const img = image()
    const doc = d.decode(img)
    const all = [...doc.channels.keys()].slice(0, 10)
    doc.zones[1] = { ...doc.zones[1]!, channels: all }
    expect(d.decode(d.encode(doc, img)).zones[1]!.channels).toEqual(all)
  })
})

describe('the DMR address book', () => {
  const START = 0x278000

  /** A contacts region built to the reference's own hex, then extended. */
  function withContacts(n: number): RadioImage {
    const img = image()
    const pages = Math.ceil((CONTACT_REGION_HEADER + n * CONTACT_SIZE) / PAGE_SIZE) || 1
    const regions = [...img.regions]
    for (let p = 0; p < pages; p++) {
      regions.push({ start: START + p * PAGE_SIZE, data: new Uint8Array(PAGE_SIZE).fill(0xff), readOnly: true, label: '' })
    }
    const page = (i: number) => regions.find((r) => r.start === START + i * PAGE_SIZE)!.data
    const head = page(0)
    head[0] = n & 0xff
    head[1] = (n >> 8) & 0xff
    head[2] = (n >> 16) & 0xff
    head[3] = 0

    for (let i = 0; i < n; i++) {
      const slot = contactSlot(i)
      DM32_CONTACT.write(page(slot.page), slot.offset, {
        name: `Contacts ${i + 1}`,
        dmrId: i + 1,
        callsign: i === 0 ? 'W1AW' : '',
        city: '',
        province: '',
        country: '',
        remark: '',
      })
    }
    return { ...img, regions, meta: { ...img.meta, contactsStart: START, contactsEnd: START + 0x463fff } }
  }

  it('reads nothing when the image has no contacts region', () => {
    expect(d.decode(image()).contacts).toEqual([])
  })

  it('decodes the reference’s own hardware sample', () => {
    // 0x000: 01 00 00 00, 0x010: "Contacts 1\0", 0x020: 01 00 00 f0
    const img = image()
    const data = new Uint8Array(PAGE_SIZE).fill(0xff)
    data.set([0x01, 0x00, 0x00, 0x00], 0)
    data.set([...'Contacts 1'].map((c) => c.charCodeAt(0)), 0x10)
    data[0x1a] = 0x00
    data.set([0x01, 0x00, 0x00, 0xf0], 0x20)

    const withRegion: RadioImage = {
      ...img,
      regions: [...img.regions, { start: START, data, readOnly: true, label: '' }],
      meta: { ...img.meta, contactsStart: START, contactsEnd: START + 0x463fff },
    }
    const contacts = d.decode(withRegion).contacts
    expect(contacts).toHaveLength(1)
    expect(contacts[0]!.name).toBe('Contacts 1')
    // The ID is 24-bit. Read as a uint32 the same bytes give 4,026,531,841,
    // which is not a DMR ID; the 0xF0 at +0x13 is something else.
    expect(contacts[0]!.dmrId).toBe(1)
  })

  it('walks past the first page without straddling it', () => {
    // 44 entries per page, and the flat index*92 formula in circulation walks
    // straight across the boundary and reads garbage from entry 44 on.
    const contacts = d.decode(withContacts(90)).contacts
    expect(contacts).toHaveLength(90)
    expect(contacts[43]!.name).toBe('Contacts 44')
    expect(contacts[44]!.name).toBe('Contacts 45')
    expect(contacts[89]!.dmrId).toBe(90)
  })

  it('keeps the fields the radio stores alongside the number', () => {
    const first = d.decode(withContacts(2)).contacts[0]!
    expect(first.callsign).toBe('W1AW')
    expect(first.city).toBe('')
  })

  it('round-trips untouched when nothing was edited', () => {
    const img = withContacts(50)
    const out = d.encode(d.decode(img), img)
    for (const region of out.regions) {
      if (region.start < START) continue
      const before = img.regions.find((r) => r.start === region.start)!
      expect(equalBytes(region.data, before.data), `page 0x${region.start.toString(16)}`).toBe(true)
    }
  })

  it('claims the count and the records, and nothing between or after them', () => {
    // The twelve bytes between the count and entry 0 are 0xFF in every capture
    // and explained by nobody; the tail past the last entry, byte 0xFFF
    // included, is data here rather than a block id.
    const img = withContacts(50)
    const first = contactsBase(img)!
    expect(d.ownedRanges(first, img)).toEqual([
      [0, 4],
      [CONTACT_REGION_HEADER, CONTACT_REGION_HEADER + 44 * CONTACT_SIZE],
    ])
    // Every later page is all records from its first byte.
    expect(d.ownedRanges(first + PAGE_SIZE, img)).toEqual([[0, 44 * CONTACT_SIZE]])
  })

  it('claims nothing for a raw region when it cannot tell which page it is', () => {
    // ownedRanges is handed an address and nothing else by some callers. Page 0
    // and page 3 differ in what their first four bytes mean, so without the
    // image the honest answer is to claim nothing - which stops a write rather
    // than guessing at it.
    const img = withContacts(50)
    expect(d.ownedRanges(contactsBase(img)!)).toEqual([])
  })

  it('writes an edited contact and leaves its neighbours alone', () => {
    const img = withContacts(50)
    const doc = d.decode(img)
    doc.contacts[1] = { ...doc.contacts[1]!, name: 'RENAMED', callsign: 'W1AW' }
    const out = d.encode(doc, img)

    const back = d.decode(out).contacts
    expect(back[1]!.name).toBe('RENAMED')
    expect(back[1]!.callsign).toBe('W1AW')
    expect(back[0]).toEqual(doc.contacts[0])
    expect(back[2]).toEqual(doc.contacts[2])
    expect(back).toHaveLength(50)
  })

  it('moves the count when a contact is added or removed', () => {
    const img = withContacts(50)
    const page0 = () => img.regions.find((r) => r.start === START)!.data

    const grown = d.decode(img)
    grown.contacts.push({ id: 'contact-new', name: 'NEW', dmrId: 1234567, callsign: '', city: '', province: '', country: '', remark: '' })
    const bigger = d.encode(grown, img)
    expect(d.decode(bigger).contacts).toHaveLength(51)
    expect(d.decode(bigger).contacts[50]!.name).toBe('NEW')

    const shrunk = d.decode(img)
    shrunk.contacts.splice(40)
    const smaller = d.encode(shrunk, img)
    expect(d.decode(smaller).contacts).toHaveLength(40)
    expect(page0()[0], 'the base image was mutated').toBe(50)
  })

  it('never claims the twelve bytes after the count', () => {
    const img = withContacts(50)
    const doc = d.decode(img)
    doc.contacts.splice(10)
    const out = d.encode(doc, img)
    const before = img.regions.find((r) => r.start === START)!.data
    const after = out.regions.find((r) => r.start === START)!.data
    expect(equalBytes(after.subarray(4, CONTACT_REGION_HEADER), before.subarray(4, CONTACT_REGION_HEADER))).toBe(true)
  })

  it('refuses more contacts than the pages it has', () => {
    const img = withContacts(50)
    const doc = d.decode(img)
    while (doc.contacts.length < 200) {
      doc.contacts.push({ id: `c${doc.contacts.length}`, name: 'X', dmrId: 1, callsign: '', city: '', province: '', country: '', remark: '' })
    }
    expect(() => d.encode(doc, img)).toThrow(/contact page/)
  })

  it('refuses a DMR ID too large for 24 bits', () => {
    const img = withContacts(50)
    const doc = d.decode(img)
    doc.contacts[0] = { ...doc.contacts[0]!, dmrId: 20_000_000 }
    expect(() => d.encode(doc, img)).toThrow(/24 bits/)
  })
})

describe('the key-function table, against the reference and this radio', () => {
  // Pinned by index because the index IS the byte written to the radio: the
  // schema builds the dropdown as map((label, value) => ({ value, label })).
  // An earlier table claimed to be transcribed from the reference and was not -
  // it agreed for fourteen entries and invented every one after, so choosing
  // "Monitor" would have stored 16, which this radio reads as Zone Up.
  it('matches reference/dm32/05-DATA-STRUCTURES.md value for value', () => {
    expect(DM32_KEY_FUNCTIONS).toHaveLength(43)
    for (const [value, label] of [
      [0, 'None'],
      [13, 'One Touch Call 5'],
      [14, 'SMS'],
      [15, 'CSV Contacts'],
      [16, 'Zone Up'],
      [17, 'Zone Down'],
      [18, 'Scan'],
      [25, 'Monitor'],
      [28, 'Keypad Lock'],
      [40, 'One Key Scan Freq'],
      [42, 'Man Down Alarm'],
    ] as const) {
      expect(DM32_KEY_FUNCTIONS[value], `value ${value}`).toBe(label)
    }
  })

  it('renders this radio’s own key bytes as a coherent set', () => {
    // 0x088=0x1c, 0x089=0x19, 0x08d=0x11, 0x08f=0x10 - Keypad Lock, Monitor,
    // Zone Down, Zone Up. The Zone Down / Zone Up pair on the two programmable
    // keys is the tell: the old table called them "Squelch Off" and "Monitor".
    const s = d.decode(image()).settings
    const label = (v: unknown) => DM32_KEY_FUNCTIONS[Number(v)]
    expect(page(image(), SETTINGS_BLOCK)[0x88]).toBe(0x1c)
    expect(label(s.sk1Long)).toBe('Keypad Lock')
    expect(label(s.sk2Short)).toBe('Monitor')
    expect(label(s.p1Short)).toBe('Zone Down')
    expect(label(s.p2Short)).toBe('Zone Up')
  })

  it('offers exactly the values it can name', () => {
    const keys = SCHEMA_SETTINGS.find((g) => g.id === 'keys')!
    const options = keys.fields.find((f) => f.key === 'sk1Short')!.options!
    expect(options).toHaveLength(DM32_KEY_FUNCTIONS.length)
    for (const opt of options) expect(DM32_KEY_FUNCTIONS[Number(opt.value)]).toBe(opt.label)
  })
})

describe('radio IDs keep their slots', () => {
  /** Put an entry in a slot the count does not reach, as the decoder allows. */
  function withIdAt(slot: number, dmrId: number, name: string, count: number): RadioImage {
    const img = image()
    const data = page(img, RADIOID_BLOCK)
    DM32_RADIOID.write(data, RADIOID_HEADER + slot * RADIOID_SIZE, { dmrId, name })
    data[0] = count
    return img
  }

  it('round-trips an image whose bank has a gap', () => {
    // Channel byte 0x2B points at a radio ID by slot, so packing the bank
    // densely would silently repoint every channel after the gap.
    const img = withIdAt(4, 3_105_123, 'FIFTH', 5)
    const out = d.encode(d.decode(img), img)
    expect(equalBytes(page(out, RADIOID_BLOCK), page(img, RADIOID_BLOCK))).toBe(true)
  })

  it('does not move an entry the count never reached', () => {
    const img = withIdAt(5, 3_105_999, 'SIXTH', 1)
    const back = d.decode(d.encode(d.decode(img), img))
    const ids = back.radioIds
    // Both the counted one and the uncounted one, each still in its own slot.
    expect(ids.map((r) => r.id)).toEqual(['rid-1', 'rid-6'])
    expect(ids[1]!.dmrId).toBe(3_105_999)
  })

  it('does not raise the count for an entry with no name and no number', () => {
    // What the "Add" button produces before anything is typed into it. A count
    // the record table does not back is a state this driver's own decoder
    // refuses to read.
    const img = image()
    const doc = d.decode(img)
    doc.radioIds.push({ id: 'rid-new-2', name: '', dmrId: 0 })
    const out = d.encode(doc, img)
    expect(page(out, RADIOID_BLOCK)[0]).toBe(page(img, RADIOID_BLOCK)[0])
    expect(d.decode(out).radioIds).toHaveLength(1)
  })

  it('gives a genuinely new entry the lowest free slot', () => {
    const img = image()
    const doc = d.decode(img)
    doc.radioIds.push({ id: 'rid-new-2', name: 'SECOND', dmrId: 3_105_002 })
    const out = d.encode(doc, img)
    expect(page(out, RADIOID_BLOCK)[0]).toBe(2)
    expect(d.decode(out).radioIds.map((r) => r.id)).toEqual(['rid-1', 'rid-2'])
  })

  it('counts to the highest occupied slot, not to how many there are', () => {
    const img = withIdAt(5, 3_105_999, 'SIXTH', 6)
    const out = d.encode(d.decode(img), img)
    expect(page(out, RADIOID_BLOCK)[0], 'a gap still consumes its index').toBe(6)
  })
})

describe('the write gate sees a contact edit', () => {
  const START = 0x278000

  /** An image shaped the way readImage really produces one. */
  function readAsRadio(contacts = 60, readOnly = false): RadioImage {
    const img = image()
    const pages = Math.ceil((CONTACT_REGION_HEADER + contacts * CONTACT_SIZE) / PAGE_SIZE) || 1
    const regions = [...img.regions]
    for (let p = 0; p < pages; p++) {
      const data = new Uint8Array(PAGE_SIZE).fill(0xff)
      if (p === 0) data.set([contacts & 0xff, (contacts >> 8) & 0xff, 0, 0], 0)
      regions.push({ start: START + p * PAGE_SIZE, data, label: '', ...(readOnly ? { readOnly } : {}) })
    }
    for (let n = 0; n < contacts; n++) {
      const slot = contactSlot(n)
      const page = regions.find((r) => r.start === START + slot.page * PAGE_SIZE)!.data
      DM32_CONTACT.write(page, slot.offset, {
        name: `Contact ${n + 1}`, dmrId: 3_105_000 + n, unknown13: 0xf0,
        callsign: '', city: '', province: '', country: '', remark: '',
      })
    }
    return { ...img, regions }
  }

  it('counts the bytes and names the page, rather than calling it unowned', () => {
    // The flag that broke this said "never send". diffImages honours it by
    // routing every change into `unowned`, so the gate refused a contact edit
    // as an encoder defect and reported it as no change at all - in the same
    // breath as capabilities.writeScope promising contacts were writable.
    const img = readAsRadio()
    const doc = d.decode(img)
    doc.contacts[0] = { ...doc.contacts[0]!, name: 'EDITED' }

    const diff = diffImages(img, d.encode(doc, img), d)
    expect(diff.unowned, 'a contact edit is not an encoder defect').toEqual([])
    expect(diff.changedBytes, 'a contact edit must count as a change').toBeGreaterThan(0)
    expect(diff.changedBlocks.length).toBe(1)
  })

  it('is what the read path actually produces', () => {
    // The bug lived in readImage, and the fixtures that would have caught it
    // built their contact pages by hand without the flag - a shape the real
    // read path never produced.
    const img = readAsRadio()
    for (const page of contactPages(img)) {
      expect(page.readOnly, 'contacts pages must be writable now that they are written').toBeFalsy()
    }
  })

  it('would be blocked if the pages were still read-only', () => {
    // Pins the mechanism, so the flag cannot quietly come back.
    const img = readAsRadio(60, true)
    const doc = d.decode(img)
    doc.contacts[0] = { ...doc.contacts[0]!, name: 'EDITED' }
    const diff = diffImages(img, d.encode(doc, img), d)
    expect(diff.changedBytes).toBe(0)
    expect(diff.unowned.length).toBeGreaterThan(0)
  })

  it('gives a new contact the byte every real one has', () => {
    const img = readAsRadio(2)
    const doc = d.decode(img)
    doc.contacts.push({
      id: 'c-new', name: 'NEW', dmrId: 3_105_999,
      callsign: '', city: '', province: '', country: '', remark: '',
    })
    const out = d.encode(doc, img)
    const slot = contactSlot(2)
    const page = out.regions.find((r) => r.start === START + slot.page * PAGE_SIZE)!.data
    expect(page[slot.offset + 0x13], 'a brand-new record must not be the only 0xFF one').toBe(0xf0)
  })

  it('keeps an existing record’s own byte rather than imposing one', () => {
    const img = readAsRadio(2)
    const slot = contactSlot(1)
    const page = img.regions.find((r) => r.start === START + slot.page * PAGE_SIZE)!.data
    page[slot.offset + 0x13] = 0x77

    const doc = d.decode(img)
    doc.contacts[1] = { ...doc.contacts[1]!, name: 'RENAMED' }
    const out = d.encode(doc, img)
    const after = out.regions.find((r) => r.start === START + slot.page * PAGE_SIZE)!.data
    expect(after[slot.offset + 0x13]).toBe(0x77)
  })

  it('carries a full-width field without shortening it', () => {
    // 39 of this radio's 147 contacts fill all sixteen bytes. There is no
    // terminator to reserve, and the radio writes them that way itself.
    const img = readAsRadio(2)
    const doc = d.decode(img)
    doc.contacts[0] = { ...doc.contacts[0]!, city: 'North Little Roc' }
    expect(d.decode(d.encode(doc, img)).contacts[0]!.city).toBe('North Little Roc')
  })
})

describe('which talk group a channel transmits to', () => {
  it('decodes this radio’s channels to the talk groups their names describe', () => {
    // The strongest confirmation available without a second radio: the user
    // named their channels after the talk groups they key, and the indices
    // resolve to exactly those.
    const cp = d.decode(image())
    const byName = new Map(cp.talkGroups.map((g, i) => [i + 1, g.name]))
    void byName

    const slotOf = (name: string) => Number(
      [...cp.channels.values()].find((c) => c.name === name)?.extras.vendor?.txContact,
    )
    // Physical talk group slots on this radio: 1 LITTLE ROCK METR, 3 ARKANSAS,
    // 4 TAC Chan, 6 USA, 7 Test.
    expect(slotOf('LR DMR')).toBe(1)
    expect(slotOf('AR DMR')).toBe(3)
    expect(slotOf('USA DMR')).toBe(6)
    expect(slotOf('Test DMR')).toBe(7)
    for (let n = 1; n <= 14; n++) expect(slotOf(`TAC ${n}`), `TAC ${n}`).toBe(4)
  })

  it('leaves an analog channel without one', () => {
    const cp = d.decode(image())
    expect([...cp.channels.values()].find((c) => c.name === 'MURS-1')?.extras.vendor?.txContact).toBeUndefined()
  })

  it('splits the two blocks at 2047/2048', () => {
    expect(txContactSlot(1)).toEqual({ blockId: 0x42, offset: 0 })
    expect(txContactSlot(2047)).toEqual({ blockId: 0x42, offset: 4092 })
    expect(txContactSlot(2048)).toEqual({ blockId: 0x43, offset: 0 })
    expect(txContactSlot(2049)).toEqual({ blockId: 0x43, offset: 2 })
    expect(txContactSlot(0)).toBeNull()
    // 2047 * 2 + 2 = 4094, so the last entry stops clear of the block id byte.
    expect(txContactSlot(2047)!.offset + 2).toBeLessThan(PAGE_SIZE - 1)
  })

  it('packs the index across two bytes with the digital flag', () => {
    // This radio's TAC channels read 01 04: index 4, digital.
    expect(decodeTxContact(0x01, 0x04)).toEqual({ slot: 4, digital: true })
    expect(decodeTxContact(0x00, 0x01)).toEqual({ slot: 1, digital: false })
    // A 12-bit index really does use the high nibble of byte 0.
    expect(decodeTxContact(0x31, 0x02)).toEqual({ slot: 0x302, digital: true })
    expect(encodeTxContact(0x302, true, 0)).toEqual([0x31, 0x02])
  })

  it('preserves the three bits of byte 0 that nobody has explained', () => {
    // Bits 3-1 were once called "Reserved", which the reference retracts.
    expect(encodeTxContact(4, true, 0b0000_1110)).toEqual([0b0000_1111, 4])
    expect(encodeTxContact(4, false, 0b0000_1010)).toEqual([0b0000_1010, 4])
  })

  it('round-trips every channel unchanged', () => {
    const img = image()
    const out = d.encode(d.decode(img), img)
    expect(equalBytes(page(out, 0x42), page(img, 0x42))).toBe(true)
  })

  it('writes a changed talk group and only that entry', () => {
    const img = image()
    const doc = d.decode(img)
    const lr = [...doc.channels.values()].find((c) => c.name === 'LR DMR')!
    doc.channels.set(lr.index, {
      ...lr,
      extras: { ...lr.extras, vendor: { ...lr.extras.vendor, txContact: '7' } },
    })
    const out = d.encode(doc, img)
    expect(Number(d.decode(out).channels.get(lr.index)!.extras.vendor!.txContact)).toBe(7)

    const before = page(img, 0x42)
    const after = page(out, 0x42)
    const moved = [...after.keys()].filter((i) => after[i] !== before[i])
    expect(moved).toEqual([(lr.index - 1) * 2 + 1])
  })

  it('never writes the high block, whose contents contradict its purpose', () => {
    // On this radio block 0x43's tail holds two "Zone 1" strings rather than
    // contact data, and nothing explains why.
    expect(d.ownedRanges(logicalAddress(0x43))).toEqual([])
    const img = image()
    const out = d.encode(d.decode(img), img)
    expect(equalBytes(page(out, 0x43), page(img, 0x43))).toBe(true)
  })

  it('refuses a talk group slot wider than the twelve bits stored', () => {
    const img = image()
    const doc = d.decode(img)
    const lr = [...doc.channels.values()].find((c) => c.name === 'LR DMR')!
    doc.channels.set(lr.index, {
      ...lr,
      extras: { ...lr.extras, vendor: { ...lr.extras.vendor, txContact: '5000' } },
    })
    expect(() => d.encode(doc, img)).toThrow(/12 bits/)
  })
})
