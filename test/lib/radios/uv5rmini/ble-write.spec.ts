// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DriverError, type IdentifyResult } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5rMiniDriver } from '#core/radios/uv5rmini/driver.js'
import {
  BLE_UPLOAD_BLOCK_SIZE,
  BLOCK_SIZE,
  VARIANTS,
  decrypt,
  encrypt,
  uploadBlockSize,
  writeBlock,
} from '#core/radios/uv5rmini/protocol.js'
import { UV5RMINI_SCHEMA } from '#core/radios/uv5rmini/schema.js'
import { BluetoothPort } from '#core/transport/bluetooth-port.js'
import { FakeGattLink } from '#core/transport/fake-gatt.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import type { Transport, TransportKind } from '#core/transport/transport.js'

/**
 * The UV-5R Mini over Bluetooth.
 *
 * The protocol does not change - same handshake, same frames, same obfuscation
 * - so the only things worth testing are the two that do: uploads go out in
 * 0x80 blocks instead of 0x40, and a final block that runs past the end of its
 * region is padded with 0xFF. Both come from CHIRP's `UV5RMini._upload`.
 *
 * None of this has been run against a radio over Bluetooth. What these tests
 * prove is that the driver sends what CHIRP sends when the transport says it is
 * a Bluetooth one, and that the whole stack survives GATT fragmentation.
 */

const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv5rmini-5RMINI.bin', import.meta.url))),
)
const variant = VARIANTS.find((v) => v.id === 'uv5rmini')!

function image(): RadioImage {
  let off = 0
  const regions = variant.regions.map((r) => {
    const data = RAW.slice(off, off + r.size)
    off += r.size
    return { start: r.start, data, label: r.label }
  })
  return {
    radioId: 'uv5rmini',
    variant: '5RMINI',
    layout: 'uv5rmini',
    createdAt: '2026-08-20T00:00:00.000Z',
    regions,
    meta: {},
    sha256: '',
  }
}

const IDENT: IdentifyResult = {
  radioId: 'uv5rmini',
  variant: '5RMINI',
  layout: 'uv5rmini',
  raw: new Uint8Array(0),
  caps: { read: true, write: true },
  identHash: 'match',
}
const BACKUP = { id: 'b', identHash: 'match', createdAt: '2026-08-20T00:00:00.000Z' }

// The driver the registry builds, with nothing extra turned on. It used to
// need `allowBluetoothWrite` here, and the fact that it no longer does is
// asserted at the bottom of this file rather than left implicit in this line.
const driver = createUv5rMiniDriver({ enableWrite: true })

/**
 * A radio that answers frames, and remembers what it was told, at whatever
 * block size the frames use.
 *
 * Deliberately not a `SerialPortLike`: this one stands in for the transport so
 * that the frames can be inspected directly. The GATT stack gets exercised for
 * real further down, where the bytes go through `BluetoothPort` and back.
 */
function scriptedRadio(kind: TransportKind, radioLink: TransportKind = kind) {
  const writes: { addr: number; data: Uint8Array }[] = []
  const reads: { addr: number; length: number }[] = []
  const memory = new Map<number, Uint8Array>()
  let pending: Uint8Array[] = []

  const transport = {
    kind,
    // Defaults to the carrier - the fused case every radio was before the
    // BLE-to-UART dongles. The dongle tests pass ('bluetooth', 'serial').
    radioLink,
    async write(bytes: Uint8Array) {
      const addr = ((bytes[1]! << 8) | bytes[2]!) >>> 0
      if (bytes[0] === 0x57) {
        const body = decrypt(bytes.subarray(4))
        writes.push({ addr, data: body })
        // Stored in 0x40 pieces, because that is the unit the read-back asks
        // for, whatever size it was written in.
        for (let off = 0; off < body.length; off += BLOCK_SIZE) {
          memory.set(addr + off, body.slice(off, off + BLOCK_SIZE))
        }
        pending.push(Uint8Array.from([0x06]))
        return
      }
      if (bytes[0] === 0x52) {
        const length = bytes[3]!
        reads.push({ addr, length })
        const body = memory.get(addr) ?? new Uint8Array(length)
        const out = new Uint8Array(4 + length)
        out.set(bytes.subarray(0, 4), 0)
        out.set(encrypt(body.subarray(0, length)), 4)
        pending.push(out)
        return
      }
      throw new Error(`unexpected frame ${bytes[0]?.toString(16)}`)
    },
    async readExactly(n: number) {
      const next = pending.shift()
      if (!next) throw new Error('the radio was asked for bytes it was never given')
      return next.subarray(0, n)
    },
    async resync() {
      pending = []
      return new Uint8Array(0)
    },
  } as unknown as Transport

  return { transport, writes, reads }
}

