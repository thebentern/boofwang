// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import type { IdentifyResult } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5rMiniDriver } from '#core/radios/uv5rmini/driver.js'
import { CHANNEL_BASE, CHANNEL_SIZE, NAME_LENGTH } from '#core/radios/uv5rmini/layout.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { RecordingTransport } from '#core/transport/recording-transport.js'
import { BridgeSerialPort, listBridgePorts } from '#core/transport/bridge-serial-port.js'

/**
 * The UV-5R Mini write path over Bluetooth, against a real radio.
 *
 * This is the evidence docs/protocols/uv5rmini.md asks for before a Bluetooth
 * write is allowed anywhere: "read first, prove the round trip, then add
 * bluetooth to writeTransports and pass allowBluetoothWrite - both in the
 * same commit, with the wire byte counts recorded". The application never
 * passes `allowBluetoothWrite`; this file does, on the bench, through the
 * BLE bridge, which is the one harness the README documents for Bluetooth on
 * hardware.
 *
 * Why this is the risky one. The Mini erases a whole flash page per block
 * and the upload rewrites every block, so a link that drops halfway leaves a
 * wiped radio rather than a half-written one, and Bluetooth is a fortieth of
 * the cable's speed with a 20-byte GATT write under each 0x80 block. Before
 * running it: a fresh battery, the radio within a metre, and a cable on the
 * bench for the restore this test cannot do if the link goes.
 *
 * Skipped unless `BOOFWANG_HW` is set, because it needs a UV-5R Mini in its
 * wireless programming mode and the BLE bridge (`pnpm bridge:ble`) running:
 *
 *   BOOFWANG_HW=1 BOOFWANG_HW_PORT=<address the bridge lists> pnpm vitest run test/hardware/uv5rmini-ble-write
 *
 * It takes its own baseline first and restores it at the end, then reads
 * once more and asserts the bytes came back. The trace of every session is
 * printed, so the byte counts the protocol note wants are in the output
 * whether the test passes or not.
 */
const HW = !!process.env.BOOFWANG_HW
const URL_ = process.env.BOOFWANG_BRIDGE ?? 'ws://127.0.0.1:8766'
const PORT = process.env.BOOFWANG_HW_PORT ?? ''

const driver = createUv5rMiniDriver({ enableWrite: true, allowBluetoothWrite: true })

describe.skipIf(!HW)('UV-5R Mini over Bluetooth on the bench', () => {
  it('reads, renames one channel, verifies each byte, and restores', { timeout: 1_800_000 }, async () => {
    expect(PORT, 'set BOOFWANG_HW_PORT to the address the BLE bridge lists').not.toBe('')
    const ports = await listBridgePorts(URL_)
    const info = ports.find((p) => p.path === PORT)
    expect(info, `the bridge does not see ${PORT}. It offers: ${ports.map((p) => p.path).join(', ')}`).toBeTruthy()
    expect(info!.kind, 'this test is about the Bluetooth carrier; the bridge reports something else').toBe('bluetooth')

    const traces: string[] = []
    let lastClosed = 0
    async function session<T>(label: string, fn: (t: RecordingTransport, ident: IdentifyResult) => Promise<T>): Promise<T> {
      const since = Date.now() - lastClosed
      if (since < 1_500) await new Promise((r) => setTimeout(r, 1_500 - since))
      const t = new RecordingTransport(new SerialTransport(new BridgeSerialPort(URL_, info!)), label)
      const started = Date.now()
      await t.open(driver.serial)
      try {
        const ident = await driver.identify(t, {})
        return await fn(t, ident)
      } finally {
        await t.close().catch(() => {})
        lastClosed = Date.now()
        const trace = t.toTrace()
        const tx = trace.entries.filter((e) => e.dir === 'tx').reduce((n, e) => n + e.hex.length / 2, 0)
        const rx = trace.entries.filter((e) => e.dir === 'rx').reduce((n, e) => n + e.hex.length / 2, 0)
        traces.push(`${label}: ${tx} bytes sent, ${rx} bytes received, ${((lastClosed - started) / 1000).toFixed(1)} s`)
      }
    }

    const memOf = (img: RadioImage) => img.regions[0]!.data

    try {
      const { baseline, ident0 } = await session('baseline read', async (t, ident) => {
        expect(ident.radioId).toBe('uv5rmini')
        expect(t.kind).toBe('bluetooth')
        expect(ident.caps.write, ident.caps.reason ?? '').toBe(true)
        return { baseline: await driver.readImage(t, ident, {}), ident0: ident }
      })
      const backup = { id: 'bench', identHash: ident0.identHash, createdAt: new Date().toISOString() }

      // The smallest edit that proves the whole path: one channel name.
      const doc = driver.decode(baseline)
      const slot = [...doc.channels.keys()].sort((a, b) => a - b)[0]!
      const ch = doc.channels.get(slot)!
      expect(ch.name).not.toBe('BOOF')
      doc.channels.set(slot, { ...ch, name: 'BOOF' })
      const edited = driver.encode(doc, baseline)

      const report = await session('write', (t, ident) =>
        driver.writeImage(t, edited, { backup, baseImage: baseline, ident }),
      )
      expect(report.verified).toBe(true)
      expect(report.blocksWritten).toBeGreaterThan(0)

      // A fresh session's read must show the rename and nothing else, bar
      // the radio's own state bytes the protocol note lists.
      const after = await session('read back', (t, ident) => driver.readImage(t, ident, {}))
      {
        const a = memOf(after)
        const b = memOf(baseline)
        const changed: number[] = []
        for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) changed.push(i)
        const nameAt = CHANNEL_BASE + (slot - 1) * CHANNEL_SIZE + 0x14
        expect(changed.length).toBeGreaterThan(0)
        for (const at of changed) {
          expect(at >= nameAt && at < nameAt + NAME_LENGTH, `byte 0x${at.toString(16)} moved`).toBe(true)
        }
        expect(driver.decode(after).channels.get(slot)!.name).toBe('BOOF')
      }

      const restore = await session('restore', (t, ident) => driver.writeImage(t, baseline, { backup, ident }))
      expect(restore.verified).toBe(true)

      const final = await session('final read', (t, ident) => driver.readImage(t, ident, {}))
      expect(equalBytes(memOf(final), memOf(baseline))).toBe(true)
      expect(final.sha256).toBe(baseline.sha256)
    } finally {
      // The numbers the protocol note wants, pass or fail.
      console.log(traces.join('\n'))
    }
  })
})
