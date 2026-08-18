// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { fromHex, toHex } from '#core/codec/checksum.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'
import { RecordingTransport } from '#core/transport/recording-transport.js'
import { createUvk5Driver } from '#core/radios/uvk5/driver.js'
import { buildFrame, MEM_BLOCK, MEM_SIZE, PROG_SIZE, xorArray } from '#core/radios/uvk5/protocol.js'
import type { Progress } from '#core/radio/driver.js'
import { CHIRP_CHANNELS, buildEeprom } from './fixture.js'

/** A fake UV-K5 that serves an EEPROM image over the real protocol. */
function fakeRadio(image: Uint8Array, firmware = 'k5_2.01.26') {
  return new FakeSerialPort({
    respond: (frame) => {
      if (frame.length < 6) return null
      const payload = xorArray(frame.subarray(4, 4 + frame[2]!))
      if (payload[0] === 0x14) {
        const body = new Uint8Array(28)
        body[0] = 0x15
        body[1] = 0x05
        for (let i = 0; i < firmware.length; i++) body[4 + i] = firmware.charCodeAt(i)
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
        body.set(image.subarray(offset, offset + length), 8)
        return buildFrame(body)
      }
      return null
    },
  })
}

const driver = createUvk5Driver()

/**
 * Generous timeouts on purpose.
 *
 * These tests exercise protocol behaviour, not latency. The fake radio replies
 * immediately, so the only way a timeout fires here is CPU starvation - which
 * happens on a busy CI runner and would turn a green suite red for no reason
 * anyone could act on. Timeout behaviour itself is tested directly in
 * serial-transport.spec.ts, where it is the point.
 */
const CTX = { readTimeoutMs: 30_000 }

describe('reading a radio end to end', () => {
  const eeprom = buildEeprom([
    { slot: 0, record: CHIRP_CHANNELS.SIMPLEX, name: 'CALLING' },
    { slot: 1, record: CHIRP_CHANNELS.REPEATER, name: 'W4ABC' },
    { slot: 7, record: CHIRP_CHANNELS.TX_DISABLED, name: 'WX3' },
  ])
  // Distinctive calibration bytes, so it is obvious whether they survived.
  eeprom.set(fromHex('deadbeefcafebabe'), PROG_SIZE)

  it('identifies, reads the whole EEPROM, and decodes it', async () => {
    const port = fakeRadio(eeprom)
    const t = new SerialTransport(port)
    await t.open(driver.serial)

    const ident = await driver.identify(t, CTX)
    expect(ident.variant).toBe('k5_2.01.26')
    expect(ident.layout).toBe('stock')
    expect(ident.caps.read).toBe(true)
    expect(ident.identHash).toHaveLength(64)

    const image = await driver.readImage(t, ident, CTX)
    await t.close()

    expect(image.regions).toHaveLength(2)
    const [programmable, calibration] = image.regions
    expect(programmable!.data.length).toBe(PROG_SIZE)
    expect(calibration!.data.length).toBe(MEM_SIZE - PROG_SIZE)

    // Calibration is captured, because a backup that cannot restore it is not
    // a backup - and it is marked read-only so no upload can send it.
    expect(toHex(calibration!.data.subarray(0, 8))).toBe('deadbeefcafebabe')
    expect(calibration!.readOnly).toBe(true)
    expect(programmable!.readOnly).toBe(false)

    const cp = driver.decode(image)
    expect([...cp.channels.keys()].sort((a, b) => a - b)).toEqual([1, 2, 8])
    expect(cp.channels.get(1)!.name).toBe('CALLING')
    expect(cp.channels.get(8)!.txAllowed).toBe(false)
  })

  it('reads in 128-byte blocks and reports monotonic progress', async () => {
    const port = fakeRadio(eeprom)
    const t = new SerialTransport(port)
    await t.open(driver.serial)
    const ident = await driver.identify(t, CTX)

    const seen: Progress[] = []
    await driver.readImage(t, ident, { ...CTX, progress: (p) => seen.push(p) })
    await t.close()

    const reads = seen.filter((p) => p.phase === 'read')
    expect(reads).toHaveLength(MEM_SIZE / MEM_BLOCK)
    expect(reads.at(-1)).toMatchObject({ done: MEM_SIZE, total: MEM_SIZE })
    for (let i = 1; i < reads.length; i++) {
      expect(reads[i]!.done).toBeGreaterThan(reads[i - 1]!.done)
    }
  })

  it('stops promptly when the transfer is aborted', async () => {
    const port = fakeRadio(eeprom)
    const t = new SerialTransport(port)
    await t.open(driver.serial)
    const ident = await driver.identify(t, CTX)

    const ac = new AbortController()
    let blocks = 0
    const p = driver.readImage(t, ident, {
      ...CTX,
      signal: ac.signal,
      progress: () => {
        if (++blocks === 3) ac.abort()
      },
    })
    await expect(p).rejects.toThrow()
    expect(blocks).toBeLessThan(MEM_SIZE / MEM_BLOCK)
    await t.close()
  })

  it('reads an unknown firmware but marks it unwritable', async () => {
    const port = fakeRadio(eeprom, 'IJV 3.5')
    const t = new SerialTransport(port)
    await t.open(driver.serial)

    const ident = await driver.identify(t, CTX)
    expect(ident.layout).toBe('unknown')
    expect(ident.caps.read).toBe(true)
    expect(ident.caps.write).toBe(false)
    expect(ident.caps.reason).toMatch(/not recognised/)

    // Crucially it still produces a full backup.
    const image = await driver.readImage(t, ident, CTX)
    expect(image.regions[0]!.data.length).toBe(PROG_SIZE)
    await t.close()
  })

  it('produces a replayable trace when recorded', async () => {
    const port = fakeRadio(eeprom)
    const rec = new RecordingTransport(new SerialTransport(port), 'uvk5-read')
    await rec.open(driver.serial)
    const ident = await driver.identify(rec, CTX)
    await driver.readImage(rec, ident, CTX)
    await rec.close()

    const trace = rec.toTrace()
    expect(trace.entries.length).toBeGreaterThan(2 * (MEM_SIZE / MEM_BLOCK))
    expect(trace.entries[0]!.dir).toBe('tx')
    expect(trace.entries.every((e) => /^[0-9a-f]*$/.test(e.hex))).toBe(true)
  })

  it('gives the same image a stable hash', async () => {
    const read = async () => {
      const port = fakeRadio(eeprom)
      const t = new SerialTransport(port)
      await t.open(driver.serial)
      const ident = await driver.identify(t, CTX)
      const img = await driver.readImage(t, ident, CTX)
      await t.close()
      return img
    }
    const [a, b] = await Promise.all([read(), read()])
    expect(a.sha256).toBe(b.sha256)
    expect(a.sha256).toHaveLength(64)
  })
})

describe('read timeout is configurable', () => {
  it('honours a caller-supplied timeout', async () => {
    // A BLE-serial bridge or a congested hub can stretch a reply past the
    // default; a spurious timeout mid-transfer desyncs the link and aborts the
    // read, which is worse than simply waiting.
    const port = new FakeSerialPort({ respond: () => null })
    const t = new SerialTransport(port)
    await t.open(driver.serial)
    const started = Date.now()
    await expect(driver.identify(t, { readTimeoutMs: 40 })).rejects.toThrow()
    // 5 hello attempts at 40 ms each; well under the 4 s default.
    expect(Date.now() - started).toBeLessThan(2000)
    await t.close()
  })
})
