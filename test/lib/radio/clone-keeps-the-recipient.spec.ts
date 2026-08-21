// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDriver, SCHEMAS } from '#core/radio/registry.js'
import { cloneImage } from '#core/radio/image.js'
import { transplantCodeplug } from '#core/radio/transplant.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import type { Channel } from '#core/model/channel.js'
import type { RadioId } from '#core/model/index.js'
import type { RadioImage } from '#core/radio/image.js'

/**
 * Cloning a club codeplug onto your own radio must leave your radio yours.
 *
 * `transplantCodeplug` is unit-tested against hand-built documents, which
 * proves the merge picks the right lists. It cannot prove the thing the feature
 * actually rests on, because that property only exists once real bytes are
 * involved: after `encode(doc, base)`, every byte of *your* radio that nobody
 * has decoded - factory calibration, the undocumented runs, whatever the
 * vendor put in the gaps - must still be yours and not the donor's.
 *
 * The donor here is synthetic in one specific way, and it is worth being exact
 * about which. Nobody has two of any of these radios, so the donor is derived
 * from the fixture rather than read from a second unit - but every byte outside
 * the driver's `ownedRanges` is deliberately made to differ. Two physical units
 * can only differ in a *subset* of those bytes, so a donor that differs in all
 * of them is the harder case, not the easier one. What a second radio would add
 * is confirmation that no per-unit byte hides *inside* an owned range; that is
 * a claim about the layout, and it is the drivers' own fixture specs that test
 * it, not this one.
 */

const F = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))))
const J = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url)), 'utf8'))

const CREATED = '2026-08-21T00:00:00.000Z'

function uv5rminiImage(): RadioImage {
  const raw = F('uv5rmini-5RMINI.bin')
  const index = J('uv5rmini-5RMINI.index.json') as { ident4d: string; regions: { start: number; size: number }[] }
  let off = 0
  return {
    radioId: 'uv5rmini', variant: index.ident4d, layout: 'uv5rmini', createdAt: CREATED, meta: {}, sha256: '',
    regions: index.regions.map((r) => {
      const data = raw.slice(off, off + r.size)
      off += r.size
      return { start: r.start, data, label: `0x${r.start.toString(16)}` }
    }),
  }
}

function uv82Image(): RadioImage {
  return {
    radioId: 'uv82', variant: 'N822413', layout: 'uv82', createdAt: CREATED, meta: {}, sha256: '',
    regions: [{ start: 0, data: F('uv82-N822413.bin'), label: 'image' }],
  }
}

function uvk5Image(): RadioImage {
  return {
    radioId: 'uvk5', variant: '2.01.32', layout: 'stock', createdAt: CREATED, meta: {}, sha256: '',
    regions: [{ start: 0, data: F('uvk5-2.01.32.bin'), label: 'eeprom' }],
  }
}

function dm32uvImage(): RadioImage {
  const blob = F('dm32uv-DM32.01.01.040.blocks.bin')
  const index = J('dm32uv-DM32.01.01.040.index.json') as {
    firmware: string; model: string; blocks: { id: number; physical: number; offset: number }[]
  }
  return {
    radioId: 'dm32uv', variant: index.firmware, layout: index.model, createdAt: CREATED, sha256: '',
    meta: { placements: index.blocks.map((b) => ({ blockId: b.id, physical: b.physical })) },
    regions: index.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: blob.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
  }
}

const RADIOS: { id: RadioId; label: string; image: () => RadioImage }[] = [
  { id: 'uv5rmini', label: 'Baofeng UV-5R Mini', image: uv5rminiImage },
  { id: 'uv82', label: 'Baofeng UV-82', image: uv82Image },
  { id: 'uvk5', label: 'Quansheng UV-K5', image: uvk5Image },
  { id: 'dm32uv', label: 'Baofeng DM-32UV', image: dm32uvImage },
]

/** Every byte the driver has not claimed, region by region. */
function unownedOffsets(driver: ReturnType<typeof createDriver>, image: RadioImage, regionIndex: number): number[] {
  const region = image.regions[regionIndex]!
  const owned = driver.ownedRanges(region.start, image)
  const out: number[] = []
  for (let i = 0; i < region.data.length; i++) {
    if (!owned.some(([a, b]) => i >= a && i < b)) out.push(i)
  }
  return out
}

