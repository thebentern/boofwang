// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { hz } from '#core/model/units.js'
import {
  BackupRequiredError,
  RadioChangedError,
  WriteVerifyError,
  type BackupRef,
  type WriteReport,
} from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUvk5Driver } from '#core/radios/uvk5/driver.js'
import { PROG_SIZE, buildFrame, xorArray } from '#core/radios/uvk5/protocol.js'
import { REGIONS } from '#core/radios/uvk5/layout.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'
import { SerialTransport } from '#core/transport/serial-transport.js'

/**
 * Regression tests for the write path.
 *
 * Every case here corresponds to a defect an adversarial review found before
 * this code was ever pointed at a radio. They are written from the trigger the
 * review described, not from the fix, so they would fail against the original
 * implementation.
 */

const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uvk5-2.01.32.bin', import.meta.url))),
)
const FIRMWARE = '2.01.32'
const OPEN = { baudRate: 38_400 }

function imageOf(mem: Uint8Array, variant = FIRMWARE): RadioImage {
  return {
    radioId: 'uvk5',
    variant,
    layout: 'stock',
    createdAt: '2026-08-19T18:54:00.000Z',
    regions: REGIONS.map((r) => ({
      start: r.start,
      data: mem.slice(r.start, r.start + r.length),
      readOnly: r.readOnly,
      label: r.label,
    })),
    meta: {},
    sha256: '',
  }
}

/** A device that serves, and accepts writes into, its own EEPROM. */
function radioPort(eeprom: Uint8Array, firmware = FIRMWARE) {
  const writes: { addr: number; data: Uint8Array }[] = []
  const port = new FakeSerialPort({
    respond: (frame) => {
      const payload = xorArray(frame.subarray(4, 4 + frame[2]!))
      if (payload[0] === 0x14) {
        const body = new Uint8Array(0x28)
        body[0] = 0x15
        body[1] = 0x05
        for (let i = 0; i < firmware.length; i++) body[4 + i] = firmware.charCodeAt(i)
        return buildFrame(body)
      }
      if (payload[0] === 0x1b) {
        const addr = payload[4]! | (payload[5]! << 8)
        const len = payload[6]!
        const body = new Uint8Array(8 + len)
        body[0] = 0x1c
        body[4] = addr & 0xff
        body[5] = (addr >> 8) & 0xff
        body[6] = len
        body.set(eeprom.subarray(addr, addr + len), 8)
        return buildFrame(body)
      }
      if (payload[0] === 0x1d) {
        const addr = payload[4]! | (payload[5]! << 8)
        const len = payload[6]!
        const data = payload.slice(12, 12 + len)
        writes.push({ addr, data })
        eeprom.set(data, addr)
        return buildFrame(Uint8Array.from([0x1e, 0x05, 0, 0, addr & 0xff, (addr >> 8) & 0xff]))
      }
      return null
    },
  })
  return { port, writes, eeprom }
}

async function connect(port: FakeSerialPort) {
  const t = new SerialTransport(port)
  await t.open(OPEN)
  return t
}

const driver = createUvk5Driver()
/**
 * The schema gates the radio as a whole and is off until a write has been
 * verified on hardware; these tests exercise everything behind that gate.
 */
const writable = createUvk5Driver({ enableWrite: true })

async function backupFor(eeprom: Uint8Array): Promise<BackupRef> {
  const t = await connect(radioPort(eeprom.slice()).port)
  const ident = await driver.identify(t, { readTimeoutMs: 1000 })
  await t.close()
  return { id: 'b1', identHash: ident.identHash, createdAt: '2026-08-19T00:00:00Z' }
}

