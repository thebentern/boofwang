// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  AIR_KEY_IDS,
  MONITOR_KEYS_SCHEMA,
  MONITOR_PROFILE_SCHEMA,
  MONITOR_VENDOR_KEYS,
  airKeyIdFor,
  buildMonitorKeys,
  buildMonitorProfile,
  planMonitorExport,
  planMonitorKeys,
  type AirKeyId,
  type MonitorKeys,
  type MonitorProfile,
} from '#core/io/monitor-profile.js'
import type { Channel } from '#core/model/channel.js'
import { emptyCodeplug, sortedChannels, type Codeplug } from '#core/model/codeplug.js'
import { KEY_TYPE_LABELS, encryptionLegality, isBlankKey, maskKey } from '#core/model/encryption.js'
import { hz, mW, type Hz } from '#core/model/units.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { channelSlot } from '#core/radios/dm32uv/layout.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'

/**
 * The committed DM-32UV capture: 45 channels, 18 of them DMR, and 22 AES-256
 * key slots named `Encrypt 1` to `Encrypt 22` whose key material is redacted
 * to zeros. Its own encryption - TAC 1-14 on slots 1-14, all on GMRS - is
 * flagged in every export, so the tests that need an arrangement of their own
 * clear it and arm theirs by hand - and one arms it in the raw bytes, so that
 * the names the profile reads are checked against the names the real decoder
 * writes.
 */
const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))
const BLOB = new Uint8Array(readFileSync(fixture('dm32uv-DM32.01.01.040.blocks.bin')))
const INDEX = JSON.parse(readFileSync(fixture('dm32uv-DM32.01.01.040.index.json'), 'utf8')) as {
  model: string
  firmware: string
  blocks: { id: number; physical: number; offset: number }[]
}

function image(): RadioImage {
  return {
    radioId: 'dm32uv',
    variant: INDEX.firmware,
    layout: INDEX.model,
    createdAt: '2026-08-19T21:30:00.000Z',
    regions: INDEX.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: BLOB.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
    meta: { placements: INDEX.blocks.map((b) => ({ blockId: b.id, physical: b.physical })) },
    sha256: '',
  }
}

const driver = createDm32uvDriver()
const decode = (img: RadioImage = image()): Codeplug => driver.decode(img)

const AT = '2026-11-08T12:00:00.000Z'

/**
 * Key material that could not plausibly arrive any other way.
 *
 * All letters, so that a four-character run of either cannot be confused with a
 * frequency, a DMR number or a slot - which is what makes the "not even
 * partially" assertion below mean something. Every other slot gets a distinct
 * key of its own from `keyFor`, digits and all, for the whole-key checks.
 */
const SECRET_A = 'ABCDEF'.repeat(11).slice(0, 64)
const SECRET_B = 'FEDCBA'.repeat(11).slice(0, 64)
const SECRET_SLOT_NAME = 'SHERIFF NARCOTICS TAC'

/** A distinct 32-byte key per slot, uppercase as the codeplug stores keys. */
function keyFor(slot: number): string {
  let x = Math.imul(slot, 2654435761) >>> 0
  let out = ''
  while (out.length < 64) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out += ((x >>> 16) & 0xff).toString(16).padStart(2, '0')
  }
  return out.toUpperCase()
}

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()

/** Every four-character run of a key, which is what "not even partially" comes down to. */
function windows(hex: string, size = 4): string[] {
  const out: string[] = []
  for (let i = 0; i + size <= hex.length; i++) out.push(hex.slice(i, i + size))
  return out
}

/** The two bytes the DM-32UV encrypts with, as its decoder reports them. */
function encrypt(c: Channel, slot: number, rxFreq: Hz = c.rxFreq, enabled = '1'): Channel {
  return {
    ...c,
    rxFreq,
    extras: { ...c.extras, vendor: { ...c.extras.vendor, encryptEnabled: enabled, encryptionKeyId: String(slot) } },
  }
}

/**
 * The capture with every channel's encryption turned off.
 *
 * The OEM CPS encrypted TAC 1-14 on the radio this was read from - slots 1-14,
 * on GMRS frequencies - and the decoder reads that from 0x1E and 0x1F bit 6.
 * The arrangements below make their own encryption, so they start from none.
 */