describe('which block size an upload uses', () => {
  it('is 0x40 over a cable and 0x80 over Bluetooth', () => {
    expect(uploadBlockSize('serial')).toBe(BLOCK_SIZE)
    expect(uploadBlockSize('bluetooth')).toBe(BLE_UPLOAD_BLOCK_SIZE)
  })

  it('falls back to the cable size when the transport does not say', () => {
    // Every fake transport in this suite predates the flag. Defaulting to the
    // cable is the safe direction: it is the size the radio has been proven to
    // accept.
    expect(uploadBlockSize(undefined)).toBe(BLOCK_SIZE)
  })
})

describe('what goes on the wire over Bluetooth', () => {
  it('sends 0x80 blocks, half as many of them', async () => {
    const radio = scriptedRadio('bluetooth')
    const report = await driver.writeImage(radio.transport, image(), {
      backup: BACKUP,
      ident: IDENT,
      baseImage: image(),
    })

    const expected: number[] = []
    for (const r of variant.regions) {
      for (let off = 0; off < r.size; off += BLE_UPLOAD_BLOCK_SIZE) expected.push(r.start + off)
    }
    expect(radio.writes.map((w) => w.addr)).toEqual(expected)
    expect(radio.writes).toHaveLength(262)
    expect(new Set(radio.writes.map((w) => w.data.length))).toEqual(new Set([BLE_UPLOAD_BLOCK_SIZE]))
    expect(report.blocksWritten).toBe(262)
    expect(report.bytesWritten).toBe(262 * BLE_UPLOAD_BLOCK_SIZE)
    expect(report.verified).toBe(true)
  })

  it('still sends 521 blocks of 0x40 over a cable', async () => {
    // The regression that matters most here: adding the Bluetooth path must not
    // change one byte of the path that has actually been run against a radio.
    const radio = scriptedRadio('serial')
    await driver.writeImage(radio.transport, image(), { backup: BACKUP, ident: IDENT, baseImage: image() })
    expect(radio.writes).toHaveLength(521)
    expect(new Set(radio.writes.map((w) => w.data.length))).toEqual(new Set([BLOCK_SIZE]))
  })

  it('pads the last block of each region with 0xFF', async () => {
    /*
     * None of the three regions divides by 0x80 - 0x8040, 0x0040 and 0x01C0 all
     * leave half a block - so every region ends in a short one. CHIRP fills the
     * remainder with 0xFF, and 0xFF is right because it is what erased flash
     * reads as: the radio ends up holding what it would have held anyway.
     */
    const radio = scriptedRadio('bluetooth')
    await driver.writeImage(radio.transport, image(), { backup: BACKUP, ident: IDENT, baseImage: image() })

    for (const region of variant.regions) {
      const end = region.start + region.size
      const last = radio.writes.filter((w) => w.addr >= region.start && w.addr < end).at(-1)!
      const real = end - last.addr
      expect(real, `region 0x${region.start.toString(16)} should end short`).toBeLessThan(BLE_UPLOAD_BLOCK_SIZE)
      expect([...last.data.subarray(real)].every((x) => x === 0xff)).toBe(true)
    }
  })

  it('puts the same bytes in the radio as the cable path does', async () => {
    // The padding must be the only difference. Anything else would mean the two
    // transports program the radio differently, which is the failure this whole
    // arrangement exists to avoid.
    const ble = scriptedRadio('bluetooth')
    const cable = scriptedRadio('serial')
    await driver.writeImage(ble.transport, image(), { backup: BACKUP, ident: IDENT, baseImage: image() })
    await driver.writeImage(cable.transport, image(), { backup: BACKUP, ident: IDENT, baseImage: image() })

    const flatten = (writes: { addr: number; data: Uint8Array }[]) => {
      const out = new Map<number, number>()
      for (const w of writes) for (const [i, byte] of w.data.entries()) out.set(w.addr + i, byte)
      return out
    }
    const fromBle = flatten(ble.writes)
    const fromCable = flatten(cable.writes)

    for (const [addr, byte] of fromCable) {
      expect(fromBle.get(addr), `0x${addr.toString(16)}`).toBe(byte)
    }
    // And the extra addresses the BLE path touched are padding, past a region end.
    for (const addr of fromBle.keys()) {
      if (fromCable.has(addr)) continue
      expect(fromBle.get(addr)).toBe(0xff)
      const inside = variant.regions.some((r) => addr >= r.start && addr < r.start + r.size)
      expect(inside, `0x${addr.toString(16)} is inside a region and should have been written`).toBe(false)
    }
  })

  it('reads back in 0x40 blocks whatever it wrote in', async () => {
    // CHIRP only ever changed the upload size. A 0x80 read has never been sent
    // to one of these radios by anything, so this driver does not invent one.
    const radio = scriptedRadio('bluetooth')
    await driver.writeImage(radio.transport, image(), { backup: BACKUP, ident: IDENT, baseImage: image() })
    expect(radio.reads).toHaveLength(521)
    expect(new Set(radio.reads.map((r) => r.length))).toEqual(new Set([BLOCK_SIZE]))
  })
})

