// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { diffImages } from '#core/radio/diff.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver, decodeTalkGroupIndex } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { DM32UV_SETTINGS_GROUPS as SCHEMA_SETTINGS } from '#core/radios/dm32uv/schema.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import {
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
  contactSlot,
} from '#core/radios/dm32uv/layout.js'

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

  it('leaves membership exactly as the radio had it', () => {
    // Two readings of these bytes sit one word apart and both have direct
    // evidence: this radio's second list has a count of 9 and nine non-zero
    // words from +0x18, while the reference's capture of the vendor software
    // has 0x0000 at +0x18 on all nine of its lists. Writing the wrong one
    // shifts every channel in the list, so neither is written.
    const img = image()
    const doc = d.decode(img)
    doc.scanLists[1] = { ...doc.scanLists[1]!, channels: [5, 10, 15] }
    const out = d.encode(doc, img)
    const from = SCANLIST_HEADER + SCANLIST_SIZE
    expect(
      equalBytes(
        page(out, SCANLIST_BLOCK).subarray(from + 0x0b, from + SCANLIST_SIZE),
        page(img, SCANLIST_BLOCK).subarray(from + 0x0b, from + SCANLIST_SIZE),
      ),
      'a membership edit reached the radio',
    ).toBe(true)
  })

  it('still writes the name, which is unambiguous', () => {
    const img = image()
    const doc = d.decode(img)
    doc.scanLists[0] = { ...doc.scanLists[0]!, name: 'RENAMED', channels: [9] }
    const back = d.decode(d.encode(doc, img)).scanLists[0]!
    expect(back.name).toBe('RENAMED')
    expect(back.channels).toEqual(d.decode(img).scanLists[0]!.channels)
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

  it('is never a write target', () => {
    // The region has no block id and no hardware sample past one entry.
    const img = withContacts(50)
    const out = d.encode(d.decode(img), img)
    for (const region of out.regions) {
      if (region.start < START) continue
      const before = img.regions.find((r) => r.start === region.start)!
      expect(equalBytes(region.data, before.data)).toBe(true)
      expect(d.ownedRanges(region.start)).toEqual([])
    }
  })

  it('survives a round trip untouched even when the codeplug is edited', () => {
    const img = withContacts(50)
    const doc = d.decode(img)
    doc.settings.powerOnLine1 = 'EDITED'
    doc.contacts[0] = { ...doc.contacts[0]!, name: 'IGNORED' }
    const out = d.encode(doc, img)
    for (const region of out.regions) {
      if (region.start < START) continue
      expect(equalBytes(region.data, img.regions.find((r) => r.start === region.start)!.data)).toBe(true)
    }
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