function withoutEncryption(cp: Codeplug): Codeplug {
  for (const [i, c] of cp.channels) cp.channels.set(i, encrypt(c, 0, c.rxFreq, '0'))
  return cp
}

/** What a careless driver might hang off a channel, and a spread would carry. */
function leak(c: Channel): Channel {
  return { ...c, extras: { ...c.extras, vendor: { ...c.extras.vendor, keyHex: SECRET_A, keyName: SECRET_SLOT_NAME } } }
}

/**
 * The capture, keyed and encrypted in every way that matters to an export.
 *
 * | Channel | Where | Slot | Why it is here |
 * |---|---|---|---|
 * | 28 TAC 1 | 451.0125, land mobile | 3 | lawful, real key, and `leak`ed extras |
 * | 29 TAC 2 | 451.0250, land mobile | 17 | a slot past the eight the specification claims |
 * | 30 TAC 3 | 451.0375, land mobile | 5 | the slot is all zeros |
 * | 31 TAC 4 | 451.0500, land mobile | 6 | the slot is empty |
 * | 32 TAC 5 | 462.6625, GMRS | 4 | encryption prohibited |
 * | 42 LR DMR | 443.1250, amateur | 9 | encryption prohibited |
 * | 33 TAC 6 | 451.0625, land mobile | 8 | names a slot with encryption off |
 * | 1 GMRS 1 | 462.5625, GMRS, FM | 7 | the same fields, on an analog channel, are not encryption |
 *
 * Slot 2 holds a key nothing uses. Every other channel is unencrypted: the
 * capture's own encryption is cleared first - see `withoutEncryption`.
 */
function armed(): Codeplug {
  const cp = withoutEncryption(decode())
  cp.encryptionKeys = cp.encryptionKeys
    .filter((k) => k.slot !== 6)
    .map((k) => ({
      ...k,
      name: k.slot === 3 ? SECRET_SLOT_NAME : k.name,
      keyHex: k.slot === 3 ? SECRET_A : k.slot === 17 ? SECRET_B : k.slot === 5 ? '0'.repeat(64) : keyFor(k.slot),
    }))
  const edit = (index: number, f: (c: Channel) => Channel) => cp.channels.set(index, f(cp.channels.get(index)!))
  edit(28, (c) => leak(encrypt(c, 3, hz(451_012_500))))
  edit(29, (c) => encrypt(c, 17, hz(451_025_000)))
  edit(30, (c) => encrypt(c, 5, hz(451_037_500)))
  edit(31, (c) => encrypt(c, 6, hz(451_050_000)))
  edit(32, (c) => encrypt(c, 4))
  edit(42, (c) => encrypt(c, 9))
  edit(33, (c) => encrypt(c, 8, hz(451_062_500), '0'))
  edit(1, (c) => encrypt(c, 7))
  return cp
}

const CHANNEL_FIELDS = [
  'index', 'name', 'rxHz', 'modulation', 'bandwidthHz', 'colorCode', 'timeSlot', 'txTalkGroup', 'rxGroup',
  'keySlot', 'service',
]

const parseProfile = (json: string) => JSON.parse(json) as MonitorProfile
const parseKeys = (json: string) => JSON.parse(json) as MonitorKeys

/** Every channel a plan flagged, with the service whose rule caught it, in notice order. */
const flagged = (plan: ReturnType<typeof planMonitorExport>) =>
  plan.warnings.flatMap((w) => w.channels.map((c): [number, string] => [c.index, w.service]))

