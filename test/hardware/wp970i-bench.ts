// SPDX-License-Identifier: GPL-3.0-or-later
import { expect } from 'vitest'
import { hexDump } from '#core/codec/checksum.js'
import { equalBytes } from '#core/codec/struct.js'
import type { IdentifyResult, RadioDriver } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { nameAddr, NAME_LENGTH } from '#core/radios/uv9r/layout.js'
import { IMAGE_SIZE, MEM_SIZE } from '#core/radios/uv9r/protocol.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { BridgeSerialPort, listBridgePorts } from '#core/transport/bridge-serial-port.js'

/**
 * The two bench sessions a WP970I-family radio needs before it is written.
 *
 * Shared by test/hardware/uv9r.spec.ts and uv9g.spec.ts, which differ only in
 * the driver they hand in. Neither has been run: nobody working on boofwang
 * has one of these radios. When someone does, the read session comes first
 * and its printed numbers go into docs/protocols/uv9r.md; the write cycle is
 * what would justify the registry line that turns writing on.
 */
export const BRIDGE = process.env.BOOFWANG_BRIDGE ?? 'ws://127.0.0.1:8765'
export const PORT = process.env.BOOFWANG_HW_PORT ?? ''

const memOf = (img: RadioImage) => img.regions[0]!.data

async function bench(driver: RadioDriver) {
  expect(PORT, 'set BOOFWANG_HW_PORT to the adapter path').not.toBe('')
  const ports = await listBridgePorts(BRIDGE)
  const info = ports.find((p) => p.path === PORT)
  expect(info, `the bridge does not see ${PORT}. It offers: ${ports.map((p) => p.path).join(', ')}`).toBeTruthy()

  let lastClosed = 0
  return async function session<T>(fn: (t: SerialTransport, ident: IdentifyResult) => Promise<T>): Promise<T> {
    // The radio leaves clone mode when the port closes, and wants a moment
    // before it will answer a new handshake.
    const since = Date.now() - lastClosed
    if (since < 1_500) await new Promise((r) => setTimeout(r, 1_500 - since))
    const t = new SerialTransport(new BridgeSerialPort(BRIDGE, info!))
    await t.open(driver.serial)
    try {
      return await fn(t, await driver.identify(t, {}))
    } finally {
      await t.close().catch(() => {})
      lastClosed = Date.now()
    }
  }
}

/**
 * Identify, read twice, agree with itself, and print what the protocol note
 * needs. Reads only.
 */
export async function readSession(driver: RadioDriver): Promise<void> {
  const session = await bench(driver)

  const { first, ident } = await session(async (t, ident) => ({ first: await driver.readImage(t, ident, {}), ident }))

  console.log(
    [
      '',
      `--- paste into docs/protocols/${driver.id}.md ---`,
      `ident bytes:     ${hexDump(ident.raw)}`,
      `firmware window: ${String(ident.meta?.firmwareWindow)}`,
      `firmware:        ${JSON.stringify(ident.variant)}`,
      `dropped byte:    ${String(ident.meta?.droppedByte)}`,
      `writable:        ${ident.caps.write} ${ident.caps.reason ?? ''}`,
      `image bytes:     ${memOf(first).length}`,
      `sha256:          ${first.sha256}`,
      `unit:            ${await driver.unitFingerprint(first)}`,
      '------------------------------------------------',
      '',
    ].join('\n'),
  )

  expect(ident.radioId).toBe(driver.id)
  expect(memOf(first).length).toBe(IMAGE_SIZE)
  // The ident goes after the memory, and is what the radio sent.
  expect([...memOf(first).subarray(MEM_SIZE)]).toEqual([...ident.raw])

  // A second read. Two that disagree mean the read path is not repeatable,
  // which has to be settled before a write is ever considered.
  const second = await session((t, ident) => driver.readImage(t, ident, {}))
  expect(second.sha256).toBe(first.sha256)
  expect(equalBytes(memOf(second), memOf(first))).toBe(true)

  // The invariant a write would rest on, on this radio's own bytes.
  expect(equalBytes(memOf(driver.encode(driver.decode(first), first)), memOf(first))).toBe(true)
}

/**
 * The write cycle CLAUDE.md asks for, step for step: baseline, one real edit,
 * write, a fresh-session read showing only the intended bytes moved, a restore
 * with no base image, and the original sha256 back.
 *
 * The edit is the one that found the UV-5R's write shape: a rename to a
 * *shorter* name. A radio that cannot reprogram a byte without a sweep leaves
 * the tail of the old name behind, and the fresh read says so.
 */
export async function writeCycle(driver: RadioDriver): Promise<void> {
  const session = await bench(driver)

  const { baseline, ident0 } = await session(async (t, ident) => {
    expect(ident.caps.write, ident.caps.reason ?? 'the build does not offer writing').toBe(true)
    return { baseline: await driver.readImage(t, ident, {}), ident0: ident }
  })
  console.log(`\nbaseline ${baseline.sha256}\n${hexDump(memOf(baseline), 64)}\n`)
  const backup = {
    id: 'bench',
    identHash: ident0.identHash,
    createdAt: new Date().toISOString(),
    unitHash: await driver.unitFingerprint(baseline),
  }

  const doc = driver.decode(baseline)
  const slot = [...doc.channels.values()].sort((a, b) => a.index - b.index).find((c) => c.name.length >= 3)
  expect(slot, 'the radio holds no channel with a name of three characters or more to shorten').toBeTruthy()
  const ch = slot!
  // Shorter than what is there, and never the name already there.
  const renamed = ch.name.slice(0, 2) === 'BF' ? 'XB' : 'BF'
  doc.channels.set(ch.index, { ...ch, name: renamed })
  const edited = driver.encode(doc, baseline)

  const report = await session((t, ident) => driver.writeImage(t, edited, { backup, baseImage: baseline, ident }))
  expect(report.verified).toBe(true)
  console.log(`\nwrite: ${report.blocksWritten} block(s) at ${report.operations.map((o) => o.label).join(', ')}\n`)

  const after = await session((t, ident) => driver.readImage(t, ident, {}))
  const lo = nameAddr(ch.index - 1)
  const hi = lo + NAME_LENGTH
  const a = memOf(after)
  const b = memOf(baseline)
  const moved: number[] = []
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) moved.push(i)
  console.log(`\nfresh read: ${moved.length} byte(s) moved: ${moved.map((x) => `0x${x.toString(16)}`).join(' ')}\n`)
  expect(moved.length).toBeGreaterThan(0)
  for (const at of moved) expect(at >= lo && at < hi, `byte 0x${at.toString(16)} moved outside the name`).toBe(true)
  // The whole name, tail included: the old characters past the new name must
  // be gone, which is the failure a sparse write produced on the UV-5R.
  expect([...a.subarray(lo + renamed.length, hi)]).toEqual(new Array(NAME_LENGTH - renamed.length).fill(0xff))
  expect(driver.decode(after).channels.get(ch.index)!.name).toBe(renamed)

  // Restore with no base image, so the recovery path is the one exercised.
  const restore = await session((t, ident) => driver.writeImage(t, baseline, { backup, ident }))
  expect(restore.verified).toBe(true)

  const final = await session((t, ident) => driver.readImage(t, ident, {}))
  expect(equalBytes(memOf(final), memOf(baseline))).toBe(true)
  expect(final.sha256).toBe(baseline.sha256)
  console.log(`\nrestored to ${final.sha256}\n`)
}
