// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { createDriver } from '#core/radio/registry.js'
import { createUv9rDriver } from '#core/radios/uv9r/driver.js'
import { IMAGE_SIZE } from '#core/radios/uv9r/protocol.js'
import { readSession, writeCycle } from './wp970i-bench.js'

/**
 * The bench sessions that would settle the Baofeng UV-9R. Never run.
 *
 * Skipped unless `BOOFWANG_HW` is set, because they need a UV-9R on a cable and
 * the development serial bridge (`pnpm bridge`) running:
 *
 *   BOOFWANG_HW=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX pnpm vitest run test/hardware/uv9r.spec.ts
 *
 * The read session prints what docs/protocols/uv9r.md is missing - the ident
 * this unit sends, its firmware window, whether it drops the byte at 0x1FCF,
 * and a sha256 two reads agree on. Check the plug first: this radio's
 * screw-in connector seated badly has produced every symptom of a protocol
 * fault on CHIRP's tracker.
 */
const HW = !!process.env.BOOFWANG_HW

describe.skipIf(!HW)('UV-9R on the bench', () => {
  it('identifies, reads twice, and agrees with itself', { timeout: 600_000 }, async () => {
    await readSession(createDriver('uv9r'))
  })

  it('will not write, and says so', { timeout: 60_000 }, async () => {
    // The registry's driver, which is the one the product uses.
    const registry = createDriver('uv9r')
    expect(registry.schema.capabilities.write).toBe(false)
    await expect(
      registry.writeImage({} as never, {
        radioId: 'uv9r',
        variant: '',
        layout: 'uv9r',
        createdAt: new Date().toISOString(),
        regions: [{ start: 0, data: new Uint8Array(IMAGE_SIZE), label: 'image' }],
        meta: {},
        sha256: '',
      }, { backup: { id: 'x', identHash: 'x', createdAt: new Date().toISOString() } }),
    ).rejects.toThrow(/UV-9R is not enabled/)
  })
})

/**
 * The write cycle. Gated twice: `BOOFWANG_HW_WRITE=1` as well, so a habitual
 * read run never turns into a write to a radio boofwang has never written.
 *
 *   BOOFWANG_HW=1 BOOFWANG_HW_WRITE=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX \
 *     pnpm vitest run test/hardware/uv9r.spec.ts
 *
 * The driver is the one the registry line would build once it passes
 * `enableWrite: true`, and nothing else is forced: if `identify` does not
 * offer writing on this radio by its own rules, the cycle stops before
 * sending a byte. Take the baseline the read session prints and save it to a
 * file before running this.
 */
const HW_WRITE = HW && !!process.env.BOOFWANG_HW_WRITE

describe.skipIf(!HW_WRITE)('UV-9R write cycle on the bench', () => {
  it('shortens one name, verifies in a fresh session, and restores', { timeout: 900_000 }, async () => {
    await writeCycle(createUv9rDriver({ enableWrite: true }))
  })
})
