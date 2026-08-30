// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { txFrequency } from '#core/model/channel.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5gDriver } from '#core/radios/uv5g/driver.js'
import { classifyBasetype, MAGIC_UV5G } from '#core/radios/uv5g/protocol.js'
import { UV5G_SCHEMA } from '#core/radios/uv5g/schema.js'
import { decodeChannel } from '#core/radios/uv82/driver.js'
import { CHANNEL_COUNT, channelAddr } from '#core/radios/uv82/layout.js'
import { IDENT_SIZE, IMAGE_SIZE, MAGIC_UV82 } from '#core/radios/uv82/protocol.js'

/**
 * A real Radioddity UV-5G, read over an FTDI cable: firmware HN5RV011, 0x1948
 * bytes (8 ident + 0x1800 main + 0x140 aux), factory codeplug as shipped.
 *
 * The expectations are not hand-written. `uv5g-chirp-decode.json` comes from
 * `scripts/dump-uv5r-channels.py`, which parses this exact image with CHIRP's
 * own `bitwise` engine and the `MEM_FORMAT` from `uv5r.py`, applying CHIRP's
 * own empty test, transmit inhibit test and tone decoding. So this asserts
 * agreement with the reference implementation on real hardware data.
 */
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv5g-HN5RV011.bin', import.meta.url))),
)

interface ChirpChannel {
  name: string
  rx: number
  tx: number
  bw: number
  power: string
  skip: string
  rxtone: { kind: string; deciHz?: number; code?: number; polarity?: string } | null
  txtone: { kind: string; deciHz?: number; code?: number; polarity?: string } | null
}

const CHIRP = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/uv5g-chirp-decode.json', import.meta.url)), 'utf8'),
) as Record<string, ChirpChannel>

function image(): RadioImage {
  return {
    radioId: 'uv5g',
    variant: 'HN5RV011',
    layout: 'uv5g',
    createdAt: '2026-08-30T00:00:00.000Z',
    regions: [{ start: 0, data: RAW.slice(), readOnly: false, label: 'image' }],
    meta: {},
    sha256: '',
  }
}

const driver = createUv5gDriver()

describe('the image itself', () => {
  it('is ident + main + aux, the same shape as the UV-82', () => {
    expect(RAW.length).toBe(IMAGE_SIZE)
    expect(IMAGE_SIZE).toBe(0x1948)
  })

  it('starts with the ident block the radio sent', () => {
    expect([...RAW.subarray(0, 8)]).toEqual([0xaa, 0x44, 0x46, 0x04, 0x00, 0x04, 0x70, 0xdd])
  })

  it('carries the firmware string once, where the UV-82 doubles it', () => {
    // block1[48:62] of the aux area. The bench UV-82 holds its version twice in
    // this window; this radio holds it once and pads with 0xFF. The version
    // parser stops at the first non-printable byte, so both spellings read the
    // same way - recorded here so a future change to the parser has to notice.
    const window = RAW.subarray(IDENT_SIZE + 0x1800 + 48, IDENT_SIZE + 0x1800 + 62)
    expect(new TextDecoder().decode(window.subarray(0, 8))).toBe('HN5RV011')
    expect([...window.subarray(8)]).toEqual(new Array(6).fill(0xff))
  })
})

describe('which radio answers to "UV-5G"', () => {
  it('is the classic-family one, on a magic no other CHIRP model shares', () => {
    // Four radios are sold under some spelling of "UV-5G". The bench probe
    // sent every candidate ident: the UV-17 Pro family magics went unanswered
    // and this seven-byte magic was acknowledged, which is what settled the
    // protocol. The magic differs from the UV-82's in three bytes.
    expect([...MAGIC_UV5G]).toEqual([0x50, 0xbb, 0xff, 0x20, 0x12, 0x06, 0x25])
    expect([...MAGIC_UV5G]).not.toEqual([...MAGIC_UV82])
  })

  it('recognises the bench firmware by containment, the way CHIRP matches basetypes', () => {
    // HN5RV011 starts with none of CHIRP's BASETYPE_UV5R strings but contains
    // N5RV. A prefix match - which is what the UV-82 driver uses for its own
    // basetypes - would call this real radio unrecognised.
    expect(classifyBasetype('HN5RV011')).toEqual({ model: 'UV-5G', triPower: false })
  })

  it('refuses what it cannot vouch for', () => {
    expect(classifyBasetype('GARBAGE')).toBeNull()
    // CHIRP calls BFB firmware below 291 "original" and handles its aux area
    // differently on upload. No UV-5G has been seen with one; read-only.
    expect(classifyBasetype('BFB290')).toBeNull()
    expect(classifyBasetype('BFB291')).toEqual({ model: 'UV-5G', triPower: false })
    // A BFB string whose number cannot be read fails closed, not open. Found
    // by the adversarial review before the first write.
    expect(classifyBasetype('BFB29')).toBeNull()
  })
})

