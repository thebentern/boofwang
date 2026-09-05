// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import type { IdentifyResult } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5rDriver } from '#core/radios/uv5r/driver.js'
import { classifyBasetype, MAGIC_UV5R_291, MAGIC_UV5R_ORIG } from '#core/radios/uv5r/protocol.js'
import { NAME_LENGTH, nameAddr } from '#core/radios/uv82/layout.js'
import { IMAGE_SIZE } from '#core/radios/uv82/protocol.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { BridgeSerialPort, listBridgePorts } from '#core/transport/bridge-serial-port.js'

/**
 * The bench session that would settle the UV-5R, against a real radio.
 *
 * Skipped unless `BOOFWANG_HW` is set, because it needs a UV-5R on a cable and
 * the development serial bridge (`pnpm bridge`) running:
 *
 *   BOOFWANG_HW=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX pnpm vitest run test/hardware
 *
 * It reads and never writes, which is the whole point. It has now been run
 * once, on 2026-09-05, and the numbers are in `docs/protocols/uv5r.md`: a real
 * UV-5R identified and read twice, byte-identical. That is evidence about the
 * read path and none at all about a write landing where it is aimed, so this
 * driver stays read-only and the write half of this file stays unwritten.
 * `docs/protocols/uv5r.md` lists what else has to happen first - an
 * independent reader outside the app is the next step, not a write.
 *
 * Run it and paste the printed numbers into that document. The two reads have
 * to agree byte for byte: a radio that hands back a different image on the
 * second pass is one whose read path is not yet trustworthy, and that is a
 * thing to find out before anything is ever sent to it.
 */
const HW = !!process.env.BOOFWANG_HW
const URL_ = process.env.BOOFWANG_BRIDGE ?? 'ws://127.0.0.1:8765'
const PORT = process.env.BOOFWANG_HW_PORT ?? ''

const driver = createUv5rDriver()

describe.skipIf(!HW)('UV-5R on the bench', () => {
  it('identifies, reads twice, and agrees with itself', { timeout: 600_000 }, async () => {
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

    const { first, ident0 } = await session(async (t, ident) => {
      expect(ident.radioId).toBe('uv5r')
      return { first: await driver.readImage(t, ident, {}), ident0: ident }
    })

    /*
     * Everything a protocol document needs, printed rather than asserted.
     *
     * Which magic the radio answered is the one thing this test cannot see
     * directly - `identify` returns the ident block, not the magic that drew
     * it - so it is derived: a BFB string below 291 means the original radio
     * and therefore `UV5R_MODEL_ORIG`. Note it by hand if it matters.
     */
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')
    const bfb = /BFB(\d{3})/.exec(ident0.variant)
    const likelyMagic = bfb && Number(bfb[1]) < 291 ? MAGIC_UV5R_ORIG : MAGIC_UV5R_291
    console.log(
      [
        '',
        '--- paste into docs/protocols/uv5r.md ---',
        `firmware:        ${JSON.stringify(ident0.variant)}`,
        `classified as:   ${JSON.stringify(classifyBasetype(ident0.variant))}`,
        `ident bytes:     ${hex(ident0.raw)}`,
        `magic (implied): ${hex(likelyMagic)}`,
        `image bytes:     ${memOf(first).length}`,
        `sha256:          ${first.sha256}`,
        `writable:        ${ident0.caps.write} ${ident0.caps.reason ?? ''}`,
        `dropped byte:    ${String(ident0.meta?.droppedByte)}`,
        '-----------------------------------------',
        '',
      ].join('\n'),
    )

    expect(memOf(first).length).toBe(IMAGE_SIZE)
    // The ident block prefixes the image and the radio sent it; a mismatch
    // means the image was assembled from the wrong pieces.
    expect([...memOf(first).subarray(0, 8)]).toEqual([...ident0.raw.subarray(0, 8)])
    expect(memOf(first).at(7)).toBe(0xdd)

    // A second, independent read. Two passes that disagree mean the read path
    // is not repeatable, which has to be settled before a write is considered.
    const second = await session((t, ident) => driver.readImage(t, ident, {}))
    expect(second.sha256).toBe(first.sha256)
    expect(equalBytes(memOf(second), memOf(first))).toBe(true)

    // And the invariant a write would eventually rest on, on this radio's own
    // bytes rather than a sibling's.
    expect(equalBytes(driver.encode(driver.decode(first), first).regions[0]!.data, memOf(first))).toBe(true)
  })

  it('will not write, and says so', { timeout: 60_000 }, async () => {
    // The claim under test is that a real radio cannot be written by this
    // build even with a radio present and a backup in hand.
    expect(driver.schema.capabilities.write).toBe(false)
    await expect(
      driver.writeImage({} as never, {
        radioId: 'uv5r',
        variant: '',
        layout: 'uv5r',
        createdAt: new Date().toISOString(),
        regions: [{ start: 0, data: new Uint8Array(IMAGE_SIZE), label: 'image' }],
        meta: {},
        sha256: '',
      }, { backup: { id: 'x', identHash: 'x', createdAt: new Date().toISOString() } }),
    ).rejects.toThrow(/UV-5R/)
  })
})