describe('a backup must be of THIS radio', () => {
  /**
   * The review's first critical finding: identHash was a hash of the firmware
   * string alone, so every UV-K5 on a given firmware shared one identity. A
   * backup of radio A would unlock writing to radio B, and B's codeplug would
   * be overwritten with nothing to restore it from.
   */
  it('two radios on the same firmware do not share an identity', async () => {
    const a = RAW.slice()
    const b = RAW.slice()
    // Calibration is factory-set per unit; that is what tells them apart.
    b[0x1d40] = b[0x1d40]! ^ 0x01

    const ta = await connect(radioPort(a).port)
    const tb = await connect(radioPort(b).port)
    const ia = await driver.identify(ta, { readTimeoutMs: 1000 })
    const ib = await driver.identify(tb, { readTimeoutMs: 1000 })
    await ta.close()
    await tb.close()

    expect(ia.variant).toBe(ib.variant)
    expect(ia.identHash).not.toBe(ib.identHash)
  })

  it('the same radio identifies consistently', async () => {
    const t1 = await connect(radioPort(RAW.slice()).port)
    const t2 = await connect(radioPort(RAW.slice()).port)
    const i1 = await driver.identify(t1, { readTimeoutMs: 1000 })
    const i2 = await driver.identify(t2, { readTimeoutMs: 1000 })
    await t1.close()
    await t2.close()
    expect(i1.identHash).toBe(i2.identHash)
  })

  it('refuses a write backed by another radio’s backup', async () => {
    const other = RAW.slice()
    other[0x1d40] = other[0x1d40]! ^ 0x01
    const foreign = await backupFor(other)

    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const image = imageOf(eeprom)
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'NOPE' })

    await expect(
      writable.writeImage(t, driver.encode(cp, image), { backup: foreign, readTimeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(BackupRequiredError)
    await t.close()
  })

  it('refuses a write with no backup at all', async () => {
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    await expect(writable.writeImage(t, imageOf(eeprom), { readTimeoutMs: 1000 })).rejects.toBeInstanceOf(
      BackupRequiredError,
    )
    await t.close()
  })
})

describe('the radio is re-read before anything is skipped', () => {
  /**
   * The review's second critical finding: block-skipping trusted the caller's
   * baseImage. A radio edited from its keypad since it was read, or a saved
   * file from another session, meant blocks were silently left alone and the
   * result reported as verified - a mixture of two codeplugs.
   */
  it('refuses when the radio changed since the codeplug was read', async () => {
    const asRead = RAW.slice()
    const nowOnRadio = RAW.slice()
    nowOnRadio[0x0400] = nowOnRadio[0x0400]! ^ 0xff // a keypad edit

    const { port, eeprom } = radioPort(nowOnRadio)
    const t = await connect(port)
    const backup = await backupFor(eeprom)

    const image = imageOf(asRead)
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'EDIT' })

    await expect(
      writable.writeImage(t, driver.encode(cp, image), {
        backup,
        baseImage: image,
        readTimeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(RadioChangedError)
    await t.close()
  })

  it('names where the radio first disagrees', async () => {
    const nowOnRadio = RAW.slice()
    nowOnRadio[0x0400] = nowOnRadio[0x0400]! ^ 0xff
    const { port, eeprom } = radioPort(nowOnRadio)
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'EDIT' })

    const err = (await writable
      .writeImage(t, driver.encode(cp, image), { backup, baseImage: image, readTimeoutMs: 1000 })
      .catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/0x0400/)
    expect(err.message).toMatch(/Read it again/)
    await t.close()
  })

  it('skips only blocks the radio genuinely already holds', async () => {
    const { port, writes, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'W4ABC' })

    const report = await writable.writeImage(t, driver.encode(cp, image), {
      backup,
      baseImage: image,
      readTimeoutMs: 1000,
    })

    // Only the block holding the name record changed.
    expect(report.blocksWritten).toBe(1)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.addr).toBe(0x0f00)
    expect(report.verified).toBe(true)
    await t.close()
  })

  it('leaves the radio holding exactly what was sent', async () => {
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)
    cp.channels.set(3, { ...cp.channels.get(3)!, rxFreq: hz(145_500_000) })
    const encoded = driver.encode(cp, image)

    await writable.writeImage(t, encoded, { backup, baseImage: image, readTimeoutMs: 1000 })
    const written = encoded.regions.find((r) => r.start === 0)!.data
    expect(equalBytes(eeprom.subarray(0, PROG_SIZE), written)).toBe(true)
    // Calibration is untouched.
    expect(equalBytes(eeprom.subarray(PROG_SIZE), RAW.subarray(PROG_SIZE))).toBe(true)
    await t.close()
  })
})