describe('decoded channels agree with CHIRP field for field', () => {
  const cp = driver.decode(image())

  it('finds exactly the channels CHIRP finds', () => {
    const mine = [...cp.channels.keys()].sort((a, b) => a - b)
    const theirs = Object.keys(CHIRP).map(Number).sort((a, b) => a - b)
    expect(mine).toEqual(theirs)
    // The factory plug: GMRS 1-22, eight repeater channels, NOAA 1-11.
    expect(mine.length).toBe(41)
  })

  it.each(Object.keys(CHIRP).map(Number).sort((a, b) => a - b))('channel %i matches', (index) => {
    const mine = cp.channels.get(index)!
    const theirs = CHIRP[String(index)]!
    expect(mine, `channel ${index} missing`).toBeDefined()
    expect(mine.name).toBe(theirs.name)
    expect(mine.rxFreq).toBe(theirs.rx)
    expect(mine.bandwidthHz).toBe(theirs.bw)
    expect(mine.power.label).toBe(theirs.power)
    expect(mine.skip).toBe(theirs.skip)
    expect(txFrequency(mine) ?? 0).toBe(theirs.tx)

    for (const [side, expected] of [
      ['rx', theirs.rxtone],
      ['tx', theirs.txtone],
    ] as const) {
      const got = side === 'rx' ? mine.tone.rx : mine.tone.tx
      if (expected === null) {
        expect(got, `channel ${index} ${side} tone`).toBeNull()
      } else if (expected.kind === 'ctcss') {
        expect(got).toEqual({ kind: 'ctcss', deciHz: expected.deciHz })
      } else {
        expect(got).toEqual({ kind: 'dtcs', code: expected.code, polarity: expected.polarity })
      }
    }
  })
})

describe('the factory codeplug, which is the GMRS story in bytes', () => {
  const cp = driver.decode(image())

  it('ships the NOAA channels receive-only, with the marker CHIRP recognises', () => {
    // Eleven weather channels, every one with FF FF FF FF in the transmit
    // frequency. This is the one field where a decode bug matters most: read
    // these as transmit-capable and a weather frequency ends up in a radio
    // someone can key up.
    const noaa = [...cp.channels.values()].filter((c) => c.name.startsWith('NOAA'))
    expect(noaa).toHaveLength(11)
    for (const ch of noaa) {
      expect(ch.txAllowed, ch.name).toBe(false)
      const at = channelAddr(ch.index - 1)
      expect([...RAW.subarray(at + 4, at + 8)], ch.name).toEqual([0xff, 0xff, 0xff, 0xff])
    }
  })

  it('ships the 467 MHz interstitials narrow and low power, as the FRS rules demand', () => {
    // GMRS 8-14: 467.5625-467.7125 MHz. The radio's own firmware programs
    // these as NFM at low power because that is the only legal way to use
    // them; the decode has to bring that through intact.
    for (let idx = 9; idx <= 15; idx++) {
      const ch = cp.channels.get(idx)!
      expect(ch.name).toBe(`GMRS${idx - 1}`)
      expect(ch.bandwidthHz, ch.name).toBe(12_500)
      expect(ch.power.label, ch.name).toBe('Low')
    }
  })

  it('ships the repeater channels as +5 MHz splits into the 467 window', () => {
    const rptr = [...cp.channels.values()].filter((c) => c.name.startsWith('REPTR'))
    expect(rptr).toHaveLength(8)
    for (const ch of rptr) {
      expect(ch.tx).toEqual({ kind: 'offset', direction: 'plus', offset: 5_000_000 })
      expect(txFrequency(ch)! - ch.rxFreq).toBe(5_000_000)
    }
  })

  it('raises no diagnostics at all', () => {
    // The radio's own factory programming, checked against the schema's GMRS
    // band plan: every transmit frequency lands in one of the two GMRS
    // windows, every receive frequency in a covered band. A warning here would
    // mean the band plan and the radio disagree about the radio.
    expect(driver.validate(cp)).toEqual([])
  })
})