describe('a monitor profile cannot carry key material', () => {
  const cp = armed()
  const outputs: [string, string][] = [
    ['the profile', buildMonitorProfile(cp, { exportedAt: AT })],
    ['the profile with analog channels', buildMonitorProfile(cp, { exportedAt: AT, includeAnalog: true })],
    ['the warnings', JSON.stringify(planMonitorExport(cp, { includeAnalog: true }).warnings)],
  ]
  // The capture's own slots, as committed. Redacted to zeros, but they are the
  // keys "from the fixture", and the check costs nothing.
  const committed = decode().encryptionKeys

  it('is checked against keys that are all different', () => {
    // Otherwise a key that leaked could be hiding behind one that did not.
    const keys = cp.encryptionKeys.map((k) => k.keyHex)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('never emits a key the codeplug holds, in either case', () => {
    const keys = [...cp.encryptionKeys, ...committed].map((k) => k.keyHex)
    for (const [what, text] of outputs) {
      const lower = text.toLowerCase()
      expect(keys.filter((hex) => lower.includes(hex.toLowerCase())), `${what} contains a key`).toEqual([])
    }
  })

  it('never emits part of a key either', () => {
    // A mask is not a redaction. Four characters of an AES key is a foothold.
    for (const [what, text] of outputs) {
      const lower = text.toLowerCase()
      const found = [SECRET_A, SECRET_B].flatMap((s) => windows(s)).filter((w) => lower.includes(w.toLowerCase()))
      expect([...new Set(found)], `${what} contains fragments of a key`).toEqual([])
    }
  })

  it('never emits a masked key', () => {
    for (const [what, text] of outputs) {
      for (const k of cp.encryptionKeys) expect(text.includes(maskKey(k.keyHex)), `${what} contains a masked key`).toBe(false)
      expect(text.includes('•'), `${what} contains mask characters`).toBe(false)
    }
  })

  it('never emits the name of a key slot, and nor does the keys file', () => {
    // The name is the leak people forget. "SHERIFF NARCOTICS TAC" tells a
    // reader what the encrypted channel is for without disclosing a byte of it.
    const names = [...cp.encryptionKeys, ...committed].map((k) => k.name)
    const all: [string, string][] = [...outputs, ['the keys file', buildMonitorKeys(cp, { exportedAt: AT })]]
    for (const [what, text] of all) {
      const lower = text.toLowerCase()
      expect(names.filter((n) => lower.includes(n.toLowerCase())), `${what} names a key slot`).toEqual([])
      expect(lower.includes('sheriff'), `${what} names a key slot`).toBe(false)
    }
  })

  it('ignores whatever else a channel carries in its extras', () => {
    // Channel 28 carries a key and a slot name in `extras.vendor`, where a
    // spread would pick them up. Its record is the declared fields and no more.
    const profile = parseProfile(outputs[0]![1])
    for (const c of profile.channels) expect(Object.keys(c)).toEqual(CHANNEL_FIELDS)
    expect(outputs[0]![1].includes('keyHex')).toBe(false)
    expect(outputs[0]![1].includes('keyName')).toBe(false)
  })

  it('holds for any keys, any names and any assignment of slots', () => {
    const base = decode()
    const digital = sortedChannels(base).filter((c) => c.modulation === 'DMR')
    // The oracle leans on this: every digital channel on the capture sits
    // where encryption is prohibited, so leaving one in place makes it
    // unlawful and moving it to 451 MHz makes it lawful.
    expect(digital.every((c) => !encryptionLegality(c.rxFreq).allowed)).toBe(true)

    const NAME = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -']
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 32, maxLength: 32 }), { minLength: 22, maxLength: 22 }),
        fc.array(fc.string({ unit: fc.constantFrom(...NAME), minLength: 1, maxLength: 9 }), { minLength: 22, maxLength: 22 }),
        fc.array(fc.record({ slot: fc.integer({ min: 0, max: 24 }), enabled: fc.boolean(), lawful: fc.boolean() }), {
          minLength: digital.length,
          maxLength: digital.length,
        }),
        (material, names, plan) => {
          const cp = structuredClone(base)
          // A tilde appears nowhere else in either file, so a name is found
          // only if it leaked.
          cp.encryptionKeys = cp.encryptionKeys.map((k, i) => ({ ...k, keyHex: toHex(material[i]!), name: `~${names[i]!}` }))
          digital.forEach((c, i) => {
            const p = plan[i]!
            cp.channels.set(c.index, encrypt(c, p.slot, p.lawful ? hz(451_000_000 + i * 12_500) : c.rxFreq, p.enabled ? '1' : '0'))
          })

          const text = [
            buildMonitorProfile(cp, { exportedAt: AT, includeAnalog: true }),
            JSON.stringify(planMonitorExport(cp, { includeAnalog: true }).warnings),
          ].join('\n').toLowerCase()
          for (const k of cp.encryptionKeys) {
            expect(text.includes(k.keyHex.toLowerCase()), `slot ${k.slot}'s key leaked`).toBe(false)
            expect(text.includes(k.name.toLowerCase()), `slot ${k.slot}'s name leaked`).toBe(false)
          }

          // Every digital channel is described, and flagged exactly when it
          // encrypts where encryption is prohibited.
          const encrypts = (i: number) => plan[i]!.enabled && plan[i]!.slot >= 1
          const exported = planMonitorExport(cp, { includeAnalog: true })
          for (const c of digital) expect(exported.channels.some((m) => m.index === c.index)).toBe(true)
          expect(flagged(exported).map(([index]) => index).sort((a, b) => a - b)).toEqual(
            digital.flatMap((c, i) => (encrypts(i) && !plan[i]!.lawful ? [c.index] : [])),
          )

          // And the keys file is exactly the slots an encrypting channel uses
          // that hold a real key, lawful or not - slots 23 and 24 hold nothing.
          const used = new Set(digital.flatMap((_, i) => (encrypts(i) ? [plan[i]!.slot] : [])))
          const expected = cp.encryptionKeys.filter((k) => used.has(k.slot) && !isBlankKey(k.keyHex)).map((k) => k.slot)
          expect(parseKeys(buildMonitorKeys(cp, { exportedAt: AT })).keys.map((k) => k.slot)).toEqual(expected)
        },
      ),
      { numRuns: 150 },
    )
  })
})