describe('verification happens per block, not at the end', () => {
  /**
   * The review found the write and verify passes were separate, so a radio
   * mis-storing at block 3 still received all 58 blocks before anyone looked -
   * while the error text claimed nothing further had been written.
   */
  it('stops at the first block the radio fails to store', async () => {
    const eeprom = RAW.slice()
    let seen = 0
    const port = new FakeSerialPort({
      respond: (frame) => {
        const payload = xorArray(frame.subarray(4, 4 + frame[2]!))
        if (payload[0] === 0x14) {
          const body = new Uint8Array(0x28)
          body[0] = 0x15
          body[1] = 0x05
          for (let i = 0; i < FIRMWARE.length; i++) body[4 + i] = FIRMWARE.charCodeAt(i)
          return buildFrame(body)
        }
        if (payload[0] === 0x1b) {
          const addr = payload[4]! | (payload[5]! << 8)
          const len = payload[6]!
          const body = new Uint8Array(8 + len)
          body[0] = 0x1c
          body[4] = addr & 0xff
          body[5] = (addr >> 8) & 0xff
          body[6] = len
          body.set(eeprom.subarray(addr, addr + len), 8)
          return buildFrame(body)
        }
        if (payload[0] === 0x1d) {
          const addr = payload[4]! | (payload[5]! << 8)
          // Acknowledge correctly but store nothing: a tired EEPROM cell.
          seen++
          return buildFrame(Uint8Array.from([0x1e, 0x05, 0, 0, addr & 0xff, (addr >> 8) & 0xff]))
        }
        return null
      },
    })

    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)
    // Two separate blocks change, so a deferred verify would send both.
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'AAA' })
    cp.channels.set(2, { ...cp.channels.get(2)!, name: 'BBB' })

    const err = (await writable
      .writeImage(t, driver.encode(cp, image), { backup, baseImage: image, readTimeoutMs: 1000 })
      .catch((e: unknown) => e)) as WriteVerifyError & { partial?: WriteReport }

    expect(err).toBeInstanceOf(WriteVerifyError)
    expect(seen).toBe(1) // stopped after the first bad block, did not send the second
    expect(err.message).toMatch(/Writing stopped there/)
    expect(err.message).toMatch(/restore your backup/)
    // And it does not claim nothing was written.
    expect(err.message).not.toMatch(/Nothing further has been written/)
    await t.close()
  })

  it('carries the partial report out with the failure', async () => {
    // A half-programmed radio the user is not told about is worse than a
    // failure, so what was committed travels with the error.
    const eeprom = RAW.slice()
    const port = new FakeSerialPort({
      respond: (frame) => {
        const payload = xorArray(frame.subarray(4, 4 + frame[2]!))
        if (payload[0] === 0x14) {
          const body = new Uint8Array(0x28)
          body[0] = 0x15
          body[1] = 0x05
          for (let i = 0; i < FIRMWARE.length; i++) body[4 + i] = FIRMWARE.charCodeAt(i)
          return buildFrame(body)
        }
        if (payload[0] === 0x1b) {
          const addr = payload[4]! | (payload[5]! << 8)
          const len = payload[6]!
          const body = new Uint8Array(8 + len)
          body[0] = 0x1c
          body[4] = addr & 0xff
          body[5] = (addr >> 8) & 0xff
          body[6] = len
          body.set(eeprom.subarray(addr, addr + len), 8)
          return buildFrame(body)
        }
        return null // never acknowledges a write
      },
    })
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'AAA' })

    const err = (await writable
      .writeImage(t, driver.encode(cp, image), { backup, baseImage: image, readTimeoutMs: 300 })
      .catch((e: unknown) => e)) as Error & { partial?: WriteReport }
    expect(err.partial).toBeDefined()
    expect(err.partial!.blocksWritten).toBe(0)
    await t.close()
  })
})

describe('preconditions', () => {
  it('refuses an image whose programmable region is the wrong size', async () => {
    // A short region would send zero-length write commands to live addresses.
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const short: RadioImage = {
      ...image,
      regions: image.regions.map((r) => (r.start === 0 ? { ...r, data: r.data.slice(0, 0x1000) } : r)),
    }
    await expect(writable.writeImage(t, short, { backup, readTimeoutMs: 1000 })).rejects.toThrow(
      /expects exactly 7424/,
    )
    await t.close()
  })

  it('refuses when the driver as a whole is not cleared to write', async () => {
    // The schema is the build's own statement that the write path is unproven,
    // and the driver honours it rather than leaving it to the UI.
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    await expect(driver.writeImage(t, imageOf(eeprom), { backup, readTimeoutMs: 1000 })).rejects.toThrow(
      /has not been verified against hardware/,
    )
    await t.close()
  })

  it('refuses a codeplug carrying validation errors', async () => {
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)
    // 700 MHz is outside every band this radio has.
    cp.channels.set(1, { ...cp.channels.get(1)!, rxFreq: hz(700_000_000) })
    await expect(
      writable.writeImage(t, driver.encode(cp, image), { backup, baseImage: image, readTimeoutMs: 1000 }),
    ).rejects.toThrow(/programmed incorrectly/)
    await t.close()
  })

  it('refuses an image from a different radio', async () => {
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    await expect(
      writable.writeImage(t, { ...imageOf(eeprom), radioId: 'dm32uv' }, { readTimeoutMs: 1000 }),
    ).rejects.toThrow(/Not a UV-K5 image/)
    await t.close()
  })
})

