// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '#core/codec/checksum.js'
import { equalBytes } from '#core/codec/struct.js'
import { txFrequency } from '#core/model/channel.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDriver } from '#core/radio/registry.js'
import { decodeSettings } from '#core/radios/uv9r/driver.js'
import { channelAddr, SETTINGS_BASE } from '#core/radios/uv9r/layout.js'
import { firmwareVersion, IMAGE_SIZE, MAGIC_WP970I } from '#core/radios/uv9r/protocol.js'
import { MAGIC_UV5G } from '#core/radios/uv5g/protocol.js'
import { IDENT_UV9G, MAGIC_UV9G } from '#core/radios/uv9g/protocol.js'
import { UV9G_SCHEMA } from '#core/radios/uv9g/schema.js'
import {
  type ChirpChannel,
  type ChirpDecode,
  type ChirpSettings,
  controlKeyFor,
  expectSameChannel,
  offeredKeys,
  SETTINGS_BYTE_RUNS,
  SETTINGS_KEYS,
} from '../uv9r/chirp-compare.js'

/**
 * A real Baofeng UV-9G, as CHIRP's own test suite holds it.
 *
 * `tests/images/Baofeng_UV-9G.img` in kk7ds/chirp (GPL-3.0), less its metadata
 * trailer: 0x2000 bytes of memory and the eight ident bytes CHIRP appends.
 * boofwang did not read this radio and has never been connected to one; the
 * capture is CHIRP's, and it is a factory codeplug - GMRS 1-22, eight
 * repeater channels, twenty-four DIY slots and eleven NOAA receive-only
 * channels - so it carries no one's identity.
 *
 * The expectations are CHIRP's too. uv9g-chirp-decode.json and
 * uv9g-chirp-settings.json come from scripts/dump-wp970i-family.py, which
 * builds CHIRP's real `UV9G` class over these bytes and asks it.
 */
const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url))
const RAW = new Uint8Array(readFileSync(fixture('images/uv9g-chirp-test.bin')))
const CHIRP = JSON.parse(readFileSync(fixture('uv9g-chirp-decode.json'), 'utf8')) as ChirpDecode
const SETTINGS = JSON.parse(readFileSync(fixture('uv9g-chirp-settings.json'), 'utf8')) as ChirpSettings

function image(raw = RAW): RadioImage {
  return {
    radioId: 'uv9g',
    variant: '',
    layout: 'uv9g',
    createdAt: '2026-11-09T00:00:00.000Z',
    regions: [{ start: 0, data: raw.slice(), readOnly: false, label: 'image' }],
    meta: {},
    sha256: '',
  }
}

const driver = createDriver('uv9g')

describe('the capture itself', () => {
  it("is CHIRP's 0x2008 bytes, unchanged", async () => {
    expect(RAW.length).toBe(IMAGE_SIZE)
    expect(await sha256Hex(RAW)).toBe('a0dce8c1a129e80644dde542489ebc9da6f95b01f7c1e0cebafde520dd1f2c30')
    expect(SETTINGS.sha256).toBe('a0dce8c1a129e80644dde542489ebc9da6f95b01f7c1e0cebafde520dd1f2c30')
  })

  it('ends with the ident the radio sent, which is the UV-5G bench unit’s byte for byte', () => {
    expect([...RAW.subarray(0x2000)]).toEqual([...IDENT_UV9G])
    expect([...IDENT_UV9G]).toEqual([0xaa, 0x44, 0x46, 0x04, 0x00, 0x04, 0x70, 0xdd])
  })

  it('holds the factory placeholder where a firmware string would be', () => {
    const window = RAW.subarray(0x1ef0, 0x1efe)
    expect(new TextDecoder().decode(window.subarray(0, 7))).toBe('???????')
    expect(firmwareVersion(window)).toBe('')
  })
})

describe('which radio answers to "UV-9G"', () => {
  it('is the WP970I family behind a magic of its own', () => {
    expect([...MAGIC_UV9G]).toEqual([0x50, 0xbb, 0xff, 0x20, 0x12, 0x05, 0x25])
    expect([...MAGIC_UV9G]).not.toEqual([...MAGIC_WP970I])
    // One byte from the UV-5G's. A radio that answers that one is not this.
    expect([...MAGIC_UV9G]).not.toEqual([...MAGIC_UV5G])
    expect(MAGIC_UV9G.filter((b, i) => b !== MAGIC_UV5G[i])).toHaveLength(1)
  })
})

