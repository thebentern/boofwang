// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { equalBytes } from '#core/codec/struct.js'
import { createUvk5Driver, decodeChannel } from '#core/radios/uvk5/driver.js'
import {
  ATTR_BASE,
  CHANNEL_COUNT,
  NAMED_CHANNEL_COUNT,
  NAME_BASE,
  REGIONS,
  UVK5_ATTRIBUTES,
  UVK5_CHANNEL,
  UVK5_NAME,
  channelAddr,
  nameAddr,
} from '#core/radios/uvk5/layout.js'
import { classifyFirmware } from '#core/radios/uvk5/variants.js'
import {
  NO_REPLY_CHECKSUM,
  buildFrame,
  parseFirmwareString,
  readFrame,
  xorArray,
} from '#core/radios/uvk5/protocol.js'
import { crc16Xmodem, fromHex } from '#core/codec/checksum.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import type { RadioImage } from '#core/radio/image.js'

/**
 * A real 8 KB EEPROM, read over an FTDI cable from a Quansheng UV-K5 running
 * stock firmware 2.01.32.
 *
 * The expectations below were produced by parsing this exact image with CHIRP's
 * own `bitwise` engine and the `MEM_FORMAT` string from `chirp/drivers/uvk5.py`,
 * then reading the field values out of that. So this asserts agreement with the
 * reference implementation on real hardware data, not agreement with a second
 * reading of the same specification by the same author.
 *
 * The image includes the calibration region, which is unique to this radio.
 * That is the point of keeping it: a backup that cannot restore calibration is
 * not a backup, and this fixture proves the read captures it.
 */
const IMAGE_PATH = fileURLToPath(new URL('../../../fixtures/images/uvk5-2.01.32.bin', import.meta.url))
const RAW = new Uint8Array(readFileSync(IMAGE_PATH))
const FIRMWARE = '2.01.32'

function realImage(): RadioImage {
  return {
    radioId: 'uvk5',
    variant: FIRMWARE,
    layout: 'stock',
    createdAt: '2026-08-19T18:54:00.000Z',
    regions: REGIONS.map((r) => ({
      start: r.start,
      data: RAW.slice(r.start, r.start + r.length),
      readOnly: r.readOnly,
      label: r.label,
    })),
    meta: { firmware: FIRMWARE },
    sha256: 'a0dfe2ab4ec058c911f84768cf858b6e6f52c5c389dc402a60b7acee6716a7c0',
  }
}

describe('a real UV-K5 EEPROM', () => {
  it('is the size the protocol says it is', () => {
    expect(RAW.length).toBe(0x2000)
  })

  it('classifies 2.01.32 as stock firmware, writable in principle', () => {
    const v = classifyFirmware(FIRMWARE)
    expect(v.layout).toBe('stock')
    expect(v.canWrite).toBe(true)
    expect(v.calStart).toBe(0x1d00)
  })

  it('captures the calibration region in the backup', () => {
    const image = realImage()
    const cal = image.regions.find((r) => r.label === 'calibration')
    expect(cal).toBeDefined()
    expect(cal!.readOnly).toBe(true)
    expect(cal!.data.length).toBe(0x300)
    // Real calibration data is not blank.
    expect(cal!.data.some((b) => b !== 0xff)).toBe(true)
  })
})