describe('the keys file', () => {
  const cp = armed()
  const file = parseKeys(buildMonitorKeys(cp, { exportedAt: AT }))

  it('holds the slots an exported channel uses, and only real keys', () => {
    // Slot 17 travels exactly like slot 3. The table has 22 slots, not the
    // eight the specification says, and a slot past eight is a slot. Slots 4
    // and 9 are used only by channels encrypted on GMRS and on amateur, and
    // travel like the rest: the notice states the rule, and the key is the
    // operator's to take.
    expect(file.keys).toEqual([
      { slot: 3, type: 'aes256', keyHex: SECRET_A },
      { slot: 4, type: 'aes256', keyHex: keyFor(4) },
      { slot: 9, type: 'aes256', keyHex: keyFor(9) },
      { slot: 17, type: 'aes256', keyHex: SECRET_B },
    ])
  })

  it('skips a slot that is empty or all zeros, and says which', () => {
    expect(planMonitorKeys(cp)).toEqual({ exported: [3, 4, 9, 17], withoutKey: [5, 6] })
  })

  it('carries nothing for a slot no channel uses', () => {
    // Slot 2 holds a real key, and no channel names it.
    expect(file.keys.map((k) => k.slot)).not.toContain(2)
  })

  it('carries nothing a channel names without turning encryption on', () => {
    // Slot 8 is named by a channel with the enable bit clear, and slot 7 by an
    // analog channel, whose same two bytes mean something else.
    for (const opts of [{}, { includeAnalog: true }]) {
      const slots = parseKeys(buildMonitorKeys(cp, opts)).keys.map((k) => k.slot)
      expect(slots).not.toContain(8)
      expect(slots).not.toContain(7)
    }
  })

  it('is empty for the capture as committed, whose keys are zeros', () => {
    // TAC 1-14 use slots 1-14, and every one of them was redacted.
    const committed = decode()
    const tac = Array.from({ length: 14 }, (_, i) => i + 1)
    expect(planMonitorKeys(committed)).toEqual({ exported: [], withoutKey: tac })
    expect(parseKeys(buildMonitorKeys(committed, { exportedAt: AT })).keys).toEqual([])
  })

  it('says which radio and build it came from', () => {
    expect(file.schema).toBe(MONITOR_KEYS_SCHEMA)
    expect(file.radio).toBe('dm32uv')
    expect(file.variant).toBe('DM32.01.01.040')
    expect(file.exportedAt).toBe(AT)
  })

  it('says null for a firmware nothing recorded, as a raw .bin has none', () => {
    const bare = armed()
    bare.meta.variant = ''
    expect(parseKeys(buildMonitorKeys(bare, { exportedAt: AT })).variant).toBeNull()
    expect(parseProfile(buildMonitorProfile(bare, { exportedAt: AT })).variant).toBeNull()
  })
})

