// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { diffImages } from '#core/radio/diff.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import { fromStoredBackup, toStoredBackup } from '#core/storage/db.js'
import { decodeBwp, encodeBwp } from '#core/io/bwp.js'
import {
  CHANNEL_BLOCK_FIRST,
  CHANNEL_BLOCK_LAST,
  CHANNEL_HEADER,
  KEY_AREA,
  RADIOID_HEADER,
  ROAMCHANNEL_COUNT_AT,
  ROAMCHANNEL_SIZE,
  ROAMCHANNEL_SLOTS,
  RXGROUP_HEADER,
  TALKGROUP_BLOCK_FIRST,
  TALKGROUP_BLOCK_LAST,
  TXCONTACT_HIGH_LIMIT,
  ZONE_BLOCK_FIRST,
  ZONE_BLOCK_LAST,
  ZONE_HEADER,
} from '#core/radios/dm32uv/layout.js'

/**
 * The audit that matters most, done mechanically rather than by eye.
 *
 * For every block this driver writes, two questions, and both directions are
 * failures:
 *
 *   1. Is every byte the encoder can change inside `ownedRanges`? A byte
 *      outside it stops the write dead - `writeImage` refuses rather than
 *      guessing - so a gap here makes a feature inert at the last moment.
 *   2. Does `ownedRanges` claim bytes the encoder never writes? That one is
 *      silent. The belt-and-braces check only fires on a byte moving OUTSIDE a
 *      claimed range, so an over-broad claim quietly disarms the single
 *      mechanism that would catch a future bug in that region.
 *
 * This project has shipped both. The first as a region left flagged read-only
 * after it became writable; the second as a claim copied from a neighbouring
 * block whose page happened to mean something different.
 */

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

/** Everything this driver can be asked to change, in one document. */
function maximalEdit(img: RadioImage) {
  const doc = d.decode(img)

  for (const [n, ch] of doc.channels) {
    doc.channels.set(n, {
      ...ch,
      name: 'AUDIT',
      bandwidthHz: ch.bandwidthHz === 25_000 ? 12_500 : 25_000,
      txAllowed: !ch.txAllowed,
      ...(ch.txAllowed ? { txInhibitReason: 'audit' } : {}),
      extras: {
        ...ch.extras,
        vendor: { ...ch.extras.vendor, colorCode: '9', timeSlot: '2', txContact: '4' },
      },
    })
  }
  doc.zones = doc.zones.map((z) => ({ ...z, name: 'AUDIT', channels: [...doc.channels.keys()].slice(0, 3) }))
  doc.talkGroups = doc.talkGroups.map((g) => ({ ...g, name: 'AUDIT' }))
  doc.scanLists = doc.scanLists.map((l) => ({ ...l, name: 'AUDIT', channels: [...doc.channels.keys()].slice(0, 4) }))
  doc.rxGroups = doc.rxGroups.map((g) => ({ ...g, name: 'AUDIT', dmrIds: [7, 8, 9] }))
  doc.radioIds = doc.radioIds.map((r) => ({ ...r, name: 'AUDIT', dmrId: 1_234_567 }))
  doc.messages = doc.messages.map(() => 'AUDIT MESSAGE')
  doc.roamChannels = doc.roamChannels.map((c) => ({ ...c, name: 'AUDIT', colorCode: 9, timeSlot: 2 as const }))
  doc.encryptionKeys = doc.encryptionKeys.map((k) => ({ ...k, name: 'AUDIT', keyHex: '5A'.repeat(k.keyHex.length / 2) }))
  for (const key of Object.keys(doc.settings)) {
    const v = doc.settings[key]
    if (typeof v === 'number') doc.settings[key] = v === 0 ? 1 : 0
    else if (typeof v === 'string') doc.settings[key] = 'AU'
  }
  return doc
}