describe('decoded channels agree with CHIRP field for field', () => {
  const cp = createUvk5Driver().decode(realImage())
  const byIndex = (n: number) => cp.channels.get(n)

  it('finds exactly the programmed channels plus the VFO presets', () => {
    const indices = [...cp.channels.keys()].sort((a, b) => a - b)
    expect(indices.filter((i) => i <= NAMED_CHANNEL_COUNT)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ])
    expect(indices.filter((i) => i > NAMED_CHANNEL_COUNT)).toHaveLength(14)
  })

  // Values transcribed from the CHIRP bitwise parse of this same image.
  const EXPECTED: readonly [number, string, number, 'FM' | 'AM', number, string, number, number | null][] = [
    // idx, name,    rxHz,      modulation, bandwidthHz, power, stepHz, ctcss deciHz
    [1, 'CH001', 144_025_000, 'FM', 25_000, 'High', 12_500, 670],
    [2, 'CH002', 144_525_000, 'FM', 25_000, 'High', 12_500, 719],
    [5, 'CH005', 146_025_000, 'FM', 25_000, 'High', 12_500, 885],
    [7, 'CH007', 430_025_000, 'FM', 25_000, 'High', 12_500, 1000],
    [17, 'CH017', 440_025_000, 'FM', 25_000, 'High', 12_500, 2257],
  ]

  it.each(EXPECTED)('channel %i (%s) matches', (idx, name, rxHz, modulation, bw, power, step, tone) => {
    const c = byIndex(idx)
    expect(c, `channel ${idx} missing`).toBeDefined()
    expect(c!.name).toBe(name)
    expect(c!.rxFreq).toBe(rxHz)
    expect(c!.modulation).toBe(modulation)
    expect(c!.bandwidthHz).toBe(bw)
    expect(c!.power.label).toBe(power)
    expect(c!.tuningStep).toBe(step)
    expect(c!.tx).toEqual({ kind: 'simplex' })
    expect(c!.txAllowed).toBe(true)
    if (tone === null) {
      expect(c!.tone.tx).toBeNull()
    } else {
      expect(c!.tone.tx).toEqual({ kind: 'ctcss', deciHz: tone })
      expect(c!.tone.rx).toEqual({ kind: 'ctcss', deciHz: tone })
    }
  })

  it('names the VFO pseudo-channels, which have no name storage of their own', () => {
    expect(byIndex(201)!.name).toBe('F1(50M-76M)A')
    expect(byIndex(205)!.name).toBe('F3(136M-174M)A')
    expect(byIndex(214)!.name).toBe('F7(470M-600M)B')
  })

  it('reports the 136-174 MHz VFO as AM, which is what the radio actually holds', () => {
    // Surprising, and worth pinning: CHIRP's own parse of this image agrees
    // that enable_am is set on channels 203-206. A decoder that "corrected"
    // this to FM would be wrong about the radio.
    expect(byIndex(203)!.modulation).toBe('AM')
    expect(byIndex(205)!.modulation).toBe('AM')
    expect(byIndex(207)!.modulation).toBe('FM')
  })

  it('gives the VFO presets a 25 kHz step where the memories use 12.5 kHz', () => {
    expect(byIndex(201)!.tuningStep).toBe(25_000)
    expect(byIndex(1)!.tuningStep).toBe(12_500)
  })

  it('leaves unprogrammed slots absent rather than inventing empty channels', () => {
    expect(cp.channels.has(18)).toBe(false)
    expect(cp.channels.has(200)).toBe(false)
  })
})

describe('the round-trip invariant, on real radio bytes', () => {
  // The property the whole write path will rest on, now exercised against
  // memory that a real radio produced rather than anything synthesised here.
  it('reading and writing back every channel record changes nothing', () => {
    const buf = RAW.slice()
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const addr = channelAddr(i)
      UVK5_CHANNEL.write(buf, addr, UVK5_CHANNEL.read(buf, addr))
    }
    expect(equalBytes(buf, RAW)).toBe(true)
  })

  it('reading and writing back every name changes nothing', () => {
    const buf = RAW.slice()
    for (let i = 0; i < NAMED_CHANNEL_COUNT; i++) {
      const addr = nameAddr(i)
      UVK5_NAME.write(buf, addr, UVK5_NAME.read(buf, addr))
    }
    expect(equalBytes(buf, RAW)).toBe(true)
  })

  it('reading and writing back every attribute byte changes nothing', () => {
    const buf = RAW.slice()
    for (let i = 0; i < NAMED_CHANNEL_COUNT; i++) {
      const addr = ATTR_BASE + i
      UVK5_ATTRIBUTES.write(buf, addr, UVK5_ATTRIBUTES.read(buf, addr))
    }
    expect(equalBytes(buf, RAW)).toBe(true)
  })

  it('decoding is stable: the same bytes always give the same channels', () => {
    const a = createUvk5Driver().decode(realImage())
    const b = createUvk5Driver().decode(realImage())
    expect(JSON.stringify([...a.channels.entries()])).toBe(JSON.stringify([...b.channels.entries()]))
  })

  it('holds for arbitrary mutations of a real record', () => {
    // Perturbing real bytes explores states the factory image never reaches -
    // reserved bits set, unusual tone flags - without leaving the shape of a
    // record this radio actually produces.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: CHANNEL_COUNT - 1 }),
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        (slot, noise) => {
          const buf = RAW.slice()
          const addr = channelAddr(slot)
          for (let i = 0; i < 16; i++) buf[addr + i] = buf[addr + i]! ^ noise[i]!
          const before = buf.slice()
          UVK5_CHANNEL.write(buf, addr, UVK5_CHANNEL.read(buf, addr))
          expect(equalBytes(buf, before)).toBe(true)
        },
      ),
      { numRuns: 400 },
    )
  })
})

