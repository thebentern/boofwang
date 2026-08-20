// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { hz, mW } from '#core/model/units.js'
import type { RadioImage } from '#core/radio/image.js'
import type { IdentifyResult } from '#core/radio/driver.js'
import { createDm32uvDriver } from '#core/radios/dm32uv/driver.js'
import { REOPEN_SETTLE_MS } from '#core/radios/dm32uv/protocol.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { BridgeSerialPort, listBridgePorts } from '#core/transport/bridge-serial-port.js'

/**
 * The DM-32UV write path, against a real radio.
 *
 * Skipped unless `BOOFWANG_HW` is set, because it needs a DM-32UV on a cable
 * and the development serial bridge (`pnpm bridge`) running:
 *
 *   BOOFWANG_HW=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX pnpm vitest run test/hardware
 *
 * It takes its own baseline before touching anything and restores it at the
 * end, then reads the radio once more and asserts the bytes came back - so a
 * failure leaves evidence rather than a radio in an unknown state.
 *
 * Everything here is checked against raw bytes at documented offsets rather
 * than against boofwang's own decoder. Decoder and encoder shared a wrong bit
 * for transmit-forbid for the whole of this driver's life, and every
 * self-consistent test passed the entire time.
 */
const HW = !!process.env.BOOFWANG_HW
const URL_ = process.env.BOOFWANG_BRIDGE ?? 'ws://127.0.0.1:8765'
const PORT = process.env.BOOFWANG_HW_PORT ?? ''

const driver = createDm32uvDriver({ enableWrite: true })
const CHANNEL_BLOCK = 0x12
const HEADER = 0x10
const SIZE = 48

