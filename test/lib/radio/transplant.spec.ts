// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { settingsKeptByEachRadio, transplantCodeplug, TransplantError } from '#core/radio/transplant.js'
import { SCHEMAS } from '#core/radio/registry.js'
import type { RadioSchema } from '#core/radio/schema.js'
import { emptyCodeplug, type Channel, type Codeplug } from '#core/model/index.js'
import { NO_TONE } from '#core/model/tones.js'
import { hz, mW } from '#core/model/units.js'
import { DM32UV_SCHEMA } from '#core/radios/dm32uv/schema.js'
import { UVK5_SCHEMA } from '#core/radios/uvk5/schema.js'

const NOW = '2026-08-21T09:00:00.000Z'

function channel(over: Partial<Channel> & { index: number }): Channel {
  return {
    name: 'CH',
    rxFreq: hz(145_500_000),
    tx: { kind: 'simplex' },
    txAllowed: true,
    tone: NO_TONE,
    modulation: 'FM',
    bandwidthHz: 12_500,
    power: { mW: mW(5000), label: 'High' },
    tuningStep: hz(5000),
    skip: 'none',
    comment: '',
    extras: {},
    ...over,
  }
}

function plug(over: Partial<Codeplug> = {}, radio: Codeplug['radio'] = 'dm32uv'): Codeplug {
  return Object.assign(emptyCodeplug(radio, '2026-01-01T00:00:00.000Z'), over)
}

/** A donor with something in every collection, so nothing is tested vacuously. */
function fullDonor(): Codeplug {
  const cp = plug({
    zones: [{ id: 'z1', name: 'CLUB', channels: [1, 2] }],
    scanLists: [{ id: 's1', name: 'ALL', channels: [1] }],
    talkGroups: [{ id: 't1', name: 'Local', number: 91, callType: 'group' }],
    rxGroups: [{ id: 'r1', name: 'Wide', dmrIds: [91, 92] }],
    contacts: [
      {
        id: 'c1',
        name: 'W1AW',
        dmrId: 311_111,
        callsign: 'W1AW',
        city: 'Newington',
        province: 'CT',
        country: 'USA',
        remark: '',
      },
    ],
    messages: ['on my way'],
    radioIds: [{ id: 'rid1', name: 'Donor', dmrId: 3_100_001 }],
    encryptionKeys: [
      { id: 'k1', slot: 1, name: 'Fleet', type: 'aes256', keyHex: 'AABB' },
      { id: 'k2', slot: 2, name: '', type: 'none', keyHex: '' },
    ],
    settings: { squelch: 3, radioName: 'DONOR' },
  })
  cp.channels.set(1, channel({ index: 1, name: 'DONOR1' }))
  cp.channels.set(2, channel({ index: 2, name: 'DONOR2' }))
  return cp
}

/** A recipient with its own identity in every place identity is kept. */
function ownRadio(): Codeplug {
  const cp = plug({
    zones: [{ id: 'mz', name: 'MINE', channels: [7] }],
    scanLists: [{ id: 'ms', name: 'MINE', channels: [7] }],
    talkGroups: [{ id: 'mt', name: 'Mine', number: 3, callType: 'group' }],
    rxGroups: [{ id: 'mr', name: 'Mine', dmrIds: [3] }],
    radioIds: [{ id: 'mrid', name: 'Mine', dmrId: 3_199_999 }],
    encryptionKeys: [{ id: 'mk', slot: 1, name: 'Mine', type: 'arc4', keyHex: 'CCDD' }],
    messages: ['mine'],
    settings: { squelch: 1, radioName: 'MINE' },
  })
  cp.channels.set(7, channel({ index: 7, name: 'MINE' }))
  return cp
}

const run = (over: Partial<Parameters<typeof transplantCodeplug>[0]> = {}) =>
  transplantCodeplug({ donor: fullDonor(), recipient: ownRadio(), schema: DM32UV_SCHEMA, now: NOW, ...over })