/**
 * A BLE-to-UART dongle: Bluetooth carrier, cable-believing radio.
 *
 * The TIDRADIO BL-1 family clips onto the two-pin programming port, so the
 * radio behind one is in its wired CPS mode and takes 0x40 blocks - the size
 * that has actually been verified on hardware. Before `radioLink` existed,
 * the block size keyed on the carrier, and a Mini behind a dongle would have
 * been sent the 0x80 frames its cable mode never negotiates: a malformed
 * codeplug rather than a clean failure. This is the regression suite for
 * that.
 */
describe('what goes on the wire through a dongle', () => {
  it('sends the 521 cable blocks of 0x40, not the 262 wireless ones', async () => {
    const radio = scriptedRadio('bluetooth', 'serial')
    const report = await driver.writeImage(radio.transport, image(), {
      backup: BACKUP,
      ident: IDENT,
      baseImage: image(),
    })

    expect(radio.writes).toHaveLength(521)
    expect(new Set(radio.writes.map((w) => w.data.length))).toEqual(new Set([BLOCK_SIZE]))
    expect(report.blocksWritten).toBe(521)
    expect(report.bytesWritten).toBe(521 * BLOCK_SIZE)
    expect(report.verified).toBe(true)
  })

  it('is byte-identical to the cable session, padding included - there is none', async () => {
    // Stricter than the own-module comparison above, which allows the 0x80
    // path its 0xFF padding past region ends. A transparent dongle changes
    // nothing the radio can see, so the two write lists must agree on every
    // address and touch not one byte more.
    const dongle = scriptedRadio('bluetooth', 'serial')
    const cable = scriptedRadio('serial')
    await driver.writeImage(dongle.transport, image(), { backup: BACKUP, ident: IDENT, baseImage: image() })
    await driver.writeImage(cable.transport, image(), { backup: BACKUP, ident: IDENT, baseImage: image() })

    expect(dongle.writes.map((w) => w.addr)).toEqual(cable.writes.map((w) => w.addr))
    for (const [i, w] of dongle.writes.entries()) {
      expect(w.data, `block 0x${w.addr.toString(16)}`).toEqual(cable.writes[i]!.data)
    }
  })

  it('reads back in the same 0x40 blocks as everything else', async () => {
    const radio = scriptedRadio('bluetooth', 'serial')
    await driver.writeImage(radio.transport, image(), { backup: BACKUP, ident: IDENT, baseImage: image() })
    expect(radio.reads).toHaveLength(521)
    expect(new Set(radio.reads.map((r) => r.length))).toEqual(new Set([BLOCK_SIZE]))
  })
})