describe.each(RADIOS)('cloning onto a $label', ({ id, image }) => {
  const driver = createDriver(id)
  const schema = SCHEMAS[id]!

  /**
   * A codeplug from another unit of the same model.
   *
   * Every byte this driver does not claim to understand is flipped, so if the
   * merge lets any of the donor's image through, the assertion below sees it.
   */
  function donorFrom(recipient: RadioImage): RadioImage {
    const donor = cloneImage(recipient)
    donor.regions.forEach((region, ri) => {
      for (const i of unownedOffsets(driver, donor, ri)) region.data[i] = region.data[i]! ^ 0x5a
    })
    return donor
  }

  it('keeps every byte of your radio that nobody has decoded', () => {
    const recipient = image()
    const donor = donorFrom(recipient)

    const donorDoc = driver.decode(donor)
    const slots = [...donorDoc.channels.keys()].sort((a, b) => a - b).slice(0, 5)
    for (const slot of slots) {
      const ch = donorDoc.channels.get(slot)!
      donorDoc.channels.set(slot, { ...ch, name: `DONOR${slot}`.slice(0, 8) } as Channel)
    }

    const { codeplug } = transplantCodeplug({
      donor: donorDoc, recipient: driver.decode(recipient), schema, now: CREATED,
    })
    const out = driver.encode(codeplug, recipient)

    const leaked: string[] = []
    out.regions.forEach((region, ri) => {
      const mine = recipient.regions[ri]!
      for (const i of unownedOffsets(driver, out, ri)) {
        if (region.data[i] !== mine.data[i]) leaked.push(`0x${(region.start + i).toString(16)}`)
      }
    })

    expect(leaked.slice(0, 20), `${leaked.length} byte(s) of the donor's image reached the recipient`).toEqual([])
  })

  it('never touches a read-only region', () => {
    const recipient = image()
    const donor = donorFrom(recipient)
    const { codeplug } = transplantCodeplug({
      donor: driver.decode(donor), recipient: driver.decode(recipient), schema, now: CREATED,
    })
    const out = driver.encode(codeplug, recipient)

    for (const [ri, region] of out.regions.entries()) {
      if (region.readOnly !== true) continue
      expect(region.data, `${region.label} is read-only and was modified`).toEqual(recipient.regions[ri]!.data)
    }
  })

  it('actually puts the donor’s channels on the radio', () => {
    const recipient = image()
    const donorDoc = driver.decode(donorFrom(recipient))
    const slots = [...donorDoc.channels.keys()].sort((a, b) => a - b).slice(0, 5)
    expect(slots.length, 'the fixture has no channels to clone').toBeGreaterThan(0)
    for (const slot of slots) {
      donorDoc.channels.set(slot, { ...donorDoc.channels.get(slot)!, name: `DNR${slot}` } as Channel)
    }

    const { codeplug } = transplantCodeplug({
      donor: donorDoc, recipient: driver.decode(recipient), schema, now: CREATED,
    })
    const back = driver.decode(driver.encode(codeplug, recipient))

    for (const slot of slots) expect(back.channels.get(slot)?.name).toBe(`DNR${slot}`)
  })

  it('clears the channels your radio had that the donor does not', () => {
    // The club codeplug is six repeaters; your radio is full. Afterwards the
    // radio holds the club's six and nothing else - a leftover channel from
    // before the clone is a channel nobody chose to have.
    const recipient = image()
    const recipientDoc = driver.decode(recipient)
    const kept = [...recipientDoc.channels.keys()].sort((a, b) => a - b).slice(0, 2)
    expect(kept.length, 'the fixture needs at least two channels').toBe(2)

    const donorDoc = driver.decode(donorFrom(recipient))
    donorDoc.channels = new Map(kept.map((s) => [s, donorDoc.channels.get(s)!]))

    const { codeplug } = transplantCodeplug({ donor: donorDoc, recipient: recipientDoc, schema, now: CREATED })
    const back = driver.decode(driver.encode(codeplug, recipient))

    expect([...back.channels.keys()].sort((a, b) => a - b)).toEqual(kept)
  })
})

