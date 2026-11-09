// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { createDriver } from '#core/radio/registry.js'
import { createUv9gDriver } from '#core/radios/uv9g/driver.js'
import { readSession, writeCycle } from './wp970i-bench.js'

/**
 * The bench sessions that would settle the Baofeng UV-9G. Never run.
 *
 * The UV-9R's, behind the UV-9G's magic - see test/hardware/uv9r.spec.ts for
 * what each prints and why the write cycle is gated twice.
 *
 *   BOOFWANG_HW=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX pnpm vitest run test/hardware/uv9g.spec.ts
 *   BOOFWANG_HW=1 BOOFWANG_HW_WRITE=1 BOOFWANG_HW_PORT=... pnpm vitest run test/hardware/uv9g.spec.ts
 *
 * One thing to look for that the UV-9R does not have: whether the first
 * magic after the radio has sat idle is refused. This radio sends the UV-5G's
 * ident byte for byte, and the UV-5G refuses that first contact every time.
 */
const HW = !!process.env.BOOFWANG_HW
const HW_WRITE = HW && !!process.env.BOOFWANG_HW_WRITE

describe.skipIf(!HW)('UV-9G on the bench', () => {
  it('identifies, reads twice, and agrees with itself', { timeout: 600_000 }, async () => {
    await readSession(createDriver('uv9g'))
  })

  it('will not write from the registry build', () => {
    expect(createDriver('uv9g').schema.capabilities.write).toBe(false)
  })
})

describe.skipIf(!HW_WRITE)('UV-9G write cycle on the bench', () => {
  it('shortens one name, verifies in a fresh session, and restores', { timeout: 900_000 }, async () => {
    await writeCycle(createUv9gDriver({ enableWrite: true }))
  })
})