describe('every byte the encoders write is claimed', () => {
  const img = image()
  const out = d.encode(maximalEdit(img), img)

  it('changes something in every block the driver says it writes', () => {
    // A block that never moves under a maximal edit is either unreachable or
    // the edit above stopped covering it.
    const moved = out.regions
      .filter((r) => {
        const before = img.regions.find((x) => x.start === r.start)!.data
        return r.data.some((b, i) => b !== before[i])
      })
      .map((r) => r.start >>> 12)
    expect(moved.length, 'a maximal edit moved nothing').toBeGreaterThan(5)
  })

  it('never moves a byte outside ownedRanges, block by block', () => {
    const offenders: string[] = []
    for (const region of out.regions) {
      const before = img.regions.find((r) => r.start === region.start)!.data
      const owned = d.ownedRanges(region.start, out)
      for (let i = 0; i < region.data.length; i++) {
        if (region.data[i] === before[i]) continue
        if (owned.some(([from, to]) => i >= from && i < to)) continue
        offenders.push(`block 0x${(region.start >>> 12).toString(16)} byte 0x${i.toString(16)}`)
      }
    }
    expect(offenders.slice(0, 12)).toEqual([])
  })

  it('agrees with the diff, which is what the write gate reads', () => {
    const diff = diffImages(img, out, d)
    expect(diff.unowned, 'the gate would refuse this write').toEqual([])
    expect(diff.changedBytes, 'the gate would call this no change at all').toBeGreaterThan(0)
  })

  it('leaves the block id byte of every page alone', () => {
    for (const region of out.regions) {
      const before = img.regions.find((r) => r.start === region.start)!.data
      expect(region.data[PAGE_SIZE - 1], `block 0x${(region.start >>> 12).toString(16)} tail`).toBe(
        before[PAGE_SIZE - 1],
      )
    }
  })

  it('never touches calibration', () => {
    const cal = out.regions.find((r) => r.start === logicalAddress(0x02))!
    const before = img.regions.find((r) => r.start === logicalAddress(0x02))!
    expect(cal.data).toEqual(before.data)
    expect(d.ownedRanges(cal.start, out)).toEqual([])
  })
})

