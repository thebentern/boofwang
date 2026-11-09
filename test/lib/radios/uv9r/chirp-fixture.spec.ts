// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import type { Channel } from '#core/model/channel.js'
import { NO_TONE } from '#core/model/tones.js'
import { hz } from '#core/model/units.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDriver } from '#core/radio/registry.js'
import { decodeChannel, decodeSettings, encodeChannel } from '#core/radios/uv9r/driver.js'
import {
  channelAddr,
  nameAddr,
  NAME_SIZE,
  ownedRanges,
  SETTINGS_BASE,
  WP970I_CHANNEL,
} from '#core/radios/uv9r/layout.js'
import { CHIRP_UPLOAD_RANGES, IMAGE_SIZE } from '#core/radios/uv9r/protocol.js'
import { UV9R_SCHEMA } from '#core/radios/uv9r/schema.js'
import {
  type ChirpChannel,
  type ChirpDecode,
  type ChirpSettings,
  controlKeyFor,
  expectSameChannel,
  offeredKeys,
  SETTINGS_BYTE_RUNS,
  SETTINGS_KEYS,
} from './chirp-compare.js'

/**
 * The UV-9R against CHIRP's own `UV9R` class, on an image CHIRP wrote.
 *
 * Synthetic, and labeled so: every byte of uv9r-chirp-synthetic.bin was
 * written by CHIRP's driver through CHIRP's `bitwise` engine
 * (scripts/gen-uv9r-fixture.py), because the one real UV-9R capture in
 * existence is a stranger's upload and not this project's to redistribute.
 * So this proves the decoder and encoder agree with the reference on every
 * path the image reaches, and proves nothing about whether the reference
 * agrees with a radio. That is what docs/protocols/uv9r.md is for.
 */
const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url))
const RAW = new Uint8Array(readFileSync(fixture('images/uv9r-chirp-synthetic.bin')))
const CHIRP = JSON.parse(readFileSync(fixture('uv9r-chirp-decode.json'), 'utf8')) as ChirpDecode
const SETTINGS = JSON.parse(readFileSync(fixture('uv9r-chirp-settings.json'), 'utf8')) as ChirpSettings
interface Expected {
  label: string
  index: number
  record: string
  name: string
}
const EXPECTED = JSON.parse(readFileSync(fixture('uv9r-chirp-edits.json'), 'utf8')) as (Expected &
  ({ change: Record<string, unknown> } | { create: CreateSpec }))[]
const EDITS = EXPECTED.filter((e): e is Expected & { change: Record<string, unknown> } => 'change' in e)
const CREATES = EXPECTED.filter((e): e is Expected & { create: CreateSpec } => 'create' in e)

interface CreateSpec {
  name: string
  rx: number
  power: string
  bandwidthHz: number
  tone?: { tx: Channel['tone']['tx']; rx: Channel['tone']['rx'] }
}

