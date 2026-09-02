// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fromHex } from '#core/codec/checksum.js'
import { equalBytes } from '#core/codec/struct.js'
import type { RadioDriver } from '#core/radio/driver.js'
import { createUvk5Driver } from '#core/radios/uvk5/driver.js'
import { REGIONS as UVK5_REGIONS } from '#core/radios/uvk5/layout.js'
import { buildFrame, xorArray } from '#core/radios/uvk5/protocol.js'
import { createUv5rMiniDriver } from '#core/radios/uv5rmini/driver.js'
import { ACK, MAGICS, VARIANTS, encrypt, frame } from '#core/radios/uv5rmini/protocol.js'
import { FakeNativeSerialLink } from '#core/transport/fake-native-serial-link.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'
import { NativeSerialPort } from '#core/transport/native-serial-port.js'
import { RecordingTransport } from '#core/transport/recording-transport.js'
import { SerialTransport } from '#core/transport/serial-transport.js'

/**
 * The proof that a driver cannot tell a phone's cable from a laptop's.
 *
 * Each radio here is a responder that serves a real hardware capture over the
 * real protocol. The same responder is put behind `FakeSerialPort` - the port
 * every driver test already runs against - and behind `NativeSerialPort` over
 * `FakeNativeSerialLink`, and the driver is run through both. If the two
 * recorded traces differ by a byte, or either decoded image differs from the
 * capture, the port is changing what a driver sends or sees, and that is a
 * defect in the port.
 */

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))))

/** A responder shaped so that either fake can take it. */
type Responder = (written: Uint8Array) => Uint8Array | null

/**
 * Generous on purpose: these exercise protocol behaviour, not latency, and a
 * busy CI runner is the only way a timeout fires against a fake that replies
 * immediately.
 */
const CTX = { readTimeoutMs: 30_000 }

interface Session {
  tx: string[]
  rx: string[]
  image: Awaited<ReturnType<RadioDriver['readImage']>>
  ident: Awaited<ReturnType<RadioDriver['identify']>>
}

/** Identify and read through a transport, recording every byte both ways. */
async function session(driver: RadioDriver, transport: SerialTransport): Promise<Session> {
  const t = new RecordingTransport(transport)
  await t.open({ ...driver.serial, openSettleMs: 0 })
  const ident = await driver.identify(t, CTX)
  const image = await driver.readImage(t, ident, CTX)
  await t.close()
  return {
    tx: t.entries.filter((e) => e.dir === 'tx').map((e) => e.hex),
    rx: t.entries.filter((e) => e.dir === 'rx').map((e) => e.hex),
    image,
    ident,
  }
}

async function overCable(driver: RadioDriver, respond: Responder): Promise<Session> {
  return session(driver, new SerialTransport(new FakeSerialPort({ respond })))
}

async function overPhone(driver: RadioDriver, respond: Responder): Promise<Session> {
  return session(driver, new SerialTransport(new NativeSerialPort(new FakeNativeSerialLink({ respond }))))
}