describe('which channels a profile carries', () => {
  const cp = armed()

  it('is DMR only unless asked otherwise', () => {
    const { channels } = planMonitorExport(cp)
    expect(channels.every((c) => c.modulation === 'DMR')).toBe(true)
    expect(channels.map((c) => c.index)).toEqual(Array.from({ length: 18 }, (_, i) => 28 + i))
  })

  it('takes analog channels on request, with nothing digital said about them', () => {
    const analog = planMonitorExport(cp, { includeAnalog: true }).channels.filter((c) => c.modulation !== 'DMR')
    expect(analog).toHaveLength(27)
    for (const c of analog) {
      expect([c.colorCode, c.timeSlot, c.txTalkGroup, c.rxGroup, c.keySlot]).toEqual([null, null, null, null, null])
    }
  })

  it('does not read an analog channel as encrypted', () => {
    // Channel 1 is FM on GMRS with a vendor block naming slot 7, enable bit
    // set - fields that mean PTT ID settings, not encryption, on an analog
    // channel. Read as encryption it would carry slot 7 and a GMRS notice; it
    // carries neither.
    const plan = planMonitorExport(cp, { includeAnalog: true })
    expect(plan.channels.find((c) => c.index === 1)?.keySlot).toBeNull()
    expect(flagged(plan).map(([index]) => index)).not.toContain(1)
  })

  it('keeps an encrypted channel where encryption is prohibited, and states the rule', () => {
    // Stated, not enforced: the channel and its slot are described like any
    // other, and the notice is the whole of the response.
    const plan = planMonitorExport(cp)
    const { channels, warnings } = plan
    expect(flagged(plan)).toEqual([[32, 'GMRS/FRS'], [42, 'amateur']])
    expect(channels.filter((c) => c.index === 32 || c.index === 42).map((c) => [c.index, c.keySlot])).toEqual([
      [32, 4],
      [42, 9],
    ])
    expect(warnings[0]!.message).toContain('47 CFR 95.1731 / 95.587')
    expect(warnings[1]!.message).toBe(
      'Channel 42, LR DMR, is encrypted on 443.125000 MHz. Encryption is prohibited on the amateur bands: ' +
        'transmissions may not be encoded to obscure their meaning. 47 CFR 97.113(a)(4).',
    )
  })

  it('says each rule once, however many channels it covers', () => {
    // Beside 32 on GMRS: a run of three and a stray, each on its own GMRS
    // frequency. Beside 42 on amateur: one more, which makes a pair.
    const many = armed()
    for (const index of [34, 35, 36, 38, 44]) many.channels.set(index, encrypt(many.channels.get(index)!, 4))
    const plan = planMonitorExport(many)
    expect(plan.warnings.map((w) => w.service)).toEqual(['GMRS/FRS', 'amateur'])
    expect(flagged(plan)).toEqual([
      [32, 'GMRS/FRS'],
      [34, 'GMRS/FRS'],
      [35, 'GMRS/FRS'],
      [36, 'GMRS/FRS'],
      [38, 'GMRS/FRS'],
      [42, 'amateur'],
      [44, 'amateur'],
    ])
    expect(plan.warnings.map((w) => w.message)).toEqual([
      'Channels 32, 34 to 36, and 38 are encrypted. Encryption is prohibited on GMRS and FRS: messages may not ' +
        'be encoded to obscure their meaning. 47 CFR 95.1731 / 95.587.',
      'Channels 42 and 44 are encrypted. Encryption is prohibited on the amateur bands: transmissions may not be ' +
        'encoded to obscure their meaning. 47 CFR 97.113(a)(4).',
    ])
  })

  it('reads in the plural for a rule said of a band', () => {
    // The receive-only rules carry no citation, and used to say "This is a
    // receive-only weather channel" - wrong after a list of two.
    const weather = withoutEncryption(decode())
    weather.channels.set(43, encrypt(weather.channels.get(43)!, 4, hz(162_400_000)))
    weather.channels.set(45, encrypt(weather.channels.get(45)!, 4, hz(162_550_000)))
    expect(planMonitorExport(weather).warnings.map((w) => w.message)).toEqual([
      'Channels 43 and 45 are encrypted. Weather channels are receive-only.',
    ])
  })

  it('keeps an unencrypted channel on the same band', () => {
    // TAC 7 to TAC 14 are on GMRS too, and use no key. Nothing about them is
    // unlawful to describe.
    const indices = planMonitorExport(cp).channels.map((c) => c.index)
    for (const i of [34, 35, 36, 37, 38, 39, 40, 41]) expect(indices).toContain(i)
  })

  it('keeps every encrypted channel, lawful or not, with its service', () => {
    const plan = planMonitorExport(cp)
    expect(plan.channels.filter((c) => c.keySlot !== null).map((c) => [c.index, c.keySlot, c.service])).toEqual([
      [28, 3, 'land mobile'],
      [29, 17, 'land mobile'],
      [30, 5, 'land mobile'],
      [31, 6, 'land mobile'],
      [32, 4, 'GMRS/FRS'],
      [42, 9, 'amateur'],
    ])
    expect(plan.keySlots).toEqual([3, 4, 5, 6, 9, 17])
  })

  it('describes a slot that holds no key as none, rather than dropping it', () => {
    // The channel still encrypts with slot 6 as far as its bytes go, and a
    // tester hearing it needs to know that is the slot with nothing in it.
    expect(parseProfile(buildMonitorProfile(cp, { exportedAt: AT })).keySlots).toEqual([
      { slot: 3, type: 'aes256', airKid: null, airAlgId: null },
      { slot: 4, type: 'aes256', airKid: null, airAlgId: null },
      { slot: 5, type: 'aes256', airKid: null, airAlgId: null },
      { slot: 6, type: 'none', airKid: null, airAlgId: null },
      { slot: 9, type: 'aes256', airKid: null, airAlgId: null },
      { slot: 17, type: 'aes256', airKid: null, airAlgId: null },
    ])
  })

  it('says null for a talk group slot that holds nothing', () => {
    // Slot 2 is one of the capture's wiped records.
    const c = cp.channels.get(34)!
    cp.channels.set(34, { ...c, extras: { ...c.extras, vendor: { ...c.extras.vendor, txContact: '2' } } })
    expect(planMonitorExport(cp).channels.find((ch) => ch.index === 34)?.txTalkGroup).toBeNull()
  })
})