describe('writeBlock guards the sizes it can frame', () => {
  it('takes either legal size', async () => {
    const radio = scriptedRadio('bluetooth')
    await writeBlock(radio.transport, 0, new Uint8Array(BLOCK_SIZE))
    await writeBlock(radio.transport, 0, new Uint8Array(BLE_UPLOAD_BLOCK_SIZE))
    expect(radio.writes).toHaveLength(2)
  })

  it('refuses a third one, because the length also goes in the header byte', async () => {
    const radio = scriptedRadio('bluetooth')
    await expect(writeBlock(radio.transport, 0, new Uint8Array(0x30))).rejects.toThrow(DriverError)
  })
})

describe('the whole stack, over a real GATT link', () => {
  /**
   * The frames above never touched `BluetoothPort`. This does: a byte-stream
   * radio behind `FakeGattLink`, so every frame is cut into 20-byte GATT writes
   * on the way out and reassembled from fragmented notifications on the way
   * back. A 0x80 block's frame is 132 bytes, which is seven writes and no
   * layer above the port is allowed to notice.
   */
  function gattRadio() {
    const stored = new Map<number, Uint8Array>()
    let buffer = new Uint8Array(0)
    const link: FakeGattLink = new FakeGattLink({
      maxWriteBytes: 20,
      notifyChunk: 20,
      respond: (chunk) => {
        const next = new Uint8Array(buffer.length + chunk.length)
        next.set(buffer, 0)
        next.set(chunk, buffer.length)
        buffer = next

        // One frame at a time, and only when all of it has arrived: a GATT
        // write boundary is not a frame boundary and never lines up with one.
        const out: number[] = []
        for (;;) {
          if (buffer.length < 4) break
          const [cmd, hi, lo, len] = [buffer[0]!, buffer[1]!, buffer[2]!, buffer[3]!]
          const addr = (hi << 8) | lo
          if (cmd === 0x52) {
            buffer = buffer.slice(4)
            out.push(0x52, hi, lo, len)
            out.push(...encrypt(stored.get(addr) ?? new Uint8Array(len)).subarray(0, len))
            continue
          }
          if (cmd === 0x57) {
            const size = len === 0 ? 0x100 : len
            if (buffer.length < 4 + size) break
            stored.set(addr, decrypt(buffer.subarray(4, 4 + size)))
            buffer = buffer.slice(4 + size)
            out.push(0x06)
            continue
          }
          throw new Error(`unexpected command 0x${cmd.toString(16)}`)
        }
        return out.length ? Uint8Array.from(out) : null
      },
    })
    return { link, stored }
  }

  it('carries a 0x80 block out and reads it back, in 20-byte pieces', async () => {
    const { link, stored } = gattRadio()
    const port = new BluetoothPort(link, { maxWriteBytes: 20 })
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115_200 })

    const block = Uint8Array.from({ length: BLE_UPLOAD_BLOCK_SIZE }, (_, i) => (i * 7) & 0xff)
    await writeBlock(t, 0x1000, block)
    expect(stored.get(0x1000)).toEqual(block)

    // Seven GATT writes for the 132-byte frame, and one for nothing else.
    expect(link.writes.map((w) => w.length)).toEqual([20, 20, 20, 20, 20, 20, 12])

    const { readBlock } = await import('#core/radios/uv5rmini/protocol.js')
    expect(await readBlock(t, 0x1000, BLE_UPLOAD_BLOCK_SIZE)).toEqual(block)

    await t.close()
  })

  it('tells the driver above it what the radio believes', async () => {
    // `radioLink`, not `kind`: the carrier is Bluetooth either way, and the
    // block size follows the radio's own belief.
    const { link } = gattRadio()
    const t = new SerialTransport(new BluetoothPort(link))
    await t.open({ baudRate: 115_200 })
    expect(uploadBlockSize(t.radioLink)).toBe(BLE_UPLOAD_BLOCK_SIZE)
    await t.close()
  })

  it('carries a cable-sized frame through the same 20-byte fragmentation for a dongle', async () => {
    // The dongle changes the block size, never the GATT plumbing: a 0x40
    // frame is 68 bytes, which is four writes, and the radio behind the
    // dongle sees the frame its cable mode expects.
    const { link, stored } = gattRadio()
    const port = new BluetoothPort(link, { maxWriteBytes: 20, radioLink: 'serial' })
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115_200 })

    expect(uploadBlockSize(t.radioLink)).toBe(BLOCK_SIZE)

    const block = Uint8Array.from({ length: BLOCK_SIZE }, (_, i) => (i * 11) & 0xff)
    await writeBlock(t, 0x2000, block)
    expect(stored.get(0x2000)).toEqual(block)
    expect(link.writes.map((w) => w.length)).toEqual([20, 20, 20, 8])

    await t.close()
  })
})

