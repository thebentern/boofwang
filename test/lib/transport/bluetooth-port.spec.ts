// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { BluetoothPort, BluetoothLinkError, type BluetoothLink } from '#core/transport/bluetooth-port.js'
import { FakeGattLink } from '#core/transport/fake-gatt.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { RecordingTransport } from '#core/transport/recording-transport.js'
import { DeviceDisconnectedError } from '#core/transport/errors.js'
import {
  BluetoothUuidError,
  NORDIC_UART,
  bluetoothProfile,
  normaliseUuid,
  parseBluetoothProfile,
  resetBluetoothProfile,
  setBluetoothProfile,
} from '#core/transport/bluetooth-uuids.js'

const b = (...xs: number[]) => Uint8Array.from(xs)
const OPEN = { baudRate: 115_200 }

async function opened(opts?: ConstructorParameters<typeof FakeGattLink>[0], portOpts?: { maxWriteBytes?: number }) {
  const link = new FakeGattLink(opts)
  const port = new BluetoothPort(link, portOpts ?? {})
  const t = new SerialTransport(port)
  await t.open(OPEN)
  return { link, port, t }
}

describe('the port looks like a serial port to everything above it', () => {
  it('opens, starts notifications and exposes both streams', async () => {
    const { link, port, t } = await opened()
    expect(t.state).toBe('open')
    expect(link.notificationsStarted).toBe(1)
    expect(port.readable).not.toBeNull()
    expect(port.writable).not.toBeNull()
    await t.close()
  })

  it('declares itself as bluetooth, through the transport and the recorder', async () => {
    // This is the flag a driver reads to pick its block size, and it has to
    // survive both wrappers or the driver silently gets the cable behaviour.
    const { t } = await opened()
    expect(t.kind).toBe('bluetooth')
    expect(new RecordingTransport(t).kind).toBe('bluetooth')
    await t.close()
  })

  it('leaves a cable transport saying serial', async () => {
    const { FakeSerialPort } = await import('#core/transport/fake-serial-port.js')
    const t = new SerialTransport(new FakeSerialPort())
    await t.open(OPEN)
    expect(t.kind).toBe('serial')
    await t.close()
  })

  it('refuses a second open', async () => {
    const { t, port } = await opened()
    await expect(port.open(OPEN)).rejects.toThrow(BluetoothLinkError)
    await t.close()
  })
})