describe('the committed capture, described for a receiver', () => {
  const cp = decode()
  const profile = parseProfile(buildMonitorProfile(cp, { exportedAt: AT }))
  const ch = (i: number) => profile.channels.find((c) => c.index === i)!

  it('reads the vendor fields under the names the driver writes them', () => {
    // If the driver renamed one, the profile would read nothing there and say
    // so with a null - which for the two encryption fields would mean calling
    // an encrypted channel clear.
    const vendor = cp.channels.get(28)!.extras.vendor ?? {}
    for (const key of MONITOR_VENDOR_KEYS) expect(Object.keys(vendor), `the driver no longer writes ${key}`).toContain(key)
  })

  it('carries all eighteen digital channels, the fourteen it flags included', () => {
    expect(profile.channels.map((c) => c.index)).toEqual(Array.from({ length: 18 }, (_, i) => 28 + i))
  })

  it('names the talk group a channel transmits to by its number on the air', () => {
    // By physical slot. TAC 1 points at slot 4, TAC Chan. Counting down the
    // list instead finds USA, because slot 2 is a wiped record.
    expect(ch(28).txTalkGroup).toBe(1)
    expect([42, 43, 44, 45].map((i) => ch(i).txTalkGroup)).toEqual([310501, 3105, 3100, 98])
  })

  it('carries the color code and slot as the radio stores them', () => {
    expect([ch(28).colorCode, ch(28).timeSlot]).toEqual([0, 1])
    expect([ch(42).colorCode, ch(42).timeSlot]).toEqual([2, 1])
  })

  it('says it does not know the RX group, rather than that there is none', () => {
    expect(profile.channels.every((c) => c.rxGroup === null)).toBe(true)
    expect(profile.rxGroups.find((g) => g.name === 'AR')?.members).toEqual([3105, 310501, 3100])
  })

  it('flags the fourteen channels the CPS encrypted on GMRS, and states the rule once', () => {
    // TAC 1-14 name slots 1-14 in their own bytes and are described with them.
    // Their keys are another matter - see the keys file, which finds zeros.
    const plan = planMonitorExport(cp)
    expect(flagged(plan)).toEqual(Array.from({ length: 14 }, (_, i) => [28 + i, 'GMRS/FRS']))
    expect(plan.warnings.map((w) => w.message)).toEqual([
      'Channels 28 to 41 are encrypted. Encryption is prohibited on GMRS and FRS: messages may not be encoded ' +
        'to obscure their meaning. 47 CFR 95.1731 / 95.587.',
    ])
    const tac = Array.from({ length: 14 }, (_, i) => i + 1)
    expect(tac.map((n) => ch(27 + n).keySlot)).toEqual(tac)
    expect(profile.keySlots).toEqual(tac.map((slot) => ({ slot, type: 'aes256', airKid: null, airAlgId: null })))
  })

  it('finds encryption where the radio keeps it, through the real decoder', () => {
    // The capture's own: TAC 1 names slot 1 at 0x1E with 0x1F bit 6 set.
    expect(ch(28).keySlot).toBe(1)

    // 0x1E and 0x1F bit 6 written into channel 42's record in the image
    // rather than into the document, so the decoder has to find them. The
    // channel stays where the capture has it, on the amateur band, and is
    // described with slot 12 - a slot past eight - and flagged.
    const img = image()
    const at = channelSlot(42)!
    const page = img.regions.find((r) => r.start === logicalAddress(at.blockId))!.data
    page[at.offset + 0x1f] = page[at.offset + 0x1f]! | 0x40
    page[at.offset + 0x1e] = 12
    const plan = planMonitorExport(decode(img))
    expect(plan.channels.find((m) => m.index === 42)?.keySlot).toBe(12)
    expect(flagged(plan)).toContainEqual([42, 'amateur'])
  })

  it('does not take 0x2A or 0x1D bit 7 for encryption', () => {
    // Where the reference put the key and the enable bit. On channel 43 they
    // say nothing, and the channel is described as clear.
    const img = image()
    const at = channelSlot(43)!
    const page = img.regions.find((r) => r.start === logicalAddress(at.blockId))!.data
    page[at.offset + 0x1d] = page[at.offset + 0x1d]! | 0x80
    page[at.offset + 0x2a] = 12
    const plan = planMonitorExport(decode(img))
    expect(plan.channels.find((c) => c.index === 43)?.keySlot).toBeNull()
    expect(flagged(plan).map(([index]) => index)).not.toContain(43)
  })
})