describe.skipIf(!HW)('DM-32UV on the bench', () => {
  it('reads, edits every field it can write, verifies each byte, and restores', { timeout: 1_800_000 }, async () => {
    expect(PORT, 'set BOOFWANG_HW_PORT to the adapter path').not.toBe('')
    const ports = await listBridgePorts(URL_)
    const info = ports.find((p) => p.path === PORT)
    expect(info, `the bridge does not see ${PORT}. It offers: ${ports.map((p) => p.path).join(', ')}`).toBeTruthy()

    // One connection per operation, as the app does. This radio has no command
    // to leave programming mode; it resets when the port closes, and needs a
    // moment afterwards before it will answer a handshake.
    let first = true
    async function session<T>(fn: (t: SerialTransport, ident: IdentifyResult) => Promise<T>): Promise<T> {
      if (!first) await new Promise((r) => setTimeout(r, REOPEN_SETTLE_MS + 800))
      first = false
      const t = new SerialTransport(new BridgeSerialPort(URL_, info!))
      await t.open(driver.serial)
      try {
        return await fn(t, await driver.identify(t, {}))
      } finally {
        await t.close().catch(() => {})
      }
    }

    const read = () => session(async (t, ident) => ({ image: await driver.readImage(t, ident, {}), ident }))
    const block = (img: RadioImage, id: number) => img.regions.find((r) => r.start === (id << 12))!.data
    const record = (img: RadioImage, n: number) => {
      const at = HEADER + n * SIZE
      return block(img, CHANNEL_BLOCK).subarray(at, at + SIZE)
    }
    const indexOfName = (img: RadioImage, want: string) => {
      for (let n = 0; ; n++) {
        const at = HEADER + n * SIZE
        if (at + SIZE > 0xfff) throw new Error(`no channel record named ${want}`)
        const raw = record(img, n)
        const end = raw.findIndex((b, i) => i < 16 && (b === 0 || b === 0xff))
        const name = new TextDecoder('latin1').decode(raw.subarray(0, end < 0 ? 16 : end))
        if (name === want) return n
      }
    }

    const { image: baseline, ident } = await read()
    const backup = {
      id: 'hw',
      identHash: ident.identHash,
      unitHash: await driver.unitFingerprint!(baseline),
      createdAt: new Date().toISOString(),
    }

    try {
      const doc = driver.decode(baseline)
      // Two analog channels and one transmit-forbidden digital one. Named
      // rather than positional so a failure says which channel.
      const analog = [...doc.channels.values()].filter((c) => c.modulation === 'FM' && c.txAllowed)
      const forbidden = [...doc.channels.values()].find((c) => !c.txAllowed)
      expect(analog.length, 'need two transmit-capable analog channels').toBeGreaterThanOrEqual(2)
      expect(forbidden, 'need one transmit-forbidden channel').toBeTruthy()

      const a = analog[0]!
      const b = analog[1]!
      const nA = indexOfName(baseline, a.name)
      const nB = indexOfName(baseline, b.name)
      const nF = indexOfName(baseline, forbidden!.name)

      doc.channels.set(a.index, {
        ...a,
        name: 'HW CHECK A',
        power: { mW: mW(2500), label: 'Medium' },
        tone: { rx: { kind: 'ctcss', deciHz: 1273 }, tx: { kind: 'ctcss', deciHz: 1273 }, rxInverted: false },
        txAllowed: false,
        txInhibitReason: 'hardware check',
      })
      doc.channels.set(b.index, {
        ...b,
        rxFreq: hz(462_600_000),
        bandwidthHz: 25_000,
        tone: { rx: { kind: 'dtcs', code: 754, polarity: 'R' }, tx: { kind: 'dtcs', code: 23, polarity: 'N' }, rxInverted: false },
      })
      const { txInhibitReason: _dropped, ...allowed } = forbidden!
      doc.channels.set(forbidden!.index, { ...allowed, txAllowed: true })

      const zoneWas = doc.zones[0]!.name
      doc.zones[0] = { ...doc.zones[0]!, name: 'HW ZONE' }
      const tgWas = doc.talkGroups[0]!
      doc.talkGroups[0] = { ...tgWas, name: 'HW TG' }
      const keyWas = doc.encryptionKeys[0]!
      doc.encryptionKeys[0] = { ...keyWas, keyHex: '5A'.repeat(keyWas.keyHex.length / 2) }

      // Add a channel past the end and delete one in the middle. Both were
      // silently dropped before: the encode loop was bounded by the stored
      // count, and the count itself was not writable.
      const countWas = block(baseline, CHANNEL_BLOCK)[0]! | (block(baseline, CHANNEL_BLOCK)[1]! << 8)
      const added = countWas + 1
      doc.channels.set(added, { ...a, index: added, name: 'HW ADDED', txAllowed: true, tone: { rx: null, tx: null, rxInverted: false } })
      const deleted = [...doc.channels.keys()].filter((k) => k !== a.index && k !== b.index && k !== forbidden!.index && k !== added)[2]!
      const deletedName = doc.channels.get(deleted)!.name
      doc.channels.delete(deleted)

      const report = await session((t) =>
        driver.writeImage(t, driver.encode(doc, baseline), { ident, backup, baseImage: baseline }),
      )
      expect(report.verified).toBe(true)
      expect(report.blocksWritten).toBeGreaterThan(0)

      // Read it back independently and check raw bytes at documented offsets.
      const { image: after } = await read()
      const was = (n: number) => record(baseline, n)
      const now = (n: number) => record(after, n)

      // Byte 0x18: Forbid TX is bit 3, power is bits 2-1 (reference :300-308).
      expect((now(nA)[0x18]! >> 3) & 1, 'transmit-forbid did not set bit 3').toBe(1)
      expect((now(nA)[0x18]! >> 1) & 3, 'power did not land on bits 2-1').toBe(1)
      expect(now(nA)[0x18]! >> 4, 'the mode nibble moved').toBe(was(nA)[0x18]! >> 4)
      expect((now(nF)[0x18]! >> 3) & 1, 'clearing transmit-forbid did not clear bit 3').toBe(0)
      expect((now(nF)[0x18]! >> 1) & 3, 'clearing transmit-forbid disturbed the power level').toBe(
        (was(nF)[0x18]! >> 1) & 3,
      )

      // Byte 0x19: bandwidth is bit 7; scan add and scan list must survive.
      expect(now(nB)[0x19]! >> 7, 'wide bandwidth did not set bit 7').toBe(1)
      expect(now(nB)[0x19]! & 0x7f, 'the scan bits were disturbed').toBe(was(nB)[0x19]! & 0x7f)

      // Tones are packed BCD; DCS carries its polarity in the high byte.
      expect([...now(nA).subarray(0x21, 0x25)], 'CTCSS 127.3 both ways').toEqual([0x73, 0x12, 0x73, 0x12])
      expect([...now(nB).subarray(0x21, 0x25)], 'DCS 754 inverted / 023 normal').toEqual([0x54, 0xc7, 0x23, 0x80])

      // A receive-only channel keeps the transmit pair the radio stored.
      expect(equalBytes(now(nA).subarray(0x14, 0x18), was(nA).subarray(0x14, 0x18)),
        'a receive-only channel had its transmit frequency rewritten').toBe(true)

      // The count word moved, and the header fill around it did not.
      expect(block(after, CHANNEL_BLOCK)[0]! | (block(after, CHANNEL_BLOCK)[1]! << 8),
        'the channel count did not reach the radio').toBe(added)
      expect(equalBytes(block(after, CHANNEL_BLOCK).subarray(2, HEADER), block(baseline, CHANNEL_BLOCK).subarray(2, HEADER)),
        'the header fill either side of the count was rewritten').toBe(true)

      const back = driver.decode(after)
      expect(back.channels.get(added)?.name, 'the added channel is not on the radio').toBe('HW ADDED')
      expect(back.channels.has(deleted), `${deletedName} survived deletion`).toBe(false)
      expect(back.channels.get(deleted + 1)?.name, 'deleting renumbered the channels after it')
        .toBe(driver.decode(baseline).channels.get(deleted + 1)?.name)

      expect([...back.channels.values()].find((c) => c.name === 'HW CHECK A')).toBeTruthy()
      expect(back.zones[0]!.name).toBe('HW ZONE')
      expect(back.zones[0]!.channels, 'a zone rename moved its channel list').toEqual(doc.zones[0]!.channels)
      expect(back.talkGroups[0]!.name).toBe('HW TG')
      expect(back.talkGroups[0]!.number, 'a talk group rename changed its number').toBe(tgWas.number)
      expect(back.talkGroups[0]!.callType, 'a talk group rename changed its call type').toBe(tgWas.callType)
      expect(back.encryptionKeys[0]!.keyHex.toUpperCase()).toBe('5A'.repeat(keyWas.keyHex.length / 2))

      // Nothing outside the blocks the driver claims may have moved.
      for (const region of after.regions) {
        const id = region.start >>> 12
        const before = baseline.regions.find((r) => r.start === region.start)!.data
        if (equalBytes(region.data, before)) continue
        expect(driver.ownedRanges(region.start).length, `block 0x${id.toString(16)} changed but is not claimed`).toBeGreaterThan(0)
        for (let i = 0; i < region.data.length; i++) {
          if (region.data[i] === before[i]) continue
          const inside = driver.ownedRanges(region.start).some(([from, to]) => i >= from && i < to)
          expect(inside, `block 0x${id.toString(16)} byte 0x${i.toString(16)} is outside ownedRanges`).toBe(true)
        }
      }
      expect(zoneWas).not.toBe('HW ZONE')
    } finally {
      // Always put the radio back, even if an assertion above failed.
      await session((t, id) =>
        driver.writeImage(t, baseline, { ident: id, backup: { ...backup, identHash: id.identHash } }),
      )
    }

    // And prove the restore worked, from a fresh read.
    const { image: restored } = await read()
    for (const region of restored.regions) {
      const before = baseline.regions.find((r) => r.start === region.start)!.data
      expect(equalBytes(region.data, before), `block 0x${(region.start >>> 12).toString(16)} did not come back`).toBe(true)
    }
    expect(restored.sha256).toBe(baseline.sha256)
  })
})

describe.skipIf(HW)('DM-32UV hardware suite', () => {
  it('is skipped without BOOFWANG_HW', () => {
    expect(HW).toBe(false)
  })
})