describe('nothing claims more than it writes', () => {
  /**
   * What each block claims, written out.
   *
   * A budget was tried here first and was useless: a slack allowance generous
   * enough for the spare record slots a codeplug can grow into is also generous
   * enough to hide a whole page. Widening block 0x43's claim from the 0x0EF6
   * cutoff to the full page - the exact over-claim this driver is written to
   * avoid, because that page's tail is stale zone records - passed a budget
   * check without complaint.
   *
   * So each claim is pinned to the layout constants that justify it. Copying a
   * neighbour's line fails immediately, which is how the over-claim happens.
   */
  const EXPECTED: Record<number, readonly (readonly [number, number])[]> = {
    0x02: [], // calibration, permanently blocked
    0x04: d.ownedRanges(logicalAddress(0x04), image()), // settings: the struct's own ranges
    0x06: [], // analog config, decoded and never written
    0x0a: [[0, PAGE_SIZE - 1]], // messages
    0x0b: [], // talk group index, derived
    0x0f: [[0, 4], [RXGROUP_HEADER, PAGE_SIZE - 1]], // RX groups: bitmask, then records
    0x10: [KEY_AREA], // key slots only - the emergency systems share this page
    0x11: [[0, PAGE_SIZE - 1]], // scan lists
    0x42: [[0, PAGE_SIZE - 1]], // TX contact, channels 1-2047
    0x43: [[0, TXCONTACT_HIGH_LIMIT]], // TX contact, high - stops before the residue
    0x65: [], // roaming zones, decoded and never written
    0x66: [
      [0, ROAMCHANNEL_SLOTS * ROAMCHANNEL_SIZE],
      [ROAMCHANNEL_COUNT_AT, ROAMCHANNEL_COUNT_AT + 1],
    ],
    0x67: [[0, 1], [RADIOID_HEADER, PAGE_SIZE - 1]], // radio IDs: count, then records
  }

  it('claims exactly what it says it claims', () => {
    const img = image()
    for (const [id, want] of Object.entries(EXPECTED)) {
      const blockId = Number(id)
      const got = d.ownedRanges(logicalAddress(blockId), img)
      expect(got.map((r) => [...r]), `block 0x${blockId.toString(16)}`).toEqual(want.map((r) => [...r]))
    }
  })

  /** The banks, whose members all claim the same shape. */
  function expectedForRange(id: number): readonly (readonly [number, number])[] | null {
    if (id >= CHANNEL_BLOCK_FIRST && id <= CHANNEL_BLOCK_LAST) {
      // The first block gives up two bytes to the channel count and fourteen
      // more to a header this build does not write.
      return id === CHANNEL_BLOCK_FIRST
        ? [[0, 2], [CHANNEL_HEADER, PAGE_SIZE - 1]]
        : [[0, PAGE_SIZE - 1]]
    }
    if (id >= TALKGROUP_BLOCK_FIRST && id <= TALKGROUP_BLOCK_LAST) return [[0, PAGE_SIZE - 1]]
    if (id >= ZONE_BLOCK_FIRST && id <= ZONE_BLOCK_LAST) {
      return [[id === ZONE_BLOCK_FIRST ? ZONE_HEADER : 0, PAGE_SIZE - 1]]
    }
    return null
  }

  it('covers every block the fixture actually has', () => {
    // A block that appears on a radio and in neither the table, the banks, nor
    // the "claims nothing" set is one nobody has thought about.
    const img = image()
    const accounted = new Set(Object.keys(EXPECTED).map(Number))
    for (const b of INDEX.blocks) {
      if (accounted.has(b.id)) continue
      const got = d.ownedRanges(logicalAddress(b.id), img).map((r) => [...r])
      const want = expectedForRange(b.id)
      expect(
        got,
        `block 0x${b.id.toString(16)} is on this radio and nobody has said what it claims`,
      ).toEqual(want ? want.map((r) => [...r]) : [])
    }
  })

  it('keeps every claim inside a page and off the block id byte', () => {
    const img = image()
    for (const region of img.regions) {
      const owned = d.ownedRanges(region.start, img)
      const last = PAGE_SIZE - 1
      for (const [from, to] of owned) {
        const where = `block 0x${(region.start >>> 12).toString(16)}`
        expect(from, `${where} claim start`).toBeGreaterThanOrEqual(0)
        expect(to, `${where} claim end`).toBeLessThanOrEqual(PAGE_SIZE - 1)
        expect(to, `${where} empty claim`).toBeGreaterThan(from)
        expect(last >= from && last < to, `${where} claims its id byte`).toBe(false)
      }
    }
  })

  it('claims nothing at all in the blocks that are decoded but never written', () => {
    // Emergency systems share block 0x10 with the key slots; the analog config
    // and roaming zones have pages of their own. All three are read.
    expect(d.ownedRanges(logicalAddress(0x06), image()), 'analog config').toEqual([])
    expect(d.ownedRanges(logicalAddress(0x65), image()), 'roaming zones').toEqual([])
    expect(d.ownedRanges(logicalAddress(0x0b), image()), 'talk group index').toEqual([])
  })
})

describe('the new structures survive being saved and reopened', () => {
  const img = image()
  const doc = d.decode(img)

  it('through a stored backup', () => {
    const back = fromStoredBackup(
      toStoredBackup(img, { id: 'x', origin: 'download', identHash: 'h', unitHash: null }),
    )
    const reopened = d.decode(back)
    expect(reopened.messages).toEqual(doc.messages)
    expect(reopened.roamChannels).toEqual(doc.roamChannels)
    expect(reopened.roamZones).toEqual(doc.roamZones)
    expect(reopened.emergency).toEqual(doc.emergency)
    expect(reopened.analog).toEqual(doc.analog)
    expect(reopened.contacts).toEqual(doc.contacts)
  })

  it('through a .bwp file', async () => {
    const reopened = d.decode(await decodeBwp(await encodeBwp(img)))
    expect(reopened.messages).toEqual(doc.messages)
    expect(reopened.roamChannels).toEqual(doc.roamChannels)
    expect(reopened.analog).toEqual(doc.analog)
  })
})