describe('what the driver claims to own', () => {
  it('claims nothing in the calibration region, so it can never be written', () => {
    expect(createUvk5Driver().ownedRanges(REGIONS[1].start)).toEqual([])
  })

  it('claims only the channel, attribute and name tables', () => {
    const owned = createUvk5Driver().ownedRanges(0x0000)
    expect(owned).toEqual([
      [0x0000, CHANNEL_COUNT * 16],
      [ATTR_BASE, ATTR_BASE + NAMED_CHANNEL_COUNT],
      [NAME_BASE, NAME_BASE + NAMED_CHANNEL_COUNT * 16],
    ])
    // Settings at 0x0e70 onward are read and preserved but not yet modelled.
    const claimsSettings = owned.some(([s, e]) => 0x0e70 >= s && 0x0e70 < e)
    expect(claimsSettings).toBe(false)
  })
})

describe('decodeChannel on real records', () => {
  it('returns null for an unprogrammed slot', () => {
    expect(decodeChannel(RAW, 199)).toBeNull()
  })

  it('decodes slot 0 as channel 1', () => {
    expect(decodeChannel(RAW, 0)).toMatchObject({ index: 1, name: 'CH001', rxFreq: 144_025_000 })
  })
})

describe('the whole stack, replaying a real radio', () => {
  /**
   * A device that answers the real protocol out of the real EEPROM image.
   *
   * This exercises transport, framing, obfuscation, CRC, the driver's block
   * loop and decode together. It is the closest thing to the hardware session
   * that can run in CI on a machine with nothing plugged in.
   */
  function realRadioPort() {
    return new FakeSerialPort({
      respond: (frame) => {
        const payload = xorArray(frame.subarray(4, 4 + frame[2]!))
        if (payload[0] === 0x14) {
          const body = new Uint8Array(0x24 + 4)
          body[0] = 0x15
          body[1] = 0x05
          body[2] = 0x24
          for (let i = 0; i < FIRMWARE.length; i++) body[4 + i] = FIRMWARE.charCodeAt(i)
          return buildFrame(body)
        }
        if (payload[0] === 0x1b) {
          const offset = payload[4]! | (payload[5]! << 8)
          const length = payload[6]!
          const body = new Uint8Array(8 + length)
          body[0] = 0x1c
          body[4] = offset & 0xff
          body[5] = (offset >> 8) & 0xff
          body[6] = length
          body.set(RAW.subarray(offset, offset + length), 8)
          return buildFrame(body)
        }
        return null
      },
    })
  }

  it('identifies the firmware the radio actually reported', async () => {
    const t = new SerialTransport(realRadioPort())
    await t.open({ baudRate: 38_400 })
    const ident = await createUvk5Driver().identify(t, { readTimeoutMs: 1000 })
    expect(ident.variant).toBe('2.01.32')
    expect(ident.layout).toBe('stock')
    expect(ident.caps.read).toBe(true)
    await t.close()
  })

  it('reads back an image byte-identical to what the radio gave us', async () => {
    const t = new SerialTransport(realRadioPort())
    await t.open({ baudRate: 38_400 })
    const driver = createUvk5Driver()
    const ident = await driver.identify(t, { readTimeoutMs: 1000 })

    const seen: number[] = []
    const image = await driver.readImage(t, ident, {
      readTimeoutMs: 2000,
      progress: (p) => seen.push(p.done),
    })

    // 0x2000 in 0x80 blocks.
    expect(seen.at(-1)).toBe(0x2000)
    expect(seen).toHaveLength(0x2000 / 0x80)

    const flat = new Uint8Array(0x2000)
    for (const r of image.regions) flat.set(r.data, r.start)
    expect(equalBytes(flat, RAW)).toBe(true)
    await t.close()
  })

  it('decodes that freshly-read image to the same channels as the fixture', async () => {
    const t = new SerialTransport(realRadioPort())
    await t.open({ baudRate: 38_400 })
    const driver = createUvk5Driver()
    const ident = await driver.identify(t, { readTimeoutMs: 1000 })
    const live = driver.decode(await driver.readImage(t, ident, { readTimeoutMs: 2000 }))
    const fixture = driver.decode(realImage())
    expect([...live.channels.keys()].sort((a, b) => a - b)).toEqual(
      [...fixture.channels.keys()].sort((a, b) => a - b),
    )
    expect(live.channels.get(5)).toMatchObject({ name: 'CH005', rxFreq: 146_025_000 })
    await t.close()
  })
})