describe('decoded channels agree with CHIRP field for field', () => {
  const cp = driver.decode(image())

  it('finds exactly the channels CHIRP finds', () => {
    expect(Object.values(CHIRP).some((v) => 'error' in v)).toBe(false)
    const mine = [...cp.channels.keys()].sort((a, b) => a - b)
    const theirs = Object.keys(CHIRP).map(Number).sort((a, b) => a - b)
    expect(mine).toEqual(theirs)
    expect(mine.length).toBe(65)
  })

  it.each(Object.keys(CHIRP).map(Number).sort((a, b) => a - b))('channel %i matches', (index) => {
    expectSameChannel(cp.channels.get(index), CHIRP[String(index)] as ChirpChannel, index)
  })
})

describe('the factory codeplug', () => {
  const cp = driver.decode(image())
  const named = (prefix: string) => [...cp.channels.values()].filter((c) => c.name.startsWith(prefix))

  it('ships the NOAA channels receive-only with the 0xFF filling', () => {
    const noaa = named('NOAA')
    expect(noaa).toHaveLength(11)
    for (const ch of noaa) {
      expect(ch.txAllowed, ch.name).toBe(false)
      const at = channelAddr(ch.index - 1)
      expect([...RAW.subarray(at + 4, at + 8)], ch.name).toEqual([0xff, 0xff, 0xff, 0xff])
    }
  })

  it('ships the repeater pairs as +5 MHz shifts, not as splits', () => {
    // 462 MHz receive, 467 MHz transmit: two different bands in the schema's
    // GMRS plan, one band in CHIRP's VALID_BANDS. CHIRP calls it "+", and the
    // decoder asks CHIRP's bands rather than the display plan, so it agrees.
    const pairs = [...named('REPTR'), ...named('DIY')]
    expect(pairs).toHaveLength(32)
    for (const ch of pairs) {
      expect(ch.tx, ch.name).toEqual({ kind: 'offset', direction: 'plus', offset: 5_000_000 })
    }
  })

  it('ships the 467 MHz interstitials narrow on the middle selector', () => {
    // GMRS 8-14. CHIRP labels selector 1 as 1 W on this radio; Part 95 allows
    // 0.5 W on these channels. Recorded rather than resolved: only the
    // selector is stored, and nothing here can measure the radio's output.
    for (let n = 8; n <= 14; n++) {
      const ch = named(`GMRS${n}`).find((c) => c.name === `GMRS${n}`)!
      expect(ch.bandwidthHz, ch.name).toBe(12_500)
      expect(ch.power.label, ch.name).toBe('Med')
      expect(ch.power.mW, ch.name).toBe(1000)
    }
  })

  it('raises no warning or error against the GMRS band plan', () => {
    // Every transmit frequency the factory programmed lands in a GMRS window
    // and every receive frequency in a covered band. A warning here would
    // mean the plan and the radio's own programming disagree.
    const found = driver.validate(cp)
    expect(found.filter((d) => d.severity !== 'info').map((d) => `${d.ruleId} ${d.channel ?? ''}`)).toEqual([])
    // What is left is information: the twenty-four DIY slots repeat the eight
    // repeater pairs three times over, which the duplicate rule notes.
    const notes = found.filter((d) => d.severity === 'info')
    expect(new Set(notes.map((d) => d.ruleId))).toEqual(new Set(['codeplug.channel.duplicate']))
    expect(notes).toHaveLength(24)
  })
})

