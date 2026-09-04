// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import type { IdentifyResult } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5rDriver } from '#core/radios/uv5r/driver.js'
import { classifyBasetype, MAGIC_UV5R_291, MAGIC_UV5R_ORIG } from '#core/radios/uv5r/protocol.js'
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
 * It reads and never writes, which is the whole point: no UV-5R has been on a
 * cable, so this driver is read-only and there is no evidence a write would
 * land where it is aimed. What this session is for is producing that evidence
 * in the right order - identify, read, read again and compare, and record the
 * firmware string. Only then is the write half of this file worth writing, and
 * `docs/protocols/uv5r.md` lists what else has to happen first.
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