/**
 * The write path, against the same radio. Gated twice, deliberately.
 *
 * `BOOFWANG_HW` is not enough: this is the only spec in the tree that sends
 * bytes to a radio nobody had ever written, so it also wants
 * `BOOFWANG_HW_WRITE=1`. Running the read session by habit must never turn
 * into a write.
 *
 *   BOOFWANG_HW=1 BOOFWANG_HW_WRITE=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX \
 *     pnpm vitest run test/hardware/uv5r.spec.ts
 *
 * It takes its own baseline first and restores it at the end, then reads once
 * more and asserts the bytes came back - so a failure leaves evidence rather
 * than a radio in an unknown state.
 *
 * Nothing is forced. This is the driver the registry builds, refusing or
 * allowing the write on its own terms, which is the only version of this test
 * worth trusting: it passed once with `ident.caps.write` forced on, and that
 * proved the wire worked while saying nothing about whether the product would
 * ever get there.
 */
const HW_WRITE = HW && !!process.env.BOOFWANG_HW_WRITE
const writable = createUv5rDriver({ enableWrite: true })

describe.skipIf(!HW_WRITE)('UV-5R write cycle on the bench', () => {
  it('reads, renames one channel, verifies each byte, and restores', { timeout: 600_000 }, async () => {
    expect(PORT, 'set BOOFWANG_HW_PORT to the adapter path').not.toBe('')
    const ports = await listBridgePorts(URL_)
    const info = ports.find((p) => p.path === PORT)
    expect(info, `the bridge does not see ${PORT}. It offers: ${ports.map((p) => p.path).join(', ')}`).toBeTruthy()

    let lastClosed = 0
    async function session<T>(fn: (t: SerialTransport, ident: IdentifyResult) => Promise<T>): Promise<T> {
      const since = Date.now() - lastClosed
      if (since < 1_500) await new Promise((r) => setTimeout(r, 1_500 - since))
      const t = new SerialTransport(new BridgeSerialPort(URL_, info!))
      await t.open(writable.serial)
      try {
        const ident = await writable.identify(t, {})
        expect(ident.caps.write, ident.caps.reason ?? '').toBe(true)
        return await fn(t, ident)
      } finally {
        await t.close().catch(() => {})
        lastClosed = Date.now()
      }
    }

    const memOf = (img: RadioImage) => img.regions[0]!.data

    const { baseline, ident0 } = await session(async (t, ident) => {
      expect(ident.radioId).toBe('uv5r')
      return { baseline: await writable.readImage(t, ident, {}), ident0: ident }
    })
    const backup = { id: 'bench', identHash: ident0.identHash, createdAt: new Date().toISOString() }

    // A rename is the smallest edit that exercises the whole path: diff, block
    // write, acknowledgement, read-back.
    const doc = writable.decode(baseline)
    const slot = [...doc.channels.keys()].sort((a, b) => a - b)[0]!
    const ch = doc.channels.get(slot)!
    // Not a fixed string: an interrupted run leaves its own name behind, and a
    // rename to the name already there would prove nothing.
    const renamed = ch.name === 'BOOF' ? 'BOOF2' : 'BOOF'
    doc.channels.set(slot, { ...ch, name: renamed })
    const edited = writable.encode(doc, baseline)

    const report = await session((t, ident) =>
      writable.writeImage(t, edited, { backup, baseImage: baseline, ident }),
    )
    expect(report.verified).toBe(true)
    // A sweep, not a diff: this radio cannot reprogram a byte, so every owned
    // block goes every time. One block would mean `writesWholeImage` was lost.
    expect(report.blocksWritten).toBeGreaterThan(1)

    // A fresh session's read must show the rename and nothing else.
    const after = await session((t, ident) => writable.readImage(t, ident, {}))
    {
      const a = memOf(after)
      const b = memOf(baseline)
      const changed: number[] = []
      for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) changed.push(i)
      const lo = nameAddr(slot - 1)
      const hi = lo + NAME_LENGTH
      console.log(`\nwrite cycle: ${changed.length} bytes moved, name field 0x${lo.toString(16)}-0x${hi.toString(16)}\n`)
      expect(changed.length).toBeGreaterThan(0)
      for (const at of changed) {
        expect(at >= lo && at < hi, `byte 0x${at.toString(16)} moved outside the name field`).toBe(true)
      }
      expect(writable.decode(after).channels.get(slot)!.name).toBe(renamed)
    }

    // Restore with no base image: the recovery path reads the radio first and
    // diffs against that, which is what a real restore does.
    const restore = await session((t, ident) => writable.writeImage(t, baseline, { backup, ident }))
    expect(restore.verified).toBe(true)
    expect(restore.blocksWritten).toBe(report.blocksWritten)

    const final = await session((t, ident) => writable.readImage(t, ident, {}))
    expect(equalBytes(memOf(final), memOf(baseline))).toBe(true)
    expect(final.sha256).toBe(baseline.sha256)
    console.log(`\nrestored to ${final.sha256}\n`)
  })
})