describe('the GMRS band plan', () => {
  const withChannel = (over: Record<string, unknown>) => {
    const doc = driver.decode(image())
    const first = [...doc.channels.values()][0]!
    doc.channels = new Map([[first.index, { ...first, ...over }]])
    return doc
  }

  it('warns, and only warns, about transmitting outside the GMRS windows', () => {
    // CHIRP says this radio transmits full band, so the warning is the
    // license's and not the firmware's - and it is never an error.
    const doc = withChannel({ rxFreq: 146_520_000, txAllowed: true, tx: { kind: 'simplex' } })
    const found = driver.validate(doc).filter((d) => d.ruleId === 'regulatory.band.tx-not-permitted')
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('warning')
  })

  it('finds every GMRS edge frequency in a transmit window first', () => {
    for (const f of [462_550_000, 462_725_000, 467_550_000, 467_725_000]) {
      const band = UV9G_SCHEMA.rf.bands.find((b) => f >= b.loHz && f <= b.hiHz)!
      expect(band.txAllowed, `${f} Hz`).toBe(true)
    }
  })

  it("receives across CHIRP's VALID_BANDS", () => {
    const doc = withChannel({ rxFreq: 155_700_000, txAllowed: false, tx: { kind: 'simplex' } })
    expect(driver.validate(doc)).toEqual([])
    expect(txFrequency(doc.channels.values().next().value!)).toBeNull()
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
      expect(mine[SETTINGS_KEYS[name]!], name).toBe(value)
    }
  })

  it('offers the controls CHIRP offers, reading the entries CHIRP reads', () => {
    const chirp = Object.keys(SETTINGS.get_settings).map(controlKeyFor).filter((k): k is string => k !== null)
    expect(offeredKeys(UV9G_SCHEMA).sort()).toEqual(chirp.sort())
    for (const [name, entry] of Object.entries(SETTINGS.get_settings)) {
      const key = controlKeyFor(name)
      if (key === null) continue
      const raw = mine[key]
      if (entry.index !== undefined) expect(raw, key).toBe(entry.index)
      else if (entry.value === 'True' || entry.value === 'False') expect(raw, key).toBe(entry.value === 'True' ? 1 : 0)
      else expect(raw, key).toBe(Number(entry.value))
    }
  })

  it('reads the power-on message the radio shows', () => {
    expect(mine['poweronMsg.line1']).toBe('BAOFENG')
    expect(mine['poweronMsg.line2']).toBe(' UV-9G')
  })
})

describe('the round-trip invariant, on real radio bytes', () => {
  it('encode(decode(image), image) is byte-identical', () => {
    const img = image()
    const out = driver.encode(driver.decode(img), img).regions[0]!.data
    const moved = [...out].findIndex((b, i) => b !== RAW[i])
    expect(moved, `byte 0x${moved.toString(16)} moved`).toBe(-1)
    expect(equalBytes(out, RAW)).toBe(true)
  })

  it('leaves the stale record behind an empty marker untouched', () => {
    // Slot 55 is empty by its first byte and holds `ff ff ff ff ff ff ff ff
    // 00 00 00 00 00 00 00 44` behind it; nothing may tidy that up.
    const stale = [...Array(128).keys()].find((i) => {
      const at = channelAddr(i)
      return RAW[at] === 0xff && RAW.subarray(at, at + 16).some((b) => b !== 0xff)
    })!
    expect(stale).toBeDefined()
    const out = driver.encode(driver.decode(image()), image()).regions[0]!.data
    const at = channelAddr(stale)
    expect(equalBytes(out.subarray(at, at + 16), RAW.subarray(at, at + 16))).toBe(true)
  })
})

describe('what the driver claims', () => {
  it('writes from the registry as a sweep, with CHIRP’s power table', () => {
    expect(driver.schema.capabilities.write).toBe(true)
    expect(driver.schema.capabilities.writesWholeImage).toBe(true)
    expect(driver.schema.rf.powerLevels.map((l) => [l.label, l.mW, l.raw])).toEqual([
      ['High', 5000, 0],
      ['Med', 1000, 1],
      ['Low', 500, 2],
    ])
  })

  it('fingerprints this unit and nothing else', async () => {
    const mine = await driver.unitFingerprint(image())
    expect(mine).toMatch(/^[0-9a-f]{64}$/)
    const synthetic = new Uint8Array(readFileSync(fixture('images/uv9r-chirp-synthetic.bin')))
    expect(await driver.unitFingerprint(image(synthetic))).not.toBe(mine)
  })
})