/**
 * That the carrier is no longer a reason to refuse.
 *
 * There was a refusal here, on `t.kind === 'bluetooth'`, gated behind an
 * `allowBluetoothWrite` option nothing in the application passed - so
 * everything above proved what boofwang *would* send rather than what it
 * would do. Both are gone, and these are the assertions that keep them gone:
 * the driver the registry builds writes over a GATT link, and the write gate
 * agrees with it, which is the pairing the two halves have to keep.
 */
describe('writing over Bluetooth', () => {
  it('goes through on the driver the registry builds', async () => {
    const registryDriver = createUv5rMiniDriver({ enableWrite: true })
    const ble = scriptedRadio('bluetooth')
    const report = await registryDriver.writeImage(ble.transport, image(), {
      backup: BACKUP,
      ident: IDENT,
      baseImage: image(),
    })
    expect(report.verified).toBe(true)
    expect(report.blocksWritten).toBe(262)
  })

  it('goes through over a dongle too, on the same carrier', async () => {
    /*
     * A dongle is a 'bluetooth' carrier carrying the cable's 0x40 blocks - the
     * `radioLink` distinction - so it was refused by the same rule and is
     * released by the same removal. Asserted separately because the two differ
     * in block size, and a change that only released one would be silent.
     */
    const registryDriver = createUv5rMiniDriver({ enableWrite: true })
    const dongle = scriptedRadio('bluetooth', 'serial')
    const report = await registryDriver.writeImage(dongle.transport, image(), {
      backup: BACKUP,
      ident: IDENT,
      baseImage: image(),
    })
    expect(report.verified).toBe(true)
    expect(report.blocksWritten).toBe(521)
  })

  it('is what the write gate says too', () => {
    /*
     * The gate explains and the driver enforces, so the two must not disagree
     * in either direction. This is the direction that used to be checked - the
     * gate blocking what the driver blocked - read the other way round.
     */
    const writeOver =
      UV5RMINI_SCHEMA.capabilities.writeTransports ?? UV5RMINI_SCHEMA.capabilities.transports
    expect(writeOver).toContain('bluetooth')
    expect(writeOver).toContain('serial')
  })
})