function image(raw = RAW): RadioImage {
  return {
    radioId: 'uv9r',
    variant: '',
    layout: 'uv9r',
    createdAt: '2026-11-09T00:00:00.000Z',
    regions: [{ start: 0, data: raw.slice(), readOnly: false, label: 'image' }],
    meta: {},
    sha256: '',
  }
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const driver = createDriver('uv9r')
const readable = Object.entries(CHIRP).filter((e): e is [string, ChirpChannel] => !('error' in e[1]))

describe('the image', () => {
  it("is CHIRP's 0x2008 bytes: memory, then the UV-9R's ident", () => {
    expect(RAW.length).toBe(IMAGE_SIZE)
    expect([...RAW.subarray(0x2000)]).toEqual([0xaa, 0x30, 0x79, 0x04, 0x00, 0x05, 0x20, 0xdd])
  })
})

describe('decoded channels agree with CHIRP field for field', () => {
  const cp = driver.decode(image())

  it('finds exactly the channels CHIRP can read, and the one it cannot', () => {
    const errors = Object.entries(CHIRP).filter(([, v]) => 'error' in v)
    // The power-selector-3 slot. See below.
    expect(errors.map(([k]) => Number(k))).toEqual([21])
    const mine = [...cp.channels.keys()].sort((a, b) => a - b)
    const theirs = Object.keys(CHIRP).map(Number).sort((a, b) => a - b)
    expect(mine).toEqual(theirs)
  })

  it.each(readable.map(([k]) => Number(k)).sort((a, b) => a - b))('channel %i matches', (index) => {
    expectSameChannel(cp.channels.get(index), CHIRP[String(index)] as ChirpChannel, index)
  })

  it('reads an empty marker with a whole stale record behind it as empty, as CHIRP does', () => {
    // Slot 23: programmed, then its first byte set to 0xFF - how the factory
    // leaves a hundred slots on every real UV-9R capture.
    const at = channelAddr(22)
    expect(RAW[at]).toBe(0xff)
    expect(RAW.subarray(at + 1, at + 16).some((b) => b !== 0xff)).toBe(true)
    expect(cp.channels.has(23)).toBe(false)
  })

  it('reads a zero transmit filling as receive-only, as `_is_txinh` does', () => {
    const ch = cp.channels.get(19)!
    expect([...RAW.subarray(channelAddr(18) + 4, channelAddr(18) + 8)]).toEqual([0, 0, 0, 0])
    expect(ch.txAllowed).toBe(false)
  })
})

describe('a power selector of 3', () => {
  /*
   * CHIRP cannot read this channel. `get_memory` means to fall back to High:
   * its `except IndexError` handler logs the bad value and picks
   * `levels[0]`. But the log line formats `_mem.power`, which the struct does
   * not have - the field is `lowpower` - so the handler raises AttributeError
   * itself, and the whole channel read fails. The fixture records the error
   * CHIRP actually raised.
   *
   * boofwang does what CHIRP meant to: High, the first level. That is a
   * display claim only - nothing says what the radio does with a 3 - which is
   * why the encoder leaves the selector exactly as it found it unless the
   * power is changed.
   */
  it('is the error CHIRP raises, not a fallback', () => {
    expect((CHIRP['21'] as { error: string }).error).toMatch(/AttributeError: No attribute power/)
  })

  it('decodes as High, the level CHIRP meant', () => {
    expect(RAW[channelAddr(20) + 0x0e]! & 0x03).toBe(3)
    expect(driver.decode(image()).channels.get(21)!.power.label).toBe('High')
  })

  it('survives a round trip, and a rename, byte for byte', () => {
    const mem = RAW.slice()
    const ch = decodeChannel(mem, 20)!
    encodeChannel(mem, 20, { ...ch, name: 'RENAMED' })
    expect(mem[channelAddr(20) + 0x0e]! & 0x03).toBe(3)
  })

  it('is replaced when the power is actually changed', () => {
    const mem = RAW.slice()
    const ch = decodeChannel(mem, 20)!
    const low = UV9R_SCHEMA.rf.powerLevels.find((l) => l.id === 'low')!
    encodeChannel(mem, 20, { ...ch, power: { mW: low.mW, label: low.label } })
    expect(mem[channelAddr(20) + 0x0e]! & 0x03).toBe(2)
  })
})

describe('the round-trip invariant', () => {
  it('encode(decode(image), image) is byte-identical, every odd state included', () => {
    // A zero transmit filling, 0xFF mid-name, 0xFFFF tones, a selector of 3
    // and a stale record behind an empty marker: each has a way to move a
    // byte, and none may.
    const img = image()
    const out = driver.encode(driver.decode(img), img).regions[0]!.data
    const moved = [...out].findIndex((b, i) => b !== RAW[i])
    expect(moved, `byte 0x${moved.toString(16)} moved`).toBe(-1)
    expect(equalBytes(out, RAW)).toBe(true)
  })

  it('keeps a name with 0xFF in the middle exactly as it is', () => {
    // CHIRP reads it "AB CD"; writing "AB CD" back would put a space where the
    // radio had 0xFF. The field is idempotent, so it does not.
    const cp = driver.decode(image())
    expect(cp.channels.get(20)!.name).toBe('AB CD')
    const out = driver.encode(cp, image()).regions[0]!.data
    expect([...out.subarray(nameAddr(19), nameAddr(19) + 7)]).toEqual([0x41, 0x42, 0xff, 0x43, 0x44, 0xff, 0xff])
  })
})

describe("the encoder writes what CHIRP's set_memory writes", () => {
  /**
   * Each edit was made twice: once to CHIRP's Memory, with CHIRP's
   * `set_memory` producing the expected bytes, and here, to boofwang's
   * Channel. Both start from the same CHIRP-written record, whose unknown
   * bits are zero, so `set_memory` zeroing a record and boofwang preserving
   * one come to the same bytes - and any difference is a field one of them
   * gets wrong.
   */
  const apply = (ch: Channel, change: Record<string, unknown>): Channel => {
    let next: Channel = { ...ch, extras: { ...ch.extras, vendor: { ...(ch.extras.vendor ?? {}) } } }
    for (const [k, v] of Object.entries(change)) {
      if (k === 'name') next = { ...next, name: v as string }
      else if (k === 'power') {
        const level = UV9R_SCHEMA.rf.powerLevels.find((l) => l.label === v)!
        next = { ...next, power: { mW: level.mW, label: level.label } }
      } else if (k === 'txAllowed') next = { ...next, txAllowed: v as boolean }
      else if (k === 'tone') next = { ...next, tone: { ...(v as Channel['tone']), rxInverted: false } }
      else if (k === 'skip') next = { ...next, skip: v as Channel['skip'] }
      else if (k === 'tx') next = { ...next, tx: v as Channel['tx'] }
      else if (k === 'bandwidthHz') next = { ...next, bandwidthHz: v as number }
      else next.extras.vendor![k] = v as string
    }
    return next
  }

  it.each(EDITS.map((e) => [e.label, e] as const))('%s', (_label, edit) => {
    const mem = RAW.slice()
    const slot = edit.index - 1
    const ch = decodeChannel(mem, slot)!
    encodeChannel(mem, slot, apply(ch, edit.change))
    expect(hex(mem.subarray(channelAddr(slot), channelAddr(slot) + WP970I_CHANNEL.size))).toBe(edit.record)
    expect(hex(mem.subarray(nameAddr(slot), nameAddr(slot) + NAME_SIZE))).toBe(edit.name)
  })

  /*
   * A channel in a slot that was empty - built here from nothing but its
   * fields, the way the editor, a CSV row or a preset builds one.
   *
   * These are the cases an adversarial review caught: the encoder used to
   * patch whatever sat behind the empty marker, and on erased flash that
   * carried every set bit into the new channel, a power selector of 3
   * included. Programming from zeros is what `set_memory` does, so the bytes
   * have to be CHIRP's exactly.
   */
  it.each(CREATES.map((e) => [e.label, e] as const))('%s', (_label, made) => {
    const mem = RAW.slice()
    const slot = made.index - 1
    expect(decodeChannel(mem, slot), 'the slot is meant to start empty').toBeNull()
    const level = UV9R_SCHEMA.rf.powerLevels.find((l) => l.label === made.create.power)!
    const ch: Channel = {
      index: made.index,
      name: made.create.name,
      rxFreq: hz(made.create.rx),
      tx: { kind: 'simplex' },
      txAllowed: true,
      tone: made.create.tone ? { ...made.create.tone, rxInverted: false } : NO_TONE,
      modulation: 'FM',
      bandwidthHz: made.create.bandwidthHz,
      power: { mW: level.mW, label: level.label },
      tuningStep: hz(5_000),
      skip: 'none',
      comment: '',
      extras: {},
    }
    encodeChannel(mem, slot, ch)
    expect(hex(mem.subarray(channelAddr(slot), channelAddr(slot) + WP970I_CHANNEL.size))).toBe(made.record)
    expect(hex(mem.subarray(nameAddr(slot), nameAddr(slot) + NAME_SIZE))).toBe(made.name)
  })

  it('stays High at selector 0 when a new channel is created and then edited', () => {
    // The review's sequence: a new channel starts somewhere, its power is
    // changed to High, and the encoder works from the image as read - where
    // the slot is still erased flash with a selector of 3.
    const mem = RAW.slice()
    const slot = 30
    expect(mem[channelAddr(slot) + 0x0e]).toBe(0xff)
    const high = UV9R_SCHEMA.rf.powerLevels.find((l) => l.id === 'high')!
    encodeChannel(mem, slot, {
      index: slot + 1,
      name: 'NEW',
      rxFreq: hz(146_940_000),
      tx: { kind: 'simplex' },
      txAllowed: true,
      tone: NO_TONE,
      modulation: 'FM',
      bandwidthHz: 25_000,
      power: { mW: high.mW, label: high.label },
      tuningStep: hz(5_000),
      skip: 'none',
      comment: '',
      extras: {},
    })
    expect(mem[channelAddr(slot) + 0x0e]! & 0x03).toBe(0)
    expect([...mem.subarray(channelAddr(slot) + 8, channelAddr(slot) + 12)]).toEqual([0, 0, 0, 0])
  })
})

describe('the settings block agrees with CHIRP', () => {
  const mine = decodeSettings(RAW)

  it('reads every struct field CHIRP names, at the value CHIRP reads', () => {
    for (const [name, value] of Object.entries(SETTINGS.settings)) {
      const run = SETTINGS_BYTE_RUNS[name]
      if (run) {
        expect([...RAW.subarray(SETTINGS_BASE + run.offset, SETTINGS_BASE + run.offset + run.length)], name).toEqual(value)
        continue
      }
      const key = SETTINGS_KEYS[name]
      expect(key, `${name} has no boofwang key`).toBeDefined()
      expect(mine[key!], name).toBe(value)
    }
  })

  it('offers exactly the controls CHIRP offers for the settings block, no more and no fewer', () => {
    const chirp = Object.keys(SETTINGS.get_settings)
      .map(controlKeyFor)
      .filter((k): k is string => k !== null)
      .sort()
    expect(offeredKeys(UV9R_SCHEMA).sort()).toEqual(chirp)
  })

  it('gives every offered list the length CHIRP gives it, and reads the same entry', () => {
    for (const group of UV9R_SCHEMA.settings) {
      for (const field of group.fields) {
        const entry = Object.entries(SETTINGS.get_settings).find(([n]) => controlKeyFor(n) === field.key)![1]
        const raw = mine[field.key] as number
        if (entry.options !== undefined) {
          expect(field.options?.length, `${field.key} options`).toBe(entry.options)
          expect(raw, field.key).toBe(entry.index)
        } else if (entry.value === 'True' || entry.value === 'False') {
          expect(raw, field.key).toBe(entry.value === 'True' ? 1 : 0)
        } else {
          expect(raw, field.key).toBe(Number(entry.value))
        }
      }
    }
  })

  it('reads the power-on message CHIRP reads', () => {
    expect(mine['poweronMsg.line1']).toBe(SETTINGS.poweron_msg.line1.trimEnd())
    expect(mine['poweronMsg.line2']).toBe(SETTINGS.poweron_msg.line2.trimEnd())
  })
})

describe('what the driver claims', () => {
  it('owns the channel records, the settings block and the names, at radio addresses', () => {
    expect(driver.ownedRanges(0)).toEqual([
      [0x0000, 0x0800],
      [0x0e20, 0x0e50],
      [0x1000, 0x1800],
    ])
  })

  it('owns nothing CHIRP would not also upload', () => {
    for (const [s, e] of ownedRanges()) {
      expect(
        CHIRP_UPLOAD_RANGES.some(([cs, ce]) => s >= cs && e <= ce),
        `0x${s.toString(16)}-0x${e.toString(16)}`,
      ).toBe(true)
    }
  })

  it('writes from the registry, as a sweep of what it owns', () => {
    // Enabled without a boofwang bench session - see lib/radio/registry.ts -
    // and in CHIRP's shape: contiguous owned ranges, never a diff.
    expect(driver.schema.capabilities.write).toBe(true)
    expect(driver.schema.capabilities.writesWholeImage).toBe(true)
    expect(driver.schema.capabilities.writeScope).toBe('channels, channel names and radio settings')
    expect(driver.schema.capabilities.transports).toEqual(['serial'])
  })

  it('fingerprints the unit from the three spans CHIRP compares', async () => {
    const a = await driver.unitFingerprint(image())
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    const other = RAW.slice()
    other[0x1f00] = other[0x1f00]! ^ 0x01
    expect(await driver.unitFingerprint(image(other))).not.toBe(a)
    // Outside those spans - a squelch table CHIRP writes - is not the unit.
    const tuned = RAW.slice()
    tuned[0x1f61] = tuned[0x1f61]! ^ 0x01
    expect(await driver.unitFingerprint(image(tuned))).toBe(a)
  })
})
