// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import type { IdentifyResult } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5gDriver } from '#core/radios/uv5g/driver.js'
import { NAME_LENGTH, nameAddr } from '#core/radios/uv82/layout.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { BridgeSerialPort, listBridgePorts } from '#core/transport/bridge-serial-port.js'

/**
 * The UV-5G write path, against a real radio.
 *
 * Skipped unless `BOOFWANG_HW` is set, because it needs a UV-5G on a cable and
 * the development serial bridge (`pnpm bridge`) running:
 *
 *   BOOFWANG_HW=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX pnpm vitest run test/hardware
 *
 * It takes its own baseline before touching anything and restores it at the
 * end, then reads the radio once more and asserts the bytes came back - so a
 * failure leaves evidence rather than a radio in an unknown state.
 */
const HW = !!process.env.BOOFWANG_HW
const URL_ = process.env.BOOFWANG_BRIDGE ?? 'ws://127.0.0.1:8765'
const PORT = process.env.BOOFWANG_HW_PORT ?? ''

const driver = createUv5gDriver({ enableWrite: true })

describe.skipIf(!HW)('UV-5G on the bench', () => {
  it('reads, renames one channel, verifies each byte, and restores', { timeout: 600_000 }, async () => {
    expect(PORT, 'set BOOFWANG_HW_PORT to the adapter path').not.toBe('')
    const ports = await listBridgePorts(URL_)
    const info = ports.find((p) => p.path === PORT)
    expect(info, `the bridge does not see ${PORT}. It offers: ${ports.map((p) => p.path).join(', ')}`).toBeTruthy()

    let lastClosed = 0
    async function session<T>(fn: (t: SerialTransport, ident: IdentifyResult) => Promise<T>): Promise<T> {
      // The radio drops out of clone mode when the port closes and needs a
      // moment before it will answer a new handshake.
      const since = Date.now() - lastClosed
      if (since < 1_500) await new Promise((r) => setTimeout(r, 1_500 - since))
      const t = new SerialTransport(new BridgeSerialPort(URL_, info!))
      await t.open(driver.serial)
      try {
        const ident = await driver.identify(t, {})
        return await fn(t, ident)
      } finally {
        await t.close().catch(() => {})
        lastClosed = Date.now()
      }
    }

    const memOf = (img: RadioImage) => img.regions[0]!.data

    // Baseline. Everything below is measured against this, and the test ends
    // by putting it back.
    const { baseline, ident0 } = await session(async (t, ident) => {
      expect(ident.radioId).toBe('uv5g')
      expect(ident.caps.write, ident.caps.reason ?? '').toBe(true)
      return { baseline: await driver.readImage(t, ident, {}), ident0: ident }
    })
    const backup = { id: 'bench', identHash: ident0.identHash, createdAt: new Date().toISOString() }

    // Rename the first named channel. The name table is one of the three
    // ranges the driver owns, and a rename is the smallest edit that proves
    // the whole path: diff, block write, acknowledgement, read-back.
    const doc = driver.decode(baseline)
    const slot = [...doc.channels.keys()].sort((a, b) => a - b)[0]!
    const ch = doc.channels.get(slot)!
    expect(ch.name).not.toBe('BOOF')
    doc.channels.set(slot, { ...ch, name: 'BOOF' })
    const edited = driver.encode(doc, baseline)

    const report = await session((t, ident) =>
      driver.writeImage(t, edited, { backup, baseImage: baseline, ident }),
    )
    expect(report.verified).toBe(true)
    expect(report.blocksWritten).toBe(1)

    // A fresh session's read must show the rename and nothing else.
    const after = await session((t, ident) => driver.readImage(t, ident, {}))
    {
      const a = memOf(after)
      const b = memOf(baseline)
      const changed: number[] = []
      for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) changed.push(i)
      const nameField: [number, number] = [nameAddr(slot - 1), nameAddr(slot - 1) + NAME_LENGTH]
      expect(changed.length).toBeGreaterThan(0)
      for (const at of changed) {
        expect(at >= nameField[0] && at < nameField[1], `byte 0x${at.toString(16)} moved`).toBe(true)
      }
      expect(driver.decode(after).channels.get(slot)!.name).toBe('BOOF')
    }

    // Restore. No base image, deliberately: the restore path reads the radio
    // first and diffs against that, which is the path a real recovery takes.
    const restore = await session((t, ident) => driver.writeImage(t, baseline, { backup, ident }))
    expect(restore.verified).toBe(true)
    expect(restore.blocksWritten).toBe(1)

    const final = await session((t, ident) => driver.readImage(t, ident, {}))
    expect(equalBytes(memOf(final), memOf(baseline))).toBe(true)
    expect(final.sha256).toBe(baseline.sha256)
  })
})
