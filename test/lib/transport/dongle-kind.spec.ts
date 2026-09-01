// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { BluetoothPort } from '#core/transport/bluetooth-port.js'
import { FakeGattLink } from '#core/transport/fake-gatt.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'
import { RecordingTransport } from '#core/transport/recording-transport.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { uploadBlockSize, BLE_UPLOAD_BLOCK_SIZE, BLOCK_SIZE } from '#core/radios/uv5rmini/protocol.js'

/**
 * A dongle carries Bluetooth while the radio believes a cable.
 *
 * The TIDRADIO BL-1 family is a BLE-to-UART bridge clipped onto a radio's
 * two-pin programming port: the BLE peripheral is the dongle, and the radio
 * behind it is an ordinary cabled radio that does not know anything changed.
 * Until `radioLink` existed, `kind` answered both "which carrier is the host
 * on" and "what does the radio believe", and the conflation chose the UV-5R
 * Mini's upload block size - so a Mini behind a dongle would have been sent
 * 0x80 blocks its cable-mode firmware never agreed to. A malformed codeplug,
 * not a clean failure. These tests pin the two axes apart at every layer a
 * driver can reach them through.
 */
describe('the two axes of a Bluetooth port', () => {
  const link = () => new FakeGattLink()

  it('fuses them by default, which is a radio with its own module', () => {
    const port = new BluetoothPort(link())
    expect(port.kind).toBe('bluetooth')
    expect(port.radioLink).toBe('bluetooth')
  })

  it('splits them for a dongle', () => {
    const port = new BluetoothPort(link(), { radioLink: 'serial' })
    expect(port.kind).toBe('bluetooth')
    expect(port.radioLink).toBe('serial')
  })

  it('carries both through the transport unchanged', () => {
    const t = new SerialTransport(new BluetoothPort(link(), { radioLink: 'serial' }))
    expect(t.kind).toBe('bluetooth')
    expect(t.radioLink).toBe('serial')
  })

  it('carries both through a recording session unchanged', () => {
    // A recorded session must not change what the driver would have sent, and
    // the block-size decision now reads radioLink.
    const t = new RecordingTransport(new SerialTransport(new BluetoothPort(link(), { radioLink: 'serial' })))
    expect(t.kind).toBe('bluetooth')
    expect(t.radioLink).toBe('serial')
  })
})

describe('the fake port derives like the real ones', () => {
  it('follows kind when radioLink is not set, keeping every older fake fused', () => {
    // Tests written before the split set only `kind: 'bluetooth'` and meant
    // "a radio with its own module". The derivation keeps that meaning.
    const t = new SerialTransport(new FakeSerialPort({ kind: 'bluetooth' }))
    expect(t.kind).toBe('bluetooth')
    expect(t.radioLink).toBe('bluetooth')
  })

  it('splits when told, which is the dongle seam', () => {
    const t = new SerialTransport(new FakeSerialPort({ kind: 'bluetooth', radioLink: 'serial' }))
    expect(t.kind).toBe('bluetooth')
    expect(t.radioLink).toBe('serial')
  })

  it('is a plain cable when neither is set', () => {
    const t = new SerialTransport(new FakeSerialPort())
    expect(t.kind).toBe('serial')
    expect(t.radioLink).toBe('serial')
  })
})

describe('how a magic is paced is a carrier question', () => {
  it('sends the classic magic in one write over Bluetooth, byte-wise on a cable', async () => {
    /*
     * A GATT write is a message, not a stream. Seven single-byte writes drew
     * nothing at all from a Baofeng BT-A1D where the same seven bytes in one
     * write drew a reply, so the 10 ms-per-byte pacing CHIRP needs on a cable
     * is actively harmful through a dongle. Keyed on the carrier, because
     * chunking belongs to the link the host is on - not to what the radio
     * believes, which is what picks block sizes.
     */
    const { identify, MAGIC_UV82 } = await import('#core/radios/uv82/protocol.js')

    async function magicWrites(kind: 'serial' | 'bluetooth'): Promise<Uint8Array[]> {
      const writes: Uint8Array[] = []
      const t = {
        kind,
        radioLink: 'serial',
        async write(b: Uint8Array) {
          writes.push(b.slice())
        },
        async readExactly() {
          throw new Error('stop after the magic')
        },
        async resync() {
          return new Uint8Array(0)
        },
      } as unknown as Parameters<typeof identify>[0]
      await identify(t, MAGIC_UV82, { timeoutMs: 50 }).catch(() => {})
      return writes
    }

    /*
     * The claim is the shape of each write, not how many. `identify` tries
     * the magic three times before giving up, so counting writes counts
     * retries too - which is what the first version of this test did, and it
     * failed for a reason that had nothing to do with pacing.
     */
    const overBle = await magicWrites('bluetooth')
    expect(overBle.length).toBeGreaterThan(0)
    for (const w of overBle) expect(w).toEqual(MAGIC_UV82)

    const overCable = await magicWrites('serial')
    expect(overCable.length).toBeGreaterThan(0)
    for (const w of overCable) expect(w).toHaveLength(1)
    // And the bytes are the same magic either way, one attempt's worth.
    expect(Uint8Array.from(overCable.slice(0, MAGIC_UV82.length).flatMap((w) => [...w]))).toEqual(MAGIC_UV82)
  }, 20_000)
})

describe('what the split decides', () => {
  it('gives a radio behind a dongle the cable block size', () => {
    // The single assertion this whole change exists for.
    const t = new SerialTransport(new BluetoothPort(new FakeGattLink(), { radioLink: 'serial' }))
    expect(uploadBlockSize(t.radioLink)).toBe(BLOCK_SIZE)
  })

  it('keeps the verified own-module path at the wireless block size', () => {
    const t = new SerialTransport(new BluetoothPort(new FakeGattLink()))
    expect(uploadBlockSize(t.radioLink)).toBe(BLE_UPLOAD_BLOCK_SIZE)
  })
})