describe('over-the-air key IDs', () => {
  it('match on the radio, the slot and the type together', () => {
    const table: AirKeyId[] = [{ radio: 'dm32uv', slot: 3, type: 'aes256', kid: 101, algId: 202 }]
    expect(airKeyIdFor('dm32uv', 3, 'aes256', table)).toEqual(table[0])
    expect(airKeyIdFor('dm32uv', 3, 'arc4', table)).toBeNull()
    expect(airKeyIdFor('dm32uv', 4, 'aes256', table)).toBeNull()
    expect(airKeyIdFor('uvk5', 3, 'aes256', table)).toBeNull()
    expect(airKeyIdFor(null, 3, 'aes256', table)).toBeNull()
  })

  it('hold only pairs the protocol notes record as observed', () => {
    // The table in code is a copy of the table in the notes, and the notes are
    // where an observation is dated and described. A row here with no row
    // there is a number nobody can trace.
    const notes = readFileSync(fileURLToPath(new URL('../../../docs/protocols/dm32uv.md', import.meta.url)), 'utf8')
    const section = notes.split(/^## /m).find((s) => s.startsWith('Over-the-air key IDs'))
    expect(section, 'dm32uv.md has no "Over-the-air key IDs" section').toBeDefined()
    expect(section).toContain('| Slot | Type | Observed ALGID | Observed KID | Decrypts in dsd-fme | Date |')

    const rows = section!
      .split('\n')
      .filter((line) => /^\|\s*\d+\s*\|/.test(line))
      .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    for (const r of AIR_KEY_IDS.filter((a) => a.radio === 'dm32uv')) {
      const seen = rows.some(
        ([slot, type, alg, kid]) =>
          Number(slot) === r.slot && type === KEY_TYPE_LABELS[r.type] && Number(alg) === r.algId && Number(kid) === r.kid,
      )
      expect(seen, `slot ${r.slot} ${r.type} is in AIR_KEY_IDS and not in the calibration table`).toBe(true)
    }
  })
})

/**
 * A bench codeplug small enough to read in a snapshot.
 *
 * One encrypted channel on a slot past eight, one clear one on the other time
 * slot, one analog channel, talk groups placed by slot, and the one key.
 */
function bench(): Codeplug {
  const cp = emptyCodeplug('dm32uv', AT)
  cp.meta.variant = 'DM32.01.01.040'
  const dmr: Channel = {
    index: 1,
    name: 'BENCH TS1',
    rxFreq: hz(451_012_500),
    tx: { kind: 'simplex' },
    txAllowed: true,
    tone: { rx: null, tx: null, rxInverted: false },
    modulation: 'DMR',
    bandwidthHz: 12_500,
    power: { mW: mW(1000), label: 'Low' },
    tuningStep: hz(12_500),
    skip: 'none',
    comment: '',
    extras: { vendor: { colorCode: '1', timeSlot: '1', txContact: '2', encryptEnabled: '1', encryptionKeyId: '9' } },
  }
  cp.channels.set(1, dmr)
  cp.channels.set(2, {
    ...dmr,
    index: 2,
    name: 'BENCH TS2',
    extras: { vendor: { colorCode: '1', timeSlot: '2', txContact: '1', encryptEnabled: '0', encryptionKeyId: '0' } },
  })
  cp.channels.set(3, { ...dmr, index: 3, name: 'BENCH FM', modulation: 'FM', bandwidthHz: 25_000, extras: {} })
  cp.talkGroups = [
    { id: 'tg-68-1', name: 'Local', number: 9, callType: 'group' },
    { id: 'tg-68-2', name: 'Bench', number: 3_100_001, callType: 'private' },
  ]
  cp.rxGroups = [{ id: 'rxg-1', name: 'Bench', dmrIds: [9, 3_100_001] }]
  cp.encryptionKeys = [{ id: 'key-9', slot: 9, name: 'BENCH KEY', type: 'aes256', keyHex: SECRET_A }]
  return cp
}

describe('the two formats', () => {
  it('name their schemas', () => {
    expect(MONITOR_PROFILE_SCHEMA).toBe('boofwang.monitor-profile/1')
    expect(MONITOR_KEYS_SCHEMA).toBe('boofwang.monitor-keys/1')
  })

  it('keep the profile field for field', () => {
    expect(buildMonitorProfile(bench(), { exportedAt: AT, includeAnalog: true })).toMatchInlineSnapshot(`
      "{
        "schema": "boofwang.monitor-profile/1",
        "radio": "dm32uv",
        "variant": "DM32.01.01.040",
        "exportedAt": "2026-11-08T12:00:00.000Z",
        "channels": [
          {
            "index": 1,
            "name": "BENCH TS1",
            "rxHz": 451012500,
            "modulation": "DMR",
            "bandwidthHz": 12500,
            "colorCode": 1,
            "timeSlot": 1,
            "txTalkGroup": 3100001,
            "rxGroup": null,
            "keySlot": 9,
            "service": "land mobile"
          },
          {
            "index": 2,
            "name": "BENCH TS2",
            "rxHz": 451012500,
            "modulation": "DMR",
            "bandwidthHz": 12500,
            "colorCode": 1,
            "timeSlot": 2,
            "txTalkGroup": 9,
            "rxGroup": null,
            "keySlot": null,
            "service": "land mobile"
          },
          {
            "index": 3,
            "name": "BENCH FM",
            "rxHz": 451012500,
            "modulation": "FM",
            "bandwidthHz": 25000,
            "colorCode": null,
            "timeSlot": null,
            "txTalkGroup": null,
            "rxGroup": null,
            "keySlot": null,
            "service": "land mobile"
          }
        ],
        "talkGroups": [
          {
            "number": 9,
            "name": "Local",
            "callType": "group"
          },
          {
            "number": 3100001,
            "name": "Bench",
            "callType": "private"
          }
        ],
        "rxGroups": [
          {
            "name": "Bench",
            "members": [
              9,
              3100001
            ]
          }
        ],
        "keySlots": [
          {
            "slot": 9,
            "type": "aes256",
            "airKid": null,
            "airAlgId": null
          }
        ]
      }
      "
    `)
  })

  it('keep the keys file field for field', () => {
    expect(buildMonitorKeys(bench(), { exportedAt: AT })).toMatchInlineSnapshot(`
      "{
        "schema": "boofwang.monitor-keys/1",
        "radio": "dm32uv",
        "variant": "DM32.01.01.040",
        "exportedAt": "2026-11-08T12:00:00.000Z",
        "keys": [
          {
            "slot": 9,
            "type": "aes256",
            "keyHex": "ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD"
          }
        ]
      }
      "
    `)
  })
})
