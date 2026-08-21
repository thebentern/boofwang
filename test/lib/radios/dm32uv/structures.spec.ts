// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { diffImages } from '#core/radio/diff.js'
import type { RadioImage } from '#core/radio/image.js'
import { hz } from '#core/model/units.js'
import { createDm32uvDriver, decodeTalkGroupIndex } from '#core/radios/dm32uv/driver.js'
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
  ANALOG_BLOCK,
  VFO_A,
  VFO_B,
  VFO_BLOCK,
  CHANNEL_SIZE,
  channelSlot,
  DTMF_SPECIAL_BASE,
  BDC_BASE,
  BDC_SIZE,
  EMERGENCY_SIZE,
  EMERGENCY_SLOTS,
  KEY_AREA,
  KEY_BLOCK,
  MESSAGE_BLOCK,
  MESSAGE_HEADER,
  MESSAGE_MAX_CHARS,
  MESSAGE_SIZE,
  ROAMCHANNEL_BLOCK,
  ROAMCHANNEL_COUNT_AT,
  DM32_ROAMZONE,
  CALLLIST_BASE,
  CALLLIST_BLOCK,
  CALLLIST_END,
  CALLLIST_NAME_AT,
  CALLLIST_SIZE,
  CALLLIST_SLOTS,
  DM32_CALLLIST,
  ROAMZONE_BLOCK,
  ROAMZONE_NAME_AT,
  ROAMZONE_SIZE,
  TXCONTACT_HIGH_LIMIT,
  VFO_A_TXCONTACT,
  VFO_B_TXCONTACT,
  ZONE_BLOCK_FIRST,
  ZONE_HEADER,
  ZONE_SIZE,
  contactSlot,
  decodeTxContact,
  encodeTxContact,
  txContactSlot,
} from '#core/radios/dm32uv/layout.js'
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

  it('claims the documented bytes, less the ones it declines to model', () => {
    const claimed = d.ownedRanges(logicalAddress(SETTINGS_BLOCK))
    const total = claimed.reduce((n, [a, b]) => n + (b - a), 0)

    // The reference counts 232 bytes of block 0x04 as carrying a documented
    // field. Five groups of those are deliberately left unclaimed, so the
    // number below is arithmetic rather than a bound someone picked:
    const DOCUMENTED = 232
    const ANALOG_CALL = 8 // 0x120-0x127: the dump contradicts the field order
    const LANGUAGE_BLOB = 8 // 0x0A0-0x0A7: opaque, no decomposition exists
    const UNKNOWN_SINGLES = 3 // 0x032, 0x045, 0x080: named but not understood
    const FUN_PLUS_PADDING = 10 // one skipped byte in each of ten entries
    expect(total).toBe(DOCUMENTED - ANALOG_CALL - LANGUAGE_BLOB - UNKNOWN_SINGLES - FUN_PLUS_PADDING)

    // And the page is 4096 bytes, so the great majority stays untouched.
    expect(total).toBeLessThan(PAGE_SIZE / 10)
  })

  it('leaves the bytes it declines to model alone', () => {
    const unclaimed = [0x032, 0x045, 0x080, 0x0a0, 0x0a7, 0x120, 0x127, 0x232]
    const claimed = d.ownedRanges(logicalAddress(SETTINGS_BLOCK))
    for (const off of unclaimed) {
      expect(claimed.some(([a, b]) => off >= a && off < b)).toBe(false)
    }

    // Not just unclaimed - actually preserved through a round trip that
    // rewrites every setting the build does model.
    const img = image()
    const data = page(img, SETTINGS_BLOCK)
    for (const off of unclaimed) data[off] = 0x5a
    const doc = d.decode(img)
    doc.settings.menuExitTime = 7
    doc.settings['menuZone.zoneList'] = 0
    const out = page(d.encode(doc, img), SETTINGS_BLOCK)
    for (const off of unclaimed) expect(out[off]).toBe(0x5a)
  })

  it('reads and writes every region the reference documents', () => {
    const doc = d.decode(image()).settings
    // One representative key from each documented region, so a struct edit that
    // silently drops a whole table fails here rather than on someone's radio.
    for (const key of [
      'powerOnLine1',
      'alertTones.keyPress',
      'alertTonesCont.batteryLow',
      'backlightBrightness',
      'standbyCharColour1',
      'gpsFlags.gpsSwitch',
      'callHoldTime',
      'digitalFlags.missedCallAlert',
      'nameDisplayFlags.sendTxName',
      'txDwellTime',
      'sk1Short',
      'oneTouch1Type',
      'oneTouch5Sms',
      'funPlus1Mode',
      'funPlus10Sms',
      'aprsScheduledSendTime',
      'latitude',
      'aprsReportChannel8',
      'aprsUploadId',
      'menuZone.zoneList',
      'menuChannelB.channelName',
    ]) {
      expect(key in doc, key).toBe(true)
    }
  })

  it('round-trips every modelled setting through a write', () => {
    const img = image()
    const doc = d.decode(img)
    // Hand the whole decoded settings record straight back. Every field must
    // survive its own encoder, or the page comes back different.
    const out = d.encode(doc, img)
    expect(equalBytes(page(out, SETTINGS_BLOCK), page(img, SETTINGS_BLOCK))).toBe(true)
  })

  it('writes each documented region where the reference says it lives', () => {
    const cases: [string, number, number][] = [
      ['standbyCharColour1', 0x037, 6],
      ['activeWaitTime', 0x062, 9],
      ['preCarrierTime', 0x064, 11],
      ['smsFormat', 0x066, 5],
      ['txDwellTime', 0x081, 200],
      ['oneTouch3CallType', 0x20d, 6],
      ['funPlus7Menu', 0x25b, 13],
      ['aprsRepeaterActiveDelay', 0x330, 10],
    ]
    for (const [key, off, value] of cases) {
      const img = image()
      const doc = d.decode(img)
      doc.settings[key] = value
      const out = page(d.encode(doc, img), SETTINGS_BLOCK)
      expect(out[off], `${key} @0x${off.toString(16)}`).toBe(value)
    }
  })

  it('stores the APRS upload ID and the report channels little-endian', () => {
    const img = image()
    const doc = d.decode(img)
    doc.settings.aprsUploadId = 0x123456
    doc.settings.aprsReportChannel1 = 0x0102
    const out = page(d.encode(doc, img), SETTINGS_BLOCK)
    expect([out[0x332], out[0x333], out[0x334]]).toEqual([0x56, 0x34, 0x12])
    expect([out[0x320], out[0x321]]).toEqual([0x02, 0x01])
    expect(d.decode(d.encode(doc, img)).settings.aprsUploadId).toBe(0x123456)
  })

  it('flips one menu bit without disturbing the unlabelled ones beside it', () => {
    const img = image()
    // The OEM write capture has data in 0x500 bits 2-7, which no label covers.
    page(img, SETTINGS_BLOCK)[0x500] = 0xfd
    const doc = d.decode(img)
    doc.settings['menuZone.newZone'] = 0
    const out = page(d.encode(doc, img), SETTINGS_BLOCK)
    expect(out[0x500]).toBe(0xfd & ~0b10)
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

  it('claims the high block’s records and the VFO slots, but not the residue between', () => {
    // From 0x0EF6 block 0x43 holds two stale zone records the flash layer left
    // behind. Claiming them would disarm the check that stops a write when a
    // byte moves outside what this build models - which is why 0x43's claim is
    // deliberately not 0x42's. The two VFO talk-group slots sit past all of it,
    // in the tail, and are claimed on their own rather than by widening the
    // first range over the residue.
    expect(d.ownedRanges(logicalAddress(0x43))).toEqual([
      [0, TXCONTACT_HIGH_LIMIT],
      [VFO_A_TXCONTACT, VFO_B_TXCONTACT + 2],
    ])
    expect(d.ownedRanges(logicalAddress(0x42))).toEqual([[0, PAGE_SIZE - 1]])

    // Nothing claims the residue, and the block's own metadata byte is outside.
    const claimed = d.ownedRanges(logicalAddress(0x43))
    for (const off of [TXCONTACT_HIGH_LIMIT, 0x0ef6, 0x0f00, 0x0ff9, 0x0ffe, PAGE_SIZE - 1]) {
      expect(claimed.some(([a, b]) => off >= a && off < b), `0x${off.toString(16)}`).toBe(false)
    }

    const img = image()
    const out = d.encode(d.decode(img), img)
    expect(equalBytes(page(out, 0x43), page(img, 0x43))).toBe(true)
  })

  it('leaves an erased VFO talk-group slot alone rather than writing 4095 into it', () => {
    // Erased fill here is 0xFF, not the 0x00 a channel record uses. Read as a
    // record, 0xFFFF is slot 4095 on a digital VFO - and this radio has both
    // slots erased, so a decoder that took it at face value would write that
    // number back on the next upload.
    const img = image()
    const data = page(img, 0x43)
    expect([data[VFO_A_TXCONTACT], data[VFO_A_TXCONTACT + 1]]).toEqual([0xff, 0xff])
    const doc = d.decode(img)
    expect(doc.vfo.a?.extras.vendor?.txContact).toBeUndefined()
    expect(doc.vfo.b?.extras.vendor?.txContact).toBeUndefined()
    const out = page(d.encode(doc, img), 0x43)
    expect([out[VFO_A_TXCONTACT], out[VFO_A_TXCONTACT + 1]]).toEqual([0xff, 0xff])
  })

  it('writes a VFO talk group where both OEM captures put it', () => {
    const img = image()
    const doc = d.decode(img)
    doc.vfo.a = { ...doc.vfo.a!, extras: { ...doc.vfo.a!.extras, vendor: { txContact: '1' } } }
    doc.vfo.b = { ...doc.vfo.b!, modulation: 'DMR', extras: { ...doc.vfo.b!.extras, vendor: { txContact: '1' } } }
    const out = page(d.encode(doc, img), 0x43)

    /*
     * `0e 01` is not an arbitrary result - it is what the OEM write capture
     * holds at this exact offset.
     *
     * Bits 3-1 of the first byte are undecoded and preserved, and this radio's
     * slot is erased, so preserving them from 0xFF sets all three: slot 1,
     * analog, `0x0E`. The OEM CPS evidently read-modify-writes the same way
     * over the same fill, because its capture reads `ff ff 0e 01 0e 01 ff 43`.
     * Reproducing a capture nobody was aiming at is the strongest evidence in
     * this file that the bit layout is right.
     */
    expect([out[VFO_A_TXCONTACT], out[VFO_A_TXCONTACT + 1]]).toEqual([0x0e, 0x01])
    // The same slot with the digital bit set, as the read capture's VFO B has.
    expect([out[VFO_B_TXCONTACT], out[VFO_B_TXCONTACT + 1]]).toEqual([0x0f, 0x01])
    expect(decodeTxContact(out[VFO_A_TXCONTACT]!, out[VFO_A_TXCONTACT + 1]!)).toEqual({
      slot: 1,
      digital: false,
    })
    expect(decodeTxContact(out[VFO_B_TXCONTACT]!, out[VFO_B_TXCONTACT + 1]!)).toEqual({
      slot: 1,
      digital: true,
    })
    // 0x0FFE is unused in both captures and the metadata byte follows it.
    expect(out[0x0ffe]).toBe(page(img, 0x43)[0x0ffe])
    expect(out[0x0fff]).toBe(0x43)

    expect(d.decode(d.encode(doc, img)).vfo.b?.extras.vendor?.txContact).toBe('1')
  })

  it('preserves the three undecoded bits of the VFO slot’s first byte', () => {
    const img = image()
    // The OEM write capture stores 0x0E there, whose bits 1-3 carry data.
    page(img, 0x43)[VFO_A_TXCONTACT] = 0x0e
    page(img, 0x43)[VFO_A_TXCONTACT + 1] = 0x01
    const doc = d.decode(img)
    expect(doc.vfo.a?.extras.vendor?.txContact).toBe('1')
    doc.vfo.a = { ...doc.vfo.a!, extras: { ...doc.vfo.a!.extras, vendor: { txContact: '2' } } }
    const out = page(d.encode(doc, img), 0x43)
    expect(out[VFO_A_TXCONTACT]! & 0b1110).toBe(0x0e & 0b1110)
    expect(out[VFO_A_TXCONTACT + 1]).toBe(0x02)
  })

  it('refuses a channel whose entry lands in that residue', () => {
    const img = image()
    const doc = d.decode(img)
    const template = doc.channels.get([...doc.channels.keys()][0]!)!
    // Channel 3963 is the first whose two bytes fall at or past 0x0EF6.
    doc.channels.set(3963, {
      ...template,
      index: 3963,
      extras: { ...template.extras, vendor: { ...template.extras.vendor, txContact: '1' } },
    })
    expect(() => d.encode(doc, img)).toThrow(/firmware residue|does not fit|has not allocated/)
  })

  it('writes a channel above 2047 into the high block', () => {
    // 601 channels above 2047 are creatable on this radio: blocks 0x30, 0x31,
    // 0x32, 0x34, 0x37, 0x3b, 0x3d and 0x41 are allocated. Channel 2550 is one.
    const img = image()
    const doc = d.decode(img)
    const template = doc.channels.get([...doc.channels.keys()][0]!)!
    doc.channels.set(2550, {
      ...template,
      index: 2550,
      modulation: 'DMR',
      extras: { ...template.extras, vendor: { ...template.extras.vendor, txContact: '4' } },
    })
    const out = d.encode(doc, img)
    const at = (2550 & 0x7ff) * 2
    const after = page(out, 0x43)
    expect(decodeTxContact(after[at]!, after[at + 1]!)).toEqual({ slot: 4, digital: true })
    // And nothing outside that pair moved.
    const before = page(img, 0x43)
    expect([...after.keys()].filter((i) => after[i] !== before[i])).toEqual([at, at + 1])
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

describe('canned text messages', () => {
  it('decodes this radio’s five, length byte and all', () => {
    const cp = d.decode(image())
    expect(cp.messages).toHaveLength(5)
    expect(cp.messages[0]).toBe('How are you?')
    // The length byte is the truth: 12 characters, and the field is padded.
    expect(page(image(), MESSAGE_BLOCK)[MESSAGE_HEADER]).toBe(12)
  })

  it('reads the count as one byte, not two', () => {
    // The trap that already bit zones, scan lists and radio IDs. On this radio
    // byte 0x001 happens to be 0x00, so a 16-bit read gives the same answer and
    // proves nothing - the header byte has to be made non-zero to tell the two
    // readings apart.
    const img = image()
    expect(page(img, MESSAGE_BLOCK)[0]).toBe(5)
    page(img, MESSAGE_BLOCK)[1] = 0x01
    expect(d.decode(img).messages, 'a 16-bit read would report 261 messages').toHaveLength(5)
  })

  it('round-trips untouched', () => {
    const img = image()
    const out = d.encode(d.decode(img), img)
    expect(equalBytes(page(out, MESSAGE_BLOCK), page(img, MESSAGE_BLOCK))).toBe(true)
  })

  it('writes a message and its length together', () => {
    const img = image()
    const doc = d.decode(img)
    doc.messages[1] = 'On my way'
    const out = d.encode(doc, img)
    expect(d.decode(out).messages[1]).toBe('On my way')
    expect(page(out, MESSAGE_BLOCK)[MESSAGE_HEADER + MESSAGE_SIZE]).toBe(9)
  })

  it('leaves nothing of a longer message behind, including the last byte', () => {
    // The text field pads to 127 bytes, so the visible tail goes on its own.
    // Byte 0x80 is outside it - the reference calls it a terminator and marks
    // that DERIVED - so the record is cleared whole rather than trusting the
    // pad to reach.
    const img = image()
    page(img, MESSAGE_BLOCK)[MESSAGE_HEADER + 0x80] = 0x5a

    const doc = d.decode(img)
    doc.messages[0] = 'Hi'
    const out = d.encode(doc, img)
    expect(d.decode(out).messages[0]).toBe('Hi')

    const rec = page(out, MESSAGE_BLOCK).subarray(MESSAGE_HEADER, MESSAGE_HEADER + MESSAGE_SIZE)
    expect(new TextDecoder('latin1').decode(rec)).not.toContain('are you')
    expect(rec[0x80], 'the byte past the text field').toBe(0)
  })

  it('adds and removes by moving the count', () => {
    const img = image()
    const doc = d.decode(img)
    doc.messages.push('Sixth')
    expect(d.decode(d.encode(doc, img)).messages).toHaveLength(6)
    const doc2 = d.decode(img)
    doc2.messages.splice(2)
    const out = d.encode(doc2, img)
    expect(page(out, MESSAGE_BLOCK)[0]).toBe(2)
    expect(d.decode(out).messages).toHaveLength(2)
  })

  it('clips a message to what a record holds', () => {
    const img = image()
    const doc = d.decode(img)
    doc.messages[0] = 'x'.repeat(300)
    expect(d.decode(d.encode(doc, img)).messages[0]).toHaveLength(MESSAGE_MAX_CHARS)
  })
})

describe('roaming', () => {
  it('decodes this radio’s three channels with real frequencies', () => {
    const cp = d.decode(image())
    expect(cp.roamChannels.map((c) => c.name)).toEqual(['Roam CH 1', 'Roam CH 2', 'Roam CH 3'])
    for (const c of cp.roamChannels) {
      expect(c.rxFreq, `${c.name} rx`).toBeGreaterThan(100_000_000)
      expect(c.txFreq, `${c.name} tx`).toBeGreaterThan(100_000_000)
      expect(c.timeSlot === 1 || c.timeSlot === 2).toBe(true)
      expect(c.colorCode).toBeLessThanOrEqual(15)
    }
  })

  it('reads the channel count from the trailer, not a header', () => {
    // Unique in this radio: every other counted structure puts its count first.
    const data = page(image(), ROAMCHANNEL_BLOCK)
    expect(data[ROAMCHANNEL_COUNT_AT]).toBe(3)
    // Offset 0 is the first character of the first name, not a count.
    expect(String.fromCharCode(data[0]!)).toBe('R')
  })

  it('decodes the zones by name, and does not invent their membership', () => {
    const cp = d.decode(image())
    expect(cp.roamZones.map((z) => z.name)).toEqual(['Roam Zone 1', 'Roam Zone 2', 'Roam Zone 3'])
    // channelIndex is carried so the gap is visible; members are not decoded.
    for (const z of cp.roamZones) expect(typeof z.channelIndex).toBe('number')
  })

  it('does not read the first byte of the block as a zone count', () => {
    // It is 0x03 on this radio against three zones, which reads exactly like a
    // count and is not one - it is record 0's flags. Records 1 and 2 have 0xFF
    // in the same position, which no count encoding would produce.
    const data = page(image(), ROAMZONE_BLOCK)
    expect(data[0]).toBe(0x03)
    expect(data[ROAMZONE_SIZE]).toBe(0xff)
    expect(data[ROAMZONE_SIZE * 2]).toBe(0xff)

    // A fourth zone, past where any count byte would have stopped the walk.
    const img = image()
    const p4 = page(img, ROAMZONE_BLOCK)
    for (let i = 0; i < 11; i++) p4[ROAMZONE_SIZE * 3 + ROAMZONE_NAME_AT + i] = 'Roam Zone 4'.charCodeAt(i)
    expect(d.decode(img).roamZones.map((z) => z.name)).toEqual([
      'Roam Zone 1',
      'Roam Zone 2',
      'Roam Zone 3',
      'Roam Zone 4',
    ])
  })

  it('renames the zone whose slot the id names, not the nth occupied one', () => {
    const img = image()
    const doc = d.decode(img)
    doc.roamZones = doc.roamZones.filter((z) => z.id !== 'roamzone-2')
    doc.roamZones[1] = { ...doc.roamZones[1]!, name: 'Third' }
    const out = d.encode(doc, img)
    const data = page(out, ROAMZONE_BLOCK)
    const nameAt = (n: number) =>
      DM32_ROAMZONE.read(data, n * ROAMZONE_SIZE).name.replace(/\0+$/, '').trimEnd()
    expect(nameAt(0)).toBe('Roam Zone 1')
    expect(nameAt(1)).toBe('Roam Zone 2') // dropped from the doc, left alone on the radio
    expect(nameAt(2)).toBe('Third')
  })

  it('round-trips both blocks untouched', () => {
    const img = image()
    const out = d.encode(d.decode(img), img)
    expect(equalBytes(page(out, ROAMCHANNEL_BLOCK), page(img, ROAMCHANNEL_BLOCK))).toBe(true)
    expect(equalBytes(page(out, ROAMZONE_BLOCK), page(img, ROAMZONE_BLOCK))).toBe(true)
  })

  it('writes a roaming channel and keeps the trailer in step', () => {
    const img = image()
    const doc = d.decode(img)
    doc.roamChannels[0] = { ...doc.roamChannels[0]!, name: 'HILLTOP', colorCode: 7, timeSlot: 2 }
    const out = d.encode(doc, img)
    const back = d.decode(out).roamChannels[0]!
    expect(back.name).toBe('HILLTOP')
    expect(back.colorCode).toBe(7)
    expect(back.timeSlot).toBe(2)
    expect(page(out, ROAMCHANNEL_BLOCK)[ROAMCHANNEL_COUNT_AT]).toBe(3)
  })

  it('touches only the low bits of the two flag bytes', () => {
    const img = image()
    const data = page(img, ROAMCHANNEL_BLOCK)
    data[0x18] = 0xf3 // colour code 3, high nibble set
    data[0x19] = 0xfe // slot 1, high bits set
    const doc = d.decode(img)
    doc.roamChannels[0] = { ...doc.roamChannels[0]!, colorCode: 5, timeSlot: 2 }
    const out = page(d.encode(doc, img), ROAMCHANNEL_BLOCK)
    expect(out[0x18]! >> 4, 'the unexplained high nibble').toBe(0xf)
    expect(out[0x18]! & 0x0f).toBe(5)
    expect(out[0x19]! >> 1, 'the unexplained high bits').toBe(0x7f)
    expect(out[0x19]! & 1).toBe(1)
  })

  it('never claims the fourteen bytes after the count trailer', () => {
    const claimed = d.ownedRanges(logicalAddress(ROAMCHANNEL_BLOCK))
    for (let i = ROAMCHANNEL_COUNT_AT + 1; i < PAGE_SIZE; i++) {
      expect(claimed.some(([a, b]) => i >= a && i < b), `byte 0x${i.toString(16)}`).toBe(false)
    }
  })
})

describe('the structures decoded but never written', () => {
  it('reads the eight digital emergency systems', () => {
    const cp = d.decode(image())
    expect(cp.emergency).toHaveLength(8)
    expect(cp.emergency[0]!.name).toBe('DEmer 1')
    expect(cp.emergency[7]!.name).toBe('DEmer 8')
  })

  it('shares its page with the key slots without disturbing them', () => {
    // Block 0x10 holds the emergency systems at 0x000 and the keys at 0x300.
    // Editing a key must not move an emergency byte, and the reverse.
    const img = image()
    const doc = d.decode(img)
    doc.encryptionKeys[0] = { ...doc.encryptionKeys[0]!, keyHex: 'AB'.repeat(32) }
    const out = d.encode(doc, img)
    const from = EMERGENCY_SLOTS * EMERGENCY_SIZE
    expect(equalBytes(page(out, KEY_BLOCK).subarray(0, from), page(img, KEY_BLOCK).subarray(0, from))).toBe(true)

    const doc2 = d.decode(img)
    doc2.emergency[0] = { ...doc2.emergency[0]!, name: 'RENAMED' }
    const out2 = d.encode(doc2, img)
    expect(d.decode(out2).emergency[0]!.name).toBe('RENAMED')
    expect(
      equalBytes(page(out2, KEY_BLOCK).subarray(KEY_AREA[0]), page(img, KEY_BLOCK).subarray(KEY_AREA[0])),
      'renaming an emergency system moved a key slot',
    ).toBe(true)
  })

  it('writes only the name of an emergency system', () => {
    // Every field past the name is DERIVED, and all eight records here hold
    // factory defaults byte-identical to a capture of a different unit.
    const img = image()
    const doc = d.decode(img)
    doc.emergency[0] = { ...doc.emergency[0]!, name: 'AB', alarmType: 9, alarmMode: 9, revertChannel: 99 }
    const out = d.encode(doc, img)
    const rec = page(out, KEY_BLOCK).subarray(0, EMERGENCY_SIZE)
    const was = page(img, KEY_BLOCK).subarray(0, EMERGENCY_SIZE)
    expect(equalBytes(rec.subarray(8), was.subarray(8)), 'a derived field was written').toBe(true)
  })

  it('reads the DTMF codes and both analog contact lists', () => {
    const a = d.decode(image()).analog!
    // 0x0E is a symbol in the middle of a code, not a terminator: the first
    // slot is 04 05 06 0e 01 02 03 ff.
    expect(a.dtmfCodes[0]).toBe('456*123')
    expect(a.dtmfCodes).toHaveLength(6)
    expect(a.dtmfSpecialCodes).toHaveLength(4)
    expect(a.contacts).toHaveLength(7)
    expect(a.contacts[0]).toBe('AContact 1')
    expect(a.bdcContacts).toHaveLength(10)
    expect(a.bdcContacts[0]!.name).toBe('BDC Cotnacts 1')
    expect(a.bdcContacts[0]!.number).toBe(1)
  })

  it('round-trips the analog block untouched', () => {
    const img = image()
    const out = d.encode(d.decode(img), img)
    expect(equalBytes(page(out, ANALOG_BLOCK), page(img, ANALOG_BLOCK))).toBe(true)
  })

  it('writes a DTMF code back in the radio’s own encoding', () => {
    const img = image()
    const doc = d.decode(img)
    doc.analog!.dtmfCodes[0] = '99#12'
    const out = d.encode(doc, img)
    expect(d.decode(out).analog!.dtmfCodes[0]).toBe('99#12')
    // One digit per byte, 0xFF ends it and fills the rest of the slot.
    expect([...page(out, ANALOG_BLOCK).subarray(0, 7)]).toEqual([9, 9, 0x0f, 1, 2, 0xff, 0xff])
  })

  it('writes both contact lists, and the MDC number as BCD', () => {
    const img = image()
    const doc = d.decode(img)
    doc.analog!.contacts[0] = 'RENAMED'
    doc.analog!.bdcContacts[0] = { name: 'MDC ONE', number: 42 }
    const back = d.decode(d.encode(doc, img)).analog!
    expect(back.contacts[0]).toBe('RENAMED')
    expect(back.bdcContacts[0]).toEqual({ name: 'MDC ONE', number: 42 })
    expect(page(d.encode(doc, img), ANALOG_BLOCK)[BDC_BASE + 0x10], 'stored as BCD').toBe(0x42)
  })

  it('refuses an MDC number wider than the two digits stored', () => {
    const img = image()
    const doc = d.decode(img)
    doc.analog!.bdcContacts[0] = { ...doc.analog!.bdcContacts[0]!, number: 250 }
    expect(() => d.encode(doc, img)).toThrow(/two BCD digits/)
  })

  it('never claims the DTMF settings record', () => {
    // Of its sixteen bytes the reference names four, disagrees with the
    // hardware on one, and marks the rest unknown.
    const claimed = d.ownedRanges(logicalAddress(ANALOG_BLOCK), image())
    for (let i = 0x100; i < DTMF_SPECIAL_BASE; i++) {
      expect(claimed.some(([a, b]) => i >= a && i < b), `byte 0x${i.toString(16)}`).toBe(false)
    }
  })

  it('writes a roaming zone name and leaves its header alone', () => {
    const img = image()
    const doc = d.decode(img)
    doc.roamZones[0] = { ...doc.roamZones[0]!, name: 'HILLTOPS' }
    const out = d.encode(doc, img)
    expect(d.decode(out).roamZones[0]!.name).toBe('HILLTOPS')
    // The count and the fifteen bytes beside it are the radio's.
    expect(equalBytes(page(out, ROAMZONE_BLOCK).subarray(0, 0x10), page(img, ROAMZONE_BLOCK).subarray(0, 0x10))).toBe(true)
    // And the member area of the record it renamed.
    const memberAt = 0x10 + 0x10
    expect(
      equalBytes(page(out, ROAMZONE_BLOCK).subarray(memberAt, 0x10 + 33), page(img, ROAMZONE_BLOCK).subarray(memberAt, 0x10 + 33)),
      'membership was written',
    ).toBe(true)
  })
})

describe('the BDC contact number is BCD', () => {
  it('reads contact 10 as ten, not sixteen', () => {
    // Nine of this radio's ten records read 01-09, where hex and decimal
    // coincide and nothing is settled. The tenth holds 0x10 against a name
    // ending "10", which a plain byte read turns into 16.
    const a = d.decode(image()).analog!
    expect(a.bdcContacts.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(a.bdcContacts[9]!.name).toBe('BDC Cotnacts 10')
  })

  it('is the byte the radio actually holds', () => {
    const data = page(image(), ANALOG_BLOCK)
    expect(data[BDC_BASE + 9 * BDC_SIZE + 0x10], 'the tenth record’s number byte').toBe(0x10)
  })
})

describe('the two VFOs', () => {
  it('decodes them as the channel records they are', () => {
    const cp = d.decode(image())
    expect(cp.vfo.a, 'VFO A').toBeTruthy()
    expect(cp.vfo.b, 'VFO B').toBeTruthy()
    // 462.63700 analog, 432.02750 digital on this radio.
    expect(cp.vfo.a!.rxFreq).toBe(462_637_00 * 10)
    expect(cp.vfo.a!.modulation).toBe('FM')
    expect(cp.vfo.b!.rxFreq).toBe(432_027_50 * 10)
    expect(cp.vfo.b!.modulation).toBe('DMR')
    expect(cp.vfo.b!.extras.vendor?.colorCode).toBe('1')
  })

  it('is pinned by geometry, not by the frequency', () => {
    // Starting a byte later decodes the same frequency and runs VFO B over the
    // block id byte. That is what settles an offset the bytes alone cannot.
    expect(VFO_B + CHANNEL_SIZE, 'VFO B must end exactly on the id byte').toBe(PAGE_SIZE - 1)
    expect(VFO_A + CHANNEL_SIZE).toBe(VFO_B)
  })

  it('keeps them out of the channel bank', () => {
    // Nothing counts them and no zone can point at one, so they must not
    // appear among the channels.
    const cp = d.decode(image())
    expect(cp.channels.has(4001)).toBe(false)
    expect(cp.channels.has(4002)).toBe(false)
  })

  it('round-trips untouched', () => {
    const img = image()
    const out = d.encode(d.decode(img), img)
    expect(equalBytes(page(out, VFO_BLOCK), page(img, VFO_BLOCK))).toBe(true)
  })

  it('writes a VFO without disturbing its neighbour', () => {
    const img = image()
    const doc = d.decode(img)
    doc.vfo = { ...doc.vfo, a: { ...doc.vfo.a!, rxFreq: hz(446_006_25 * 10), tx: { kind: 'simplex' } } }
    const out = d.encode(doc, img)
    const back = d.decode(out)
    expect(back.vfo.a!.rxFreq).toBe(446_006_25 * 10)
    expect(back.vfo.b).toEqual(doc.vfo.b)
    // And the block id byte, which VFO B ends against.
    expect(page(out, VFO_BLOCK)[PAGE_SIZE - 1]).toBe(page(img, VFO_BLOCK)[PAGE_SIZE - 1])
  })

  it('no channel record can reach the VFO area', () => {
    // Block 0x41 is both the last channel block and the VFO block. The
    // reference warns that a codeplug large enough to fill every channel block
    // writes records straight over the VFOs - true of an implementation that
    // allows 4079 channels, and the reason this one stops at 4000.
    let highest = -1
    for (let n = 1; n <= 4000; n++) {
      const at = channelSlot(n)
      if (at?.blockId === VFO_BLOCK) highest = Math.max(highest, at.offset + CHANNEL_SIZE)
    }
    expect(highest, 'no channel lands in the VFO block at all').toBeGreaterThan(0)
    expect(highest, 'a channel record overlaps VFO A').toBeLessThanOrEqual(VFO_A)
  })
})

describe('adding and removing zones', () => {
  const count = (img: RadioImage) => page(img, ZONE_BLOCK_FIRST)[0]

  it('leaves the count alone when nothing was added or removed', () => {
    const img = image()
    expect(count(d.encode(d.decode(img), img))).toBe(count(img))
  })

  it('adds a zone and moves the count', () => {
    const img = image()
    const doc = d.decode(img)
    const was = doc.zones.length
    doc.zones.push({ id: 'zone-new', name: 'NEW ZONE', channels: [...doc.channels.keys()].slice(0, 2) })
    const out = d.encode(doc, img)
    expect(count(out)).toBe(was + 1)
    const back = d.decode(out).zones
    expect(back).toHaveLength(was + 1)
    expect(back[was]!.name).toBe('NEW ZONE')
    expect(back[was]!.channels).toHaveLength(2)
  })

  it('removes a zone without shuffling the ones after it', () => {
    const img = image()
    const doc = d.decode(img)
    const names = doc.zones.map((z) => z.name)
    doc.zones.splice(1, 1)
    const back = d.decode(d.encode(doc, img)).zones
    expect(back.map((z) => z.name)).toEqual([names[0], names[2], names[3]])
  })

  it('never writes the fifteen header bytes beside the count', () => {
    // One of them moved on its own between two captures of this radio, which
    // is how we know they are live state rather than padding.
    const img = image()
    const doc = d.decode(img)
    doc.zones.push({ id: 'zone-new', name: 'X', channels: [] })
    const out = d.encode(doc, img)
    expect(equalBytes(page(out, ZONE_BLOCK_FIRST).subarray(1, ZONE_HEADER), page(img, ZONE_BLOCK_FIRST).subarray(1, ZONE_HEADER))).toBe(true)
  })

  it('refuses more zones than the radio has slots for', () => {
    const img = image()
    const doc = d.decode(img)
    while (doc.zones.length < 300) doc.zones.push({ id: `z${doc.zones.length}`, name: 'X', channels: [] })
    expect(() => d.encode(doc, img)).toThrow(/zones/)
  })
})

describe('adding and removing talk groups', () => {
  it('places each at its own slot, gaps included', () => {
    // This radio's bank has gaps: slots 2, 5, 8 and 9 hold wiped records that
    // keep their call type, and a channel's TX contact points at a slot number.
    const img = image()
    const index = decodeTalkGroupIndex(img)!
    expect(index.live).toEqual([1, 3, 4, 6, 7, 10])
    const out = d.encode(d.decode(img), img)
    expect(decodeTalkGroupIndex(out)!.live).toEqual(index.live)
  })

  it('adds a talk group into the lowest free slot', () => {
    const img = image()
    const doc = d.decode(img)
    const was = doc.talkGroups.length
    doc.talkGroups.push({ id: 'tg-new', name: 'ADDED', number: 4242, callType: 'group' })
    const out = d.encode(doc, img)
    const back = d.decode(out)
    expect(back.talkGroups).toHaveLength(was + 1)
    expect(back.talkGroups.find((g) => g.name === 'ADDED')?.number).toBe(4242)
    // Slot 2 was the lowest wiped one.
    expect(decodeTalkGroupIndex(out)!.live).toContain(2)
  })

  it('removes a talk group and leaves the rest where they were', () => {
    const img = image()
    const doc = d.decode(img)
    const keep = doc.talkGroups.filter((g) => g.name !== 'ARKANSAS')
    doc.talkGroups = keep
    const out = d.encode(doc, img)
    expect(d.decode(out).talkGroups.map((g) => g.name)).toEqual(keep.map((g) => g.name))
    // ARKANSAS was slot 3; that slot is now free and the others have not moved.
    expect(decodeTalkGroupIndex(out)!.live).toEqual([1, 4, 6, 7, 10])
  })

  it('keeps the index consistent with the bank it describes', () => {
    const img = image()
    const doc = d.decode(img)
    doc.talkGroups.push({ id: 'tg-new', name: 'AAA FIRST', number: 1, callType: 'group' })
    const out = d.encode(doc, img)

    const index = decodeTalkGroupIndex(out)!
    const groups = d.decode(out).talkGroups
    // Count, bitmask popcount and both table lengths all agree.
    expect(page(out, 0x0b)[0]! | (page(out, 0x0b)[1]! << 8)).toBe(groups.length)
    expect(index.live).toHaveLength(groups.length)
    expect(index.byName).toHaveLength(groups.length)
    expect([...index.byName].sort((a, b) => a - b)).toEqual(index.live)
  })

  it('sorts the name table byte-wise, which is not case-insensitively', () => {
    const img = image()
    const doc = d.decode(img)
    // 'a' (0x61) sorts after 'Z' (0x5a) byte-wise, and before it if folded.
    doc.talkGroups.push({ id: 'tg-l', name: 'aaa', number: 11, callType: 'group' })
    doc.talkGroups.push({ id: 'tg-u', name: 'ZZZ', number: 12, callType: 'group' })
    const out = d.encode(doc, img)

    const slots = decodeTalkGroupIndex(out)!.byName
    const bySlot = new Map(d.decode(out).talkGroups.map((g) => [Number(/-(\d+)$/.exec(g.id)![1]), g.name]))
    const order = slots.map((s) => bySlot.get(s)).filter(Boolean) as string[]
    expect(order.indexOf('ZZZ')).toBeLessThan(order.indexOf('aaa'))
  })

  it('round-trips the index untouched when nothing changed', () => {
    const img = image()
    const out = d.encode(d.decode(img), img)
    expect(equalBytes(page(out, 0x0b), page(img, 0x0b))).toBe(true)
  })

  it('refuses more talk groups than the index can address', () => {
    const img = image()
    const doc = d.decode(img)
    while (doc.talkGroups.length < 200) {
      doc.talkGroups.push({ id: `t${doc.talkGroups.length}`, name: 'X', number: 1, callType: 'group' })
    }
    expect(() => d.encode(doc, img)).toThrow(/talk groups/)
  })
})

describe('the block 0x03 call list', () => {
  it('decodes the six records this radio and the reference both hold', () => {
    const cp = d.decode(image())
    expect(cp.callList.map((c) => c.name)).toEqual(['Call 1', 'Call 2', 'Call 3', 'Call 4', 'Call 5', ''])
  })

  it('counts a record with a name but no marker, and one with a marker but no name', () => {
    // Record 0 reads FF FF and is named; record 5 reads FE FF and is not. Either
    // test alone loses one of them, which is why occupancy needs both.
    const cp = d.decode(image())
    expect(cp.callList[0]).toMatchObject({ name: 'Call 1', inUse: false })
    expect(cp.callList[5]).toMatchObject({ name: '', inUse: true })
  })

  it('reads the names as UTF-16LE, which no other block uses', () => {
    const data = page(image(), CALLLIST_BLOCK)
    const at = CALLLIST_BASE + CALLLIST_NAME_AT
    // 'C' then a zero high byte: single-byte ASCII would put '\0' at at+1.
    expect(data[at]).toBe('C'.charCodeAt(0))
    expect(data[at + 1]).toBe(0)
    expect(data[at + 2]).toBe('a'.charCodeAt(0))
  })

  it('carries the two reference values without interpreting them', () => {
    const cp = d.decode(image())
    const pairs = cp.callList.filter((c) => c.inUse).map((c) => [c.referenceA, c.referenceB])
    expect(new Set(pairs.flat())).toEqual(new Set([0x0c91, 0x2441, 0x17ca, 0x4fd6]))

    /*
     * Five distinct pairs from four values - not six.
     *
     * The reference reads this as "the six populated entries enumerate every
     * unordered pair (C(4,2) = 6)", and its own captured table does not support
     * it: only five records carry references, and (0x17CA, 0x4FD6) is absent.
     * This radio agrees with the table rather than with the sentence.
     */
    expect(pairs).toHaveLength(5)
    const key = (p: number[]) => [...p].sort((a, b) => a - b).join(',')
    expect(new Set(pairs.map(key)).size).toBe(5)
    expect(pairs.map(key)).not.toContain(key([0x17ca, 0x4fd6]))
  })

  it('writes a name back as UTF-16LE and leaves the references alone', () => {
    const img = image()
    const doc = d.decode(img)
    doc.callList[1] = { ...doc.callList[1]!, name: 'Wide' }
    const out = page(d.encode(doc, img), CALLLIST_BLOCK)
    const off = CALLLIST_BASE + CALLLIST_SIZE
    expect(DM32_CALLLIST.read(out, off).name).toBe('Wide')
    expect(DM32_CALLLIST.read(out, off).referenceA).toBe(0x0c91)
    expect(DM32_CALLLIST.read(out, off).referenceB).toBe(0x2441)
    expect(out[off]).toBe(0xfe) // the in-use marker is not ours either
    // The shortened name must not leave the tail of the old one behind.
    const tail = out.subarray(off + CALLLIST_NAME_AT + 8, off + CALLLIST_NAME_AT + 12)
    expect([...tail]).toEqual([0, 0, 0, 0])
  })

  it('renames the record its id names, not the nth listed one', () => {
    const img = image()
    const doc = d.decode(img)
    doc.callList = doc.callList.filter((c) => c.id !== 'call-2')
    doc.callList[1] = { ...doc.callList[1]!, name: 'Third' }
    const out = page(d.encode(doc, img), CALLLIST_BLOCK)
    const nameAt = (n: number) => DM32_CALLLIST.read(out, CALLLIST_BASE + n * CALLLIST_SIZE).name
    expect(nameAt(1)).toBe('Call 2') // dropped from the doc, left on the radio
    expect(nameAt(2)).toBe('Third')
  })

  it('round-trips the block untouched', () => {
    const img = image()
    const out = d.encode(d.decode(img), img)
    expect(equalBytes(page(out, CALLLIST_BLOCK), page(img, CALLLIST_BLOCK))).toBe(true)
  })

  it('stops where the records stop, not where the page or the reference does', () => {
    // The reference says 92, which does not fit in a 4 KiB page at all.
    expect(CALLLIST_BASE + 92 * CALLLIST_SIZE).toBeGreaterThan(0x1000)
    // Filling the page would give 88, and that overruns the records too.
    expect(CALLLIST_SLOTS).toBe(32)
    expect(CALLLIST_END).toBe(0x718)

    // What is actually at 0x718: DTMF digit runs and two plain single-byte
    // ASCII words. Neither is anything a call record can contain, and the
    // 88-slot reading claimed all of it as name fields.
    const data = page(image(), CALLLIST_BLOCK)
    const text = new TextDecoder('latin1').decode(data.subarray(CALLLIST_END, 0xfff))
    expect(text).toContain('Disable')
    expect(text).toContain('Enable')

    // And nothing this driver claims reaches past the records.
    for (const [, end] of d.ownedRanges(logicalAddress(CALLLIST_BLOCK), image())) {
      expect(end).toBeLessThanOrEqual(CALLLIST_END)
    }
  })

  it('does not read the structure after the records as records', () => {
    // Read as call records, 0x718 onward yields names of U+FFFF runs and
    // "reference values" that are the letters of "Disable". None of it appears.
    const names = d.decode(image()).callList.map((c) => c.name)
    for (const name of names) expect(name).toMatch(/^[\x20-\x7e]*$/)
    expect(d.decode(image()).callList).toHaveLength(6)
  })
})