describe('frames exactly as the radio sent them', () => {
  /**
   * A verbatim hello reply, captured over an FTDI cable from a UV-K5 running
   * 2.01.32. Not synthesised, and that is the entire point.
   *
   * boofwang once verified the checksum on every reply, described in the code
   * as an improvement over CHIRP. Every synthetic test passed, because the
   * fakes computed a correct checksum. The radio does not: it sends 0xFFFF and
   * leaves it there. So the "improvement" rejected every genuine reply, and
   * only a real radio could show it.
   */
  const REAL_HELLO_REPLY =
    'abcd280003693 0e61cbf3d710f06e740b3e1e98016 6c14c62e910d409de26100 3b38cabe4df3cddcf53a9578deca dcba'.replaceAll(
      ' ',
      '',
    )

  it('accepts the reply the radio actually sends', async () => {
    const port = new FakeSerialPort({ greeting: fromHex(REAL_HELLO_REPLY) })
    const t = new SerialTransport(port)
    await t.open({ baudRate: 38_400 })
    const payload = await readFrame(t, { timeoutMs: 500 })
    expect(payload[0]).toBe(0x15)
    expect(parseFirmwareString(payload)).toBe('2.01.32')
    await t.close()
  })

  it('confirms the radio supplies no checksum at all', () => {
    const raw = fromHex(REAL_HELLO_REPLY)
    const length = raw[2]!
    const body = raw.subarray(4, 4 + length)
    const footer = raw.subarray(4 + length, 4 + length + 4)
    const deob = xorArray(Uint8Array.from([...body, footer[0]!, footer[1]!]))
    const supplied = deob[length]! | (deob[length + 1]! << 8)
    expect(supplied).toBe(NO_REPLY_CHECKSUM)
    // And it is genuinely not the payload's checksum, so this is the radio
    // declining rather than a coincidence.
    expect(crc16Xmodem(xorArray(body))).not.toBe(NO_REPLY_CHECKSUM)
  })

  it('still rejects a frame whose supplied checksum is wrong', async () => {
    // Firmware that does checksum its replies should still be held to it.
    const body = Uint8Array.from([0x15, 0x05, 0x00, 0x00, 0x32, 0x2e, 0x30, 0x31, 0x00])
    const good = buildFrame(body)
    good[good.length - 4] = good[good.length - 4]! ^ 0x5a // corrupt the checksum
    const t = new SerialTransport(new FakeSerialPort({ greeting: good }))
    await t.open({ baudRate: 38_400 })
    await expect(readFrame(t, { timeoutMs: 300 })).rejects.toThrow(/checksum/)
    await t.close()
  })
})

describe('fields this radio does not have', () => {
  const cp = createUvk5Driver().decode(realImage())

  it('never reports a skip flag, because the UV-K5 has none', () => {
    // CHIRP declares `rf.valid_skips = []` for this radio. Scan behaviour is
    // scanlist membership and nothing else. Deriving a skip from "in neither
    // scanlist" stamped `S` on every exported CSV row, which would mark every
    // channel scan-skipped on whatever radio imported the file.
    expect(createUvk5Driver().schema.rf.canSkip).toBe(false)
    for (const c of cp.channels.values()) {
      expect(c.skip, `channel ${c.index}`).toBe('none')
    }
  })

  it('still records scanlist membership, where it actually lives', () => {
    for (const c of cp.channels.values()) {
      if (c.index > NAMED_CHANNEL_COUNT) continue
      expect(c.extras.uvk5).toBeDefined()
      expect(typeof c.extras.uvk5!.scanList1).toBe('boolean')
      expect(typeof c.extras.uvk5!.scanList2).toBe('boolean')
    }
  })
})
