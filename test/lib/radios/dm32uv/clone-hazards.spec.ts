// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { diffImages } from '#core/radio/diff.js'
import { transplantCodeplug } from '#core/radio/transplant.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver, encodeContacts } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'

/**
 * The three ways a club codeplug used to go wrong on this radio.
 *
 * All of them come from the same shape: `transplantCodeplug` replaces whole
 * collections, and this is the only driver whose schema declares enough
 * features for that to move more than the channel bank. Every one was found by
 * reading the clone path rather than by using it, which is the point - none of
 * them announces itself.
 */
const BLOB = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.blocks.bin', import.meta.url))),
)
const INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/dm32uv-DM32.01.01.040.index.json', import.meta.url)), 'utf8'),
) as { firmware: string; model: string; blocks: { id: number; physical: number; offset: number }[] }

function image(): RadioImage {
  return {
    radioId: 'dm32uv', variant: INDEX.firmware, layout: INDEX.model,
    createdAt: '2026-08-21T00:00:00.000Z', sha256: '',
    meta: { placements: INDEX.blocks.map((b) => ({ blockId: b.id, physical: b.physical })) },
    regions: INDEX.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: BLOB.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
  }
}

const d = createDm32uvDriver({ enableWrite: true })
const NOW = '2026-08-21T00:00:00.000Z'
const clone = (donor: ReturnType<typeof d.decode>, recipient: ReturnType<typeof d.decode>) =>
  transplantCodeplug({ donor, recipient, schema: d.schema, now: NOW }).codeplug

describe('a donor with fewer talk groups than your radio', () => {
  it('reads as an erase, not as a defect in boofwang', () => {
    // The index tables were cleared out to the count the radio had before the
    // write, while `ownedRanges` was sized from the count it has after. Every
    // shrink therefore moved bytes outside the claim, and the write gate says
    // that is a bug in boofwang and refuses the whole clone - channels and all.
    const base = image()
    const recipient = d.decode(base)
    expect(recipient.talkGroups.length).toBeGreaterThan(3)

    for (const count of [0, 1, 3, 5]) {
      const donor = d.decode(image())
      donor.talkGroups = donor.talkGroups.slice(0, count)
      const diff = diffImages(base, d.encode(clone(donor, recipient), base), d)
      expect(diff.changedBytes, `donor with ${count} talk groups changed nothing`).toBeGreaterThan(0)
      expect(diff.unowned, `donor with ${count} talk groups reported a defect in boofwang`).toEqual([])
    }
  })
})

describe('a donor whose channels name a DMR radio ID you do not have', () => {
  /** A club member who keeps three identities and puts his channels on the second. */
  function threeIdDonor(recipient: ReturnType<typeof d.decode>) {
    const donor = d.decode(image())
    const mine = recipient.radioIds[0]!
    donor.radioIds = [
      { ...mine, name: 'Personal' },
      { ...mine, id: 'rid-2', name: 'Club', dmrId: 3_100_002 },
      { ...mine, id: 'rid-3', name: 'Hotspot', dmrId: 3_100_003 },
    ]
    for (const [slot, ch] of donor.channels) {
      donor.channels.set(slot, {
        ...ch,
        extras: { ...ch.extras, vendor: { ...ch.extras.vendor, radioIdIndex: '1' } },
      })
    }
    return donor
  }

  it('says so, rather than leaving it to the people listening', () => {
    const recipient = d.decode(image())
    expect(recipient.radioIds).toHaveLength(1)

    const merged = clone(threeIdDonor(recipient), recipient)
    const warned = d.validate(merged).filter((x) => x.ruleId === 'dmr.radio-id.missing')

    expect(warned.length).toBe(merged.channels.size)
    expect(warned[0]!.message).toContain('your radio has 1')
  })

  it('falls back to your own ID instead of transmitting without one', () => {
    // The radio does not refuse an index past the end of its bank. It keys up
    // with no valid DMR ID, which the operator cannot see and everyone else can.
    const base = image()
    const recipient = d.decode(base)
    const merged = clone(threeIdDonor(recipient), recipient)

    const written = new Set(
      [...d.decode(d.encode(merged, base)).channels.values()].map((c) => c.extras.vendor?.radioIdIndex),
    )
    expect([...written]).toEqual(['0'])
  })

  it('leaves a valid pick alone', () => {
    const base = image()
    const recipient = d.decode(base)
    const donor = threeIdDonor(recipient)
    const merged = transplantCodeplug({
      donor, recipient, schema: d.schema, now: NOW, copyRadioIds: true,
    }).codeplug

    // Three IDs came across too, so index 1 is a real one and stays.
    expect(d.validate(merged).filter((x) => x.ruleId === 'dmr.radio-id.missing')).toEqual([])
    const written = new Set(
      [...d.decode(d.encode(merged, base)).channels.values()].map((c) => c.extras.vendor?.radioIdIndex),
    )
    expect([...written]).toEqual(['1'])
  })
})

describe('a donor carrying more contacts than your radio was read with', () => {
  it('refuses instead of reporting a write that left the address book empty', () => {
    // A read produces no contact pages when the radio answers the address-book
    // V-frame with a null range, or reports more contacts than its region
    // holds. `encodeContacts` used to return quietly, so the dialog said the
    // contacts came across, the write reported success, and the book was empty.
    const base = image()
    const contacts = Array.from({ length: 120 }, (_, i) => ({
      id: `c${i}`, name: `Member ${i}`, dmrId: 3_100_000 + i,
      callsign: '', city: '', province: '', country: '', remark: '',
    }))
    expect(() => encodeContacts(base, contacts)).toThrow(/nowhere to put/)
  })

  it('says nothing when there is nothing to put anywhere', () => {
    expect(() => encodeContacts(image(), [])).not.toThrow()
  })

  it('does not tell you to read the radio again, which cannot help', () => {
    // The read brings back the pages your own contacts fill plus one spare, so
    // reading again returns the same number every time. The old message sent
    // people round that loop.
    const base = image()
    const page = { start: 0x278000, data: new Uint8Array(PAGE_SIZE).fill(0xff), label: 'contacts page 1' }
    const withBook: RadioImage = { ...base, regions: [...base.regions, page] }
    const tooMany = Array.from({ length: 200 }, (_, i) => ({
      id: `c${i}`, name: `Member ${i}`, dmrId: 3_100_000 + i,
      callsign: '', city: '', province: '', country: '', remark: '',
    }))

    expect(() => encodeContacts(withBook, tooMany)).toThrow(/will not make room/)
    expect(() => encodeContacts(withBook, tooMany)).not.toThrow(/Read the radio again/)
  })
})