describe('a Quansheng UV-K5, read through both ports', () => {
  /**
   * A real 8 KB EEPROM from a UV-K5 on stock 2.01.32, served over the real
   * framed protocol the same way `test/lib/radios/uvk5/read.spec.ts` does.
   */
  const RAW = fixture('uvk5-2.01.32.bin')
  const FIRMWARE = '2.01.32'

  function uvk5(): Responder {
    return (frame) => {
      if (frame.length < 6) return null
      const payload = xorArray(frame.subarray(4, 4 + frame[2]!))
      if (payload[0] === 0x14) {
        const body = new Uint8Array(28)
        body[0] = 0x15
        body[1] = 0x05
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
    }
  }

  const driver = createUvk5Driver()

  it('sends and receives exactly the same bytes', async () => {
    const cable = await overCable(driver, uvk5())
    const phone = await overPhone(driver, uvk5())
    expect(phone.tx).toEqual(cable.tx)
    expect(phone.rx).toEqual(cable.rx)
    expect(phone.tx.length).toBeGreaterThan(0)
  })

  it('decodes the capture, through either', async () => {
    for (const s of [await overCable(driver, uvk5()), await overPhone(driver, uvk5())]) {
      expect(s.ident.radioId).toBe('uvk5')
      expect(s.ident.layout).toBe('stock')
      expect(s.image.regions).toHaveLength(UVK5_REGIONS.length)
      for (const [i, region] of UVK5_REGIONS.entries()) {
        const got = s.image.regions[i]!
        expect(got.start).toBe(region.start)
        expect(equalBytes(got.data, RAW.subarray(region.start, region.start + region.length)), `region ${i}`).toBe(
          true,
        )
      }
    }
  })
})

describe('a Baofeng UV-5R Mini, read through both ports', () => {
  /**
   * A real UV-5R Mini's three regions, factory default, answering to
   * `PROGRAMCOLORPROU` with the ident replies the index records. The read is
   * 521 blocks of 0x40, each echoing its request header before the payload.
   */
  const RAW = fixture('uv5rmini-5RMINI.bin')
  const INDEX = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../fixtures/images/uv5rmini-5RMINI.index.json', import.meta.url)), 'utf8'),
  ) as { sha256: string; ident46: string; ident4d: string }
  const variant = VARIANTS.find((v) => v.id === 'uv5rmini')!

  /** Where in the concatenated capture a radio address lives, or -1. */
  function blobOffset(addr: number): number {
    let off = 0
    for (const r of variant.regions) {
      if (addr >= r.start && addr < r.start + r.size) return off + (addr - r.start)
      off += r.size
    }
    return -1
  }

  function uv5rmini(): Responder {
    return (written) => {
      if (equalBytes(written, variant.ident)) return Uint8Array.from([ACK])
      if (equalBytes(written, MAGICS[0]!.send)) return fromHex(INDEX.ident46)
      if (equalBytes(written, MAGICS[1]!.send)) return new TextEncoder().encode(INDEX.ident4d)
      if (equalBytes(written, MAGICS[2]!.send)) return Uint8Array.from([ACK])
      if (written[0] === 0x52 && written.length === 4) {
        const addr = (written[1]! << 8) | written[2]!
        const length = written[3]!
        const at = blobOffset(addr)
        if (at < 0) throw new Error(`read outside the capture at 0x${addr.toString(16)}`)
        return frame(0x52, addr, length, encrypt(RAW.subarray(at, at + length)))
      }
      return null
    }
  }

  const driver = createUv5rMiniDriver()

  it('sends and receives exactly the same bytes', async () => {
    const cable = await overCable(driver, uv5rmini())
    const phone = await overPhone(driver, uv5rmini())
    expect(phone.tx).toEqual(cable.tx)
    expect(phone.rx).toEqual(cable.rx)
    // The ident, the three magics, and one read per 0x40 block.
    expect(phone.tx.length).toBe(4 + RAW.length / 0x40)
  })

  it('decodes the capture, through either', async () => {
    for (const s of [await overCable(driver, uv5rmini()), await overPhone(driver, uv5rmini())]) {
      expect(s.ident.radioId).toBe('uv5rmini')
      expect(s.ident.layout).toBe('uv5rmini')
      expect(s.image.sha256).toBe(INDEX.sha256)
      let off = 0
      for (const [i, region] of variant.regions.entries()) {
        const got = s.image.regions[i]!
        expect(got.start).toBe(region.start)
        expect(equalBytes(got.data, RAW.subarray(off, off + region.size)), `region ${i}`).toBe(true)
        off += region.size
      }
    }
  })

  it('keeps the cable block size behind the phone, because the radio is on a UART', async () => {
    // The one protocol constant that differs by link. Through this port the
    // radio is on its own wire, and `radioLink` has to say so.
    const t = new SerialTransport(new NativeSerialPort(new FakeNativeSerialLink()))
    await t.open({ ...driver.serial, openSettleMs: 0 })
    const { uploadBlockSize, BLOCK_SIZE } = await import('#core/radios/uv5rmini/protocol.js')
    expect(uploadBlockSize(t.radioLink)).toBe(BLOCK_SIZE)
    await t.close()
  })
})