describe('framing: what the radio notifies becomes a byte stream', () => {
  it('reassembles a reply that arrived in MTU-sized fragments', async () => {
    // The whole reason `ByteQueue` exists. A 132-byte block reply crosses seven
    // notifications, and no layer above this may ever see that.
    const { link, t } = await opened({ notifyChunk: 20 })
    const reply = Uint8Array.from({ length: 132 }, (_, i) => i & 0xff)
    link.push(reply)
    expect(await t.readExactly(132)).toEqual(reply)
    await t.close()
  })

  it('serves a read that spans several notifications and leaves the remainder', async () => {
    const { link, t } = await opened({ notifyChunk: 4 })
    link.push(b(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
    expect(await t.readExactly(6)).toEqual(b(1, 2, 3, 4, 5, 6))
    expect(await t.readExactly(4)).toEqual(b(7, 8, 9, 10))
    await t.close()
  })

  it('finds a delimiter that straddles two notifications', async () => {
    const { link, t } = await opened({ notifyChunk: 3 })
    link.push(b(0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb, 0xcc))
    expect(await t.readUntil(b(0xaa, 0xbb))).toEqual(b(0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb))
    await t.close()
  })

  it('copies each notification, because the stack reuses the buffer', async () => {
    /*
     * A `DataView` handed to a notification handler points into memory the
     * Bluetooth stack owns and overwrites. Keeping the view rather than copying
     * would mean the second notification silently rewrote the first one's bytes
     * while they sat unread in the queue - corruption that reads as a faulty
     * radio and would never be reproduced on the bench.
     *
     * The fake reuses one backing buffer for exactly this reason.
     */
    const { link, t } = await opened({ notifyChunk: 2 })
    link.push(b(0xde, 0xad, 0xbe, 0xef))
    expect(await t.readExactly(4)).toEqual(b(0xde, 0xad, 0xbe, 0xef))
    await t.close()
  })

  it('ignores an empty notification rather than enqueuing nothing', async () => {
    const { link, t } = await opened()
    link.push(new Uint8Array(0))
    expect(t.peekHex()).toBe('')
    link.push(b(0x06))
    expect(await t.readExactly(1)).toEqual(b(0x06))
    await t.close()
  })
})

describe('framing: what a driver writes becomes GATT writes', () => {
  it('splits a frame at the MTU payload', async () => {
    // A 132-byte UV-5R Mini write frame does not fit in one GATT write, and a
    // peripheral with the default MTU rejects anything past 20 bytes. The fake
    // enforces that, so an unsplit write fails here rather than on a radio.
    const { link, t } = await opened({ maxWriteBytes: 20 })
    const frame = Uint8Array.from({ length: 132 }, (_, i) => i & 0xff)
    await t.write(frame)
    expect(link.writes.map((w) => w.length)).toEqual([20, 20, 20, 20, 20, 20, 12])
    expect(link.writtenBytes()).toEqual(frame)
    await t.close()
  })

  it('honours a larger MTU when one is configured', async () => {
    const { link, t } = await opened({ maxWriteBytes: 244 }, { maxWriteBytes: 244 })
    await t.write(Uint8Array.from({ length: 132 }, (_, i) => i & 0xff))
    expect(link.writes).toHaveLength(1)
    await t.close()
  })

  it('sends a short frame whole', async () => {
    const { link, t } = await opened()
    await t.write(b(0x46))
    expect(link.writes).toEqual([b(0x46)])
    await t.close()
  })

  it('copies what it was handed, so a caller may reuse its buffer', async () => {
    // Two reasons at once: the transport's contract lets a caller reuse the
    // array the moment write() resolves, and Chrome has detached the buffer
    // passed to a GATT write.
    const { link, t } = await opened()
    const frame = b(1, 2, 3, 4)
    await t.write(frame)
    frame.fill(0xff)
    expect(link.writes[0]).toEqual(b(1, 2, 3, 4))
    await t.close()
  })
})

describe('choosing how to write', () => {
  it('prefers the acknowledged write, because an unacknowledged one has no flow control', async () => {
    const calls: string[] = []
    const link: BluetoothLink = {
      write: {
        properties: { write: true, writeWithoutResponse: true, notify: true },
        writeValueWithResponse: async () => void calls.push('with'),
        writeValueWithoutResponse: async () => void calls.push('without'),
        startNotifications: async () => undefined,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      notify: {
        properties: { notify: true },
        startNotifications: async () => undefined,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    }
    const port = new BluetoothPort(link)
    await port.open(OPEN)
    const writer = port.writable!.getWriter()
    await writer.write(b(1))
    expect(calls).toEqual(['with'])
    writer.releaseLock()
    await port.close()
  })

  it('falls back to the unacknowledged write when that is all the characteristic offers', async () => {
    const calls: string[] = []
    const link: BluetoothLink = {
      write: {
        properties: { write: false, writeWithoutResponse: true },
        writeValueWithResponse: async () => void calls.push('with'),
        writeValueWithoutResponse: async () => void calls.push('without'),
        startNotifications: async () => undefined,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      notify: {
        properties: { notify: true },
        startNotifications: async () => undefined,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    }
    const port = new BluetoothPort(link)
    await port.open(OPEN)
    const writer = port.writable!.getWriter()
    await writer.write(b(1))
    expect(calls).toEqual(['without'])
    writer.releaseLock()
    await port.close()
  })
})

describe('when the UUIDs are wrong, say so at open', () => {
  const inert = {
    startNotifications: async () => undefined,
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  it('refuses a characteristic that cannot notify', async () => {
    // Failing here rather than at the first read is the difference between
    // "the UUIDs are probably wrong" and "the radio did not respond", and only
    // one of those sends someone to the right place.
    const port = new BluetoothPort({
      write: { ...inert, properties: { write: true }, writeValueWithResponse: async () => {} },
      notify: { ...inert, uuid: 'abc', properties: { notify: false, indicate: false } },
    })
    await expect(port.open(OPEN)).rejects.toThrow(/does not notify/)
  })

  it('refuses a characteristic that cannot be written to', async () => {
    const port = new BluetoothPort({
      write: { ...inert, uuid: 'def', properties: { write: true } },
      notify: { ...inert, properties: { notify: true } },
    })
    await expect(port.open(OPEN)).rejects.toThrow(/cannot be written to/)
  })

  it('names the file to fix, since the numbers live in exactly one place', async () => {
    const port = new BluetoothPort({
      write: { ...inert, properties: { write: true } },
      notify: { ...inert, properties: { notify: true } },
    })
    await expect(port.open(OPEN)).rejects.toThrow(/bluetooth-uuids\.ts/)
  })

  it('leaves nothing half-open when notifications are refused', async () => {
    // The caller is entitled to try another profile on the same device, which a
    // port holding a stale listener would poison.
    let listeners = 0
    const port = new BluetoothPort({
      write: { ...inert, properties: { write: true }, writeValueWithResponse: async () => {} },
      notify: {
        properties: { notify: true },
        startNotifications: async () => {
          throw new Error('GATT operation not permitted')
        },
        addEventListener: () => {
          listeners++
        },
        removeEventListener: () => {
          listeners--
        },
      },
    })
    await expect(port.open(OPEN)).rejects.toThrow(/refused to send notifications/)
    expect(listeners).toBe(0)
    expect(port.readable).toBeNull()
  })
})

describe('losing the radio', () => {
  it('reports a GATT drop as a disconnect, not as a timeout', async () => {
    const { link, t } = await opened()
    const pending = t.readExactly(4, { timeoutMs: 5000 })
    link.drop()
    await expect(pending).rejects.toThrow(DeviceDisconnectedError)
    expect(t.state).toBe('disconnected')
    await t.close()
  })

  it('does not report a drop when the disconnect was ours', async () => {
    const { link, t } = await opened()
    await t.close()
    expect(link.connected).toBe(false)
  })
})

describe('closing', () => {
  it('stops notifications, drops the listener and disconnects', async () => {
    const { link, t } = await opened()
    await t.close()
    expect(link.notificationsStopped).toBe(1)
    expect(link.listenerCount).toBe(0)
    expect(link.connected).toBe(false)
  })

  it('leaves the link up when asked to', async () => {
    // For a caller that owns the GATT connection and means to reuse it.
    const link = new FakeGattLink()
    const port = new BluetoothPort(link, { disconnectOnClose: false })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await t.close()
    expect(link.connected).toBe(true)
  })

  it('is idempotent', async () => {
    const { t, port } = await opened()
    await t.close()
    await expect(port.close()).resolves.toBeUndefined()
  })
})

describe('the UUIDs themselves', () => {
  it('has not been verified against a radio, and says so', () => {
    // The connect screen reads this flag to decide whether it is allowed to
    // describe Bluetooth as working. If someone captures the real UUIDs and
    // proves them, this test is the thing that has to be changed deliberately.
    expect(NORDIC_UART.verified).toBe(false)
  })

  it('defaults to Nordic UART', () => {
    expect(bluetoothProfile()).toBe(NORDIC_UART)
    expect(NORDIC_UART.service).toBe('6e400001-b5a3-f393-e0a9-e50e24dcca9e')
  })

  it('expands a 16-bit alias, which is how vendors quote them', () => {
    expect(normaliseUuid('FFE0')).toBe('0000ffe0-0000-1000-8000-00805f9b34fb')
    expect(normaliseUuid('0xffe1')).toBe('0000ffe1-0000-1000-8000-00805f9b34fb')
  })

  it('lower-cases a long one rather than rejecting it', () => {
    expect(normaliseUuid('6E400001-B5A3-F393-E0A9-E50E24DCCA9E')).toBe(NORDIC_UART.service)
  })

  it('rejects something that is not a UUID at all', () => {
    // Web Bluetooth throws a TypeError naming neither the value nor the field.
    expect(() => normaliseUuid('nordic')).toThrow(BluetoothUuidError)
  })

  it('parses the three-part override someone with a radio would type', () => {
    const p = parseBluetoothProfile('ffe0, ffe1, ffe2')
    expect(p.service).toBe('0000ffe0-0000-1000-8000-00805f9b34fb')
    expect(p.write).toBe('0000ffe1-0000-1000-8000-00805f9b34fb')
    expect(p.notify).toBe('0000ffe2-0000-1000-8000-00805f9b34fb')
    expect(p.verified).toBe(false)
  })

  it('treats a two-part override as one characteristic in both directions', () => {
    const p = parseBluetoothProfile('ffe0,ffe1')
    expect(p.write).toBe(p.notify)
  })

  it('refuses a spec it cannot make sense of', () => {
    expect(() => parseBluetoothProfile('ffe0')).toThrow(BluetoothUuidError)
    expect(() => parseBluetoothProfile('a,b,c,d')).toThrow(BluetoothUuidError)
  })

  it('can be overridden and put back', () => {
    const custom = parseBluetoothProfile('ffe0,ffe1')
    setBluetoothProfile(custom)
    expect(bluetoothProfile()).toBe(custom)
    resetBluetoothProfile()
    expect(bluetoothProfile()).toBe(NORDIC_UART)
  })
})