describe('the GMRS band plan', () => {
  const cp = driver.decode(image())
  const withChannel = (over: Record<string, unknown>) => {
    const doc = driver.decode(image())
    const first = [...doc.channels.values()][0]!
    doc.channels = new Map([[first.index, { ...first, ...over }]])
    return doc
  }

  it('warns, and only warns, about transmitting outside the GMRS windows', () => {
    // 446.0 MHz is inside the radio's receive coverage and outside both GMRS
    // windows. The rule warns rather than blocks - see the note at the top of
    // lib/validate/rules.ts - and the firmware is what actually refuses.
    const doc = withChannel({ rxFreq: 446_000_000, txAllowed: true, tx: { kind: 'simplex' } })
    const found = driver.validate(doc).filter((d) => d.ruleId === 'regulatory.band.tx-not-permitted')
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('warning')
  })

  it('is an error to transmit where the radio cannot tune at all', () => {
    const doc = withChannel({ rxFreq: 462_600_000, txAllowed: true, tx: { kind: 'split', txFreq: 27_185_000 } })
    expect(driver.validate(doc).map((d) => d.ruleId)).toContain('radio.band.tx-out-of-range')
  })

  it('says nothing about listening anywhere the radio covers', () => {
    const doc = withChannel({ rxFreq: 155_700_000, txAllowed: false, tx: { kind: 'simplex' } })
    expect(driver.validate(doc)).toEqual([])
  })

  it('finds an edge GMRS frequency in a transmit window, not the receive span around it', () => {
    // The transmit windows overlap the 400-520 MHz receive span, and every
    // consumer takes the first band that contains a frequency. If the order of
    // the schema's bands ever changes, this is the test that notices.
    const first = UV5G_SCHEMA.rf.bands[0]!
    expect(first.txAllowed).toBe(true)
    const edges = [462_550_000, 462_725_000, 467_550_000, 467_725_000]
    for (const f of edges) {
      const band = UV5G_SCHEMA.rf.bands.find((b) => f >= b.loHz && f <= b.hiHz)!
      expect(band.txAllowed, `${f} Hz`).toBe(true)
    }
  })

  it('covers every factory channel with rx in range', () => {
    for (const ch of cp.channels.values()) {
      const band = UV5G_SCHEMA.rf.bands.find((b) => ch.rxFreq >= b.loHz && ch.rxFreq <= b.hiHz)
      expect(band, `${ch.name} at ${ch.rxFreq}`).toBeTruthy()
    }
  })
})

describe('the round-trip invariant, on real radio bytes', () => {
  it('encode(decode(image), image) is byte-identical', () => {
    const img = image()
    const out = driver.encode(driver.decode(img), img)
    expect(equalBytes(out.regions[0]!.data, RAW)).toBe(true)
  })

  it('keeps the receive-only marker on every NOAA channel through a re-encode', () => {
    // These are real CHIRP-style FF fills off a real radio - the case the
    // UV-82's spec had to synthesise. Nothing may rewrite them.
    const img = image()
    const out = driver.encode(driver.decode(img), img).regions[0]!.data
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const ch = decodeChannel(RAW, i)
      if (!ch || ch.txAllowed) continue
      const at = channelAddr(i)
      expect([...out.subarray(at + 4, at + 8)], `slot ${i + 1}`).toEqual([0xff, 0xff, 0xff, 0xff])
    }
  })
})

describe('what the driver claims', () => {
  it('owns the same three ranges as the UV-82, whose layout this is', () => {
    expect(driver.ownedRanges(0)).toEqual([
      [0x0008, 0x0808],
      [0x0e28, 0x0e58],
      [0x1008, 0x1808],
    ])
  })

  it('encodes even when the driver cannot write', () => {
    expect(() => driver.encode(driver.decode(image()), image())).not.toThrow()
  })

  it('stays disabled unless the build asks for it', () => {
    expect(driver.schema.capabilities.write).toBe(false)
  })

  it('names itself after the vendor on the box and the one on the shell', () => {
    expect(driver.schema.vendor).toBe('Radioddity')
    expect(driver.schema.aliases).toContain('Baofeng UV-5G')
  })
})