describe('dry run', () => {
  it('exercises the real path but sends no writes', async () => {
    const { port, writes, eeprom } = radioPort(RAW.slice())
    const before = eeprom.slice()
    const t = await connect(port)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'DRY' })

    const report = await writable.writeImage(t, driver.encode(cp, image), {
      dryRun: true,
      baseImage: image,
      readTimeoutMs: 1000,
    })

    expect(report.dryRun).toBe(true)
    expect(report.blocksWritten).toBe(1)
    expect(writes).toHaveLength(0)
    expect(equalBytes(eeprom, before)).toBe(true)
    await t.close()
  })

  it('needs no backup, because it changes nothing', async () => {
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const image = imageOf(eeprom)
    await expect(
      writable.writeImage(t, image, { dryRun: true, baseImage: image, readTimeoutMs: 1000 }),
    ).resolves.toMatchObject({ dryRun: true, blocksWritten: 0 })
    await t.close()
  })
})

describe('leaving programming mode', () => {
  it('sends a reset after a successful write', async () => {
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'RST' })
    await writable.writeImage(t, driver.encode(cp, image), { backup, baseImage: image, readTimeoutMs: 1000 })
    await t.close()

    const sent = port.writtenBytes()
    // The reset frame, unobfuscated payload dd 05 00 00.
    const resetFrame = buildFrame(Uint8Array.from([0xdd, 0x05, 0x00, 0x00]))
    const hay = [...sent].join(',')
    expect(hay).toContain([...resetFrame].join(','))
  })
})

describe('validation covers the delta, not the radio’s pre-existing state', () => {
  it('writes a factory-fresh radio', async () => {
    // Two things have to hold for this: the transmit-permission rule exempts
    // the radio's own VFO band presets (which ship on 108.25 MHz in the air
    // band), and the write gate judges only what the edit changes.
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)

    expect(driver.validate(cp).filter((d) => d.severity === 'error')).toEqual([])

    cp.channels.set(1, { ...cp.channels.get(1)!, name: 'OK' })
    await expect(
      writable.writeImage(t, driver.encode(cp, image), { backup, baseImage: image, readTimeoutMs: 1000 }),
    ).resolves.toMatchObject({ blocksWritten: 1 })
    await t.close()
  })

  it('writes a channel that transmits in a receive-only band, and warns about it', async () => {
    // Deliberate policy, and a reversal: this used to be refused. Transmitting
    // into a receive-only allocation is a licensing question rather than a
    // hardware one - a different country's band plan, a commercial licence,
    // MARS/CAP - and boofwang is not the licensing authority. The warning is
    // loud and the write goes through. See lib/validate/rules.ts.
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, rxFreq: hz(120_000_000), txAllowed: true })

    const diag = driver.validate(cp).find((d) => d.ruleId === 'regulatory.band.tx-not-permitted')
    expect(diag, 'the warning must still be raised').toBeDefined()
    expect(diag!.severity).toBe('warning')
    expect(diag!.channel).toBe(1)

    await expect(
      writable.writeImage(t, driver.encode(cp, image), { backup, baseImage: image, readTimeoutMs: 1000 }),
    ).resolves.toMatchObject({ verified: true })
    await t.close()
  })

  it('still refuses a frequency the radio cannot tune at all', async () => {
    // The rule that did not move, and the reason the one above could. This is a
    // fact about the hardware: the UV-K5's bands stop at 600 MHz, so a channel
    // at 700 would be programmed and simply not work.
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, rxFreq: hz(700_000_000), txAllowed: true })

    const errors = driver.validate(cp).filter((d) => d.severity === 'error' && d.channel === 1)
    expect(errors.map((d) => d.ruleId)).toContain('radio.band.rx-out-of-range')

    await expect(
      writable.writeImage(t, driver.encode(cp, image), { backup, baseImage: image, readTimeoutMs: 1000 }),
    ).rejects.toThrow(/you have changed/)
    await t.close()
  })

  it('accepts that same channel once it is marked receive-only', async () => {
    const { port, eeprom } = radioPort(RAW.slice())
    const t = await connect(port)
    const backup = await backupFor(eeprom)
    const image = imageOf(RAW.slice())
    const cp = driver.decode(image)
    cp.channels.set(1, { ...cp.channels.get(1)!, rxFreq: hz(120_000_000), txAllowed: false })
    await expect(
      writable.writeImage(t, driver.encode(cp, image), { backup, baseImage: image, readTimeoutMs: 1000 }),
    ).resolves.toMatchObject({ verified: true })
    await t.close()
  })
})