/**
 * The two opt-ins, proven through the bytes rather than the document.
 *
 * `transplant.spec.ts` already shows the merge withholds the donor's DMR IDs
 * and key slots unless asked. That is the rule, but it is not yet the outcome:
 * between the merged document and the radio sits `encode`, and a rule that the
 * encoder ignores in either direction is not a rule. Withholding that leaks
 * anyway is the dangerous failure; an opt-in that silently does nothing is the
 * quiet one, and it would leave a fleet believing it had shared its keys.
 *
 * The DM-32UV is the only radio here with either, and its fixture's key slots
 * are redacted - which does not matter, because what is asserted is which of
 * two values came through, not what the value is.
 */
describe('cloning DMR identity onto a Baofeng DM-32UV', () => {
  const driver = createDriver('dm32uv')
  const schema = SCHEMAS.dm32uv!

  function pair() {
    const recipient = dm32uvImage()
    const recipientDoc = driver.decode(recipient)
    const donorDoc = driver.decode(dm32uvImage())

    // Give the donor an identity that is unmistakably not the recipient's.
    donorDoc.radioIds = recipientDoc.radioIds.map((r, i) => ({ ...r, dmrId: 3_100_000 + i, name: `DONOR${i}` }))
    donorDoc.encryptionKeys = recipientDoc.encryptionKeys.map((k, i) =>
      k.keyHex === '' ? { ...k } : { ...k, keyHex: 'AB'.repeat(k.keyHex.length / 2), name: `DKEY${i}` },
    )
    return { recipient, recipientDoc, donorDoc }
  }

  it('leaves your DMR ID alone unless you tick the box', () => {
    const { recipient, recipientDoc, donorDoc } = pair()
    expect(donorDoc.radioIds, 'the fixture carries no radio IDs to withhold').not.toEqual(recipientDoc.radioIds)

    const { codeplug } = transplantCodeplug({ donor: donorDoc, recipient: recipientDoc, schema, now: CREATED })
    const onRadio = driver.decode(driver.encode(codeplug, recipient))

    expect(onRadio.radioIds.map((r) => r.dmrId)).toEqual(recipientDoc.radioIds.map((r) => r.dmrId))
  })

  it('does copy your friend’s DMR ID when you do tick it', () => {
    const { recipient, recipientDoc, donorDoc } = pair()
    const { codeplug } = transplantCodeplug({
      donor: donorDoc, recipient: recipientDoc, schema, now: CREATED, copyRadioIds: true,
    })
    const onRadio = driver.decode(driver.encode(codeplug, recipient))

    expect(onRadio.radioIds.map((r) => r.dmrId)).toEqual(donorDoc.radioIds.map((r) => r.dmrId))
  })

  it('leaves your key slots alone unless you tick the box', () => {
    const { recipient, recipientDoc, donorDoc } = pair()
    const used = recipientDoc.encryptionKeys.filter((k) => k.keyHex !== '')
    expect(used.length, 'the fixture has no key slots in use').toBeGreaterThan(0)

    const { codeplug } = transplantCodeplug({ donor: donorDoc, recipient: recipientDoc, schema, now: CREATED })
    const onRadio = driver.decode(driver.encode(codeplug, recipient))

    expect(onRadio.encryptionKeys.map((k) => k.keyHex)).toEqual(recipientDoc.encryptionKeys.map((k) => k.keyHex))
  })

  it('does copy the keys when a fleet asks for them', () => {
    const { recipient, recipientDoc, donorDoc } = pair()
    const { codeplug } = transplantCodeplug({
      donor: donorDoc, recipient: recipientDoc, schema, now: CREATED, copyEncryptionKeys: true,
    })
    const onRadio = driver.decode(driver.encode(codeplug, recipient))

    expect(onRadio.encryptionKeys.map((k) => k.keyHex)).toEqual(donorDoc.encryptionKeys.map((k) => k.keyHex))
  })
})