describe('transplantCodeplug', () => {
  it('replaces the channel bank with the donor’s', () => {
    const { codeplug } = run()
    expect([...codeplug.channels.keys()]).toEqual([1, 2])
    expect(codeplug.channels.get(1)!.name).toBe('DONOR1')
  })

  it('moves the membership lists across with the channels they point at', () => {
    // Zone and scan list membership is by absolute channel slot, so keeping the
    // recipient's lists while replacing the bank underneath them would leave
    // "MINE" pointing at whichever donor channel now sits in slot 7.
    const { codeplug } = run()
    expect(codeplug.zones.map((z) => z.name)).toEqual(['CLUB'])
    expect(codeplug.scanLists.map((l) => l.name)).toEqual(['ALL'])
  })

  it('copies every collection the schema declares', () => {
    const { copied } = run()
    expect(copied.map((c) => c.feature)).toEqual([
      'channels',
      'zones',
      'scanLists',
      'talkGroups',
      'rxGroups',
      'contacts',
      'messages',
    ])
    expect(copied.find((c) => c.feature === 'contacts')!.count).toBe(1)
  })

  it('leaves alone the collections the radio does not have', () => {
    // A UV-K5 has no zones, talk groups or contacts at all. Clearing lists a
    // radio cannot hold would be a change with nothing on the other side of it.
    const donor = fullDonor()
    const recipient = ownRadio()
    donor.radio = 'uvk5'
    recipient.radio = 'uvk5'
    const { codeplug, copied } = transplantCodeplug({ donor, recipient, schema: UVK5_SCHEMA, now: NOW })

    expect(codeplug.zones.map((z) => z.name)).toEqual(['MINE'])
    expect(codeplug.talkGroups).toHaveLength(1)
    expect(copied.map((c) => c.feature)).toEqual(['channels', 'scanLists'])
  })

  it('never copies the DMR radio ID unless it is asked for', () => {
    // The safety-relevant default. Two radios transmitting the same DMR ID are
    // one identity on every repeater they touch, and neither of them can tell.
    const { codeplug, skipped } = run()
    expect(codeplug.radioIds).toEqual([{ id: 'mrid', name: 'Mine', dmrId: 3_199_999 }])

    const entry = skipped.find((s) => s.feature === 'radioIds')!
    expect(entry.count).toBe(1)
    expect(entry.reason).toMatch(/repeater/)
  })

  it('copies the DMR radio ID only on an explicit opt-in', () => {
    const { codeplug, copied, skipped } = run({ copyRadioIds: true })
    expect(codeplug.radioIds.map((r) => r.dmrId)).toEqual([3_100_001])
    expect(copied.some((c) => c.feature === 'radioIds')).toBe(true)
    expect(skipped.some((s) => s.feature === 'radioIds')).toBe(false)
  })

  it('treats anything other than a literal true as no', () => {
    // The flag arrives from a checkbox and travels through an options bag, so
    // an absent or undefined value must land on the safe side rather than on
    // whichever side falsiness happens to put it.
    expect(run({ copyRadioIds: undefined }).codeplug.radioIds[0]!.dmrId).toBe(3_199_999)
    expect(run({ copyEncryptionKeys: undefined }).codeplug.encryptionKeys[0]!.keyHex).toBe('CCDD')
  })

  it('never copies encryption keys unless they are asked for', () => {
    const { codeplug, skipped } = run()
    expect(codeplug.encryptionKeys).toEqual([{ id: 'mk', slot: 1, name: 'Mine', type: 'arc4', keyHex: 'CCDD' }])

    const entry = skipped.find((s) => s.feature === 'encryptionKeys')!
    // One of the donor's two slots is unused, and an unused slot is not a key
    // anybody is deciding about.
    expect(entry.count).toBe(1)
    expect(entry.reason).toMatch(/secret/)
  })

  it('copies encryption keys only on an explicit opt-in', () => {
    const { codeplug, copied } = run({ copyEncryptionKeys: true })
    expect(codeplug.encryptionKeys.map((k) => k.keyHex)).toEqual(['AABB', ''])
    expect(copied.find((c) => c.feature === 'encryptionKeys')!.count).toBe(1)
  })

  it('says nothing about keys or IDs the donor does not carry', () => {
    // A skip line for a non-event is how the two that matter stop being read.
    const donor = fullDonor()
    donor.radioIds = []
    donor.encryptionKeys = [{ id: 'k2', slot: 2, name: '', type: 'none', keyHex: '' }]
    const { skipped } = run({ donor })
    expect(skipped.map((s) => s.feature)).toEqual(['settings'])
  })

  it('keeps the recipient’s settings, and says why', () => {
    const { codeplug, skipped } = run()
    expect(codeplug.settings).toEqual({ squelch: 1, radioName: 'MINE' })
    expect(skipped.find((s) => s.feature === 'settings')!.reason).toMatch(/DMR ID/)
  })

  it('keeps the recipient’s own firmware variant and creation date', () => {
    const recipient = ownRadio()
    recipient.meta = { ...recipient.meta, variant: 'MINE-1.09', title: 'My radio' }
    const donor = fullDonor()
    donor.meta = { ...donor.meta, variant: 'DONOR-1.02', title: 'Club codeplug' }

    const { codeplug } = transplantCodeplug({ donor, recipient, schema: DM32UV_SCHEMA, now: NOW })
    expect(codeplug.meta.variant).toBe('MINE-1.09')
    expect(codeplug.meta.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(codeplug.meta.modifiedAt).toBe(NOW)
  })

  it('refuses a donor from a different model', () => {
    const donor = fullDonor()
    donor.radio = 'uvk5'
    expect(() => transplantCodeplug({ donor, recipient: ownRadio(), schema: DM32UV_SCHEMA, now: NOW })).toThrow(
      TransplantError,
    )
  })

  it('refuses a schema that does not describe the recipient', () => {
    expect(() => run({ schema: UVK5_SCHEMA })).toThrow(TransplantError)
  })

  it('mutates neither argument', () => {
    // The donor document is decoded from a file the user may still want to open
    // as-is, and the recipient is the live document the app is rendering.
    const donor = fullDonor()
    const recipient = ownRadio()
    const { codeplug } = transplantCodeplug({ donor, recipient, schema: DM32UV_SCHEMA, now: NOW })

    codeplug.zones[0]!.channels.push(99)
    codeplug.settings.squelch = 9

    expect(donor.zones[0]!.channels).toEqual([1, 2])
    expect(recipient.channels.get(7)!.name).toBe('MINE')
    expect(recipient.zones[0]!.name).toBe('MINE')
    expect(recipient.settings.squelch).toBe(1)
  })
})

describe('transplanting settings', () => {
  // Real DM-32UV keys, so what is tested is that schema's own marks: two that
  // move, one from each group that stays, and one the schema never declares.
  const MASTER = {
    backlightBrightness: 5,
    'alertTones.keyPress': 1,
    powerOnLine1: 'G0SEC',
    latitude: '51.500000',
    undeclared: 7,
  }
  const MINE = {
    backlightBrightness: 1,
    'alertTones.keyPress': 0,
    powerOnLine1: 'M0DAV',
    latitude: '52.000000',
    undeclared: 3,
  }

  function pair() {
    const donor = fullDonor()
    donor.settings = { ...MASTER }
    const recipient = ownRadio()
    recipient.settings = { ...MINE }
    return { donor, recipient }
  }

  const settled = (over: Partial<Parameters<typeof transplantCodeplug>[0]> = {}) =>
    transplantCodeplug({ ...pair(), schema: DM32UV_SCHEMA, now: NOW, ...over })

  it('keeps every setting unless they are asked for', () => {
    const { codeplug, copied, skipped } = settled()
    expect(codeplug.settings).toEqual(MINE)
    expect(copied.some((c) => c.feature === 'settings')).toBe(false)
    expect(skipped.find((s) => s.feature === 'settings')!.count).toBe(5)
  })

  it('treats anything other than a literal true as no', () => {
    expect(settled({ copySettings: undefined }).codeplug.settings).toEqual(MINE)
    expect(settled({ copySettings: false }).codeplug.settings).toEqual(MINE)
  })

  it('copies them on request, all but the ones that belong to the handset', () => {
    const { codeplug, copied, skipped } = settled({ copySettings: true })
    expect(codeplug.settings).toEqual({
      backlightBrightness: 5,
      'alertTones.keyPress': 1,
      powerOnLine1: 'M0DAV',
      latitude: '52.000000',
      // Decoded somewhere and shown nowhere, so nobody here can vouch for what
      // it means, and it is not this module's to move.
      undeclared: 3,
    })
    expect(copied.find((c) => c.feature === 'settings')!.count).toBe(2)
    expect(skipped.some((s) => s.feature === 'settings')).toBe(false)

    const kept = skipped.find((s) => s.feature === 'unitSettings')!
    expect(kept.count).toBe(2)
    expect(kept.reason).toBe(
      'Your radio keeps its own power-on screen and fixed APRS position. ' +
        'Those belong to the handset rather than to the channel plan.',
    )
  })

  it('keeps every setting on a schema that has not said which belong to the handset', () => {
    // Nobody has gone through the UV-K5's settings field by field, so asking
    // changes nothing. The failure this guards against is a callsign or an
    // identity filed among some radio's settings, copied to a whole fleet.
    const { donor, recipient } = pair()
    donor.radio = 'uvk5'
    donor.settings = { squelch: 9 }
    recipient.radio = 'uvk5'
    recipient.settings = { squelch: 1 }

    const { codeplug, skipped } = transplantCodeplug({
      donor, recipient, schema: UVK5_SCHEMA, now: NOW, copySettings: true,
    })
    expect(codeplug.settings).toEqual({ squelch: 1 })
    expect(skipped.find((s) => s.feature === 'settings')!.reason).toMatch(/DMR ID/)
    expect(settingsKeptByEachRadio(UVK5_SCHEMA)).toBeNull()
  })

  it('mutates neither argument', () => {
    const { donor, recipient } = pair()
    const { codeplug } = transplantCodeplug({ donor, recipient, schema: DM32UV_SCHEMA, now: NOW, copySettings: true })

    codeplug.settings.backlightBrightness = 0
    expect(donor.settings.backlightBrightness).toBe(5)
    expect(recipient.settings.backlightBrightness).toBe(1)
  })

  it('holds back exactly the DM-32UV’s power-on screen and fixed position', () => {
    // Pinned, so a mark cannot be dropped in passing: each one removed sends
    // the master's value to every radio in a fleet.
    const schema: RadioSchema = DM32UV_SCHEMA
    const marked = schema.settings.flatMap((g) =>
      g.fields.filter((f) => f.perUnit !== undefined).map((f) => `${f.key}: ${f.perUnit}`),
    )
    expect(marked).toEqual([
      'powerOnInterface: power-on screen',
      'powerOnLine1: power-on screen',
      'powerOnLine2: power-on screen',
      'aprsFixedBeacon.enabled: fixed APRS position',
      'latitude: fixed APRS position',
      'latitudeDirection: fixed APRS position',
      'longitude: fixed APRS position',
      'longitudeDirection: fixed APRS position',
    ])
    expect(settingsKeptByEachRadio(schema)).toEqual(['power-on screen', 'fixed APRS position'])
  })

  it('is allowed only on the radios whose settings have been gone through', () => {
    // A radio joins this list by marking its per-unit settings first. The flag
    // is the claim that the marks are complete, so it is the last step.
    const opted = Object.values(SCHEMAS)
      .filter((s) => s?.features.settingsTransplant === true)
      .map((s) => s!.id)
    expect(opted).toEqual(['dm32uv'])
  })
})
