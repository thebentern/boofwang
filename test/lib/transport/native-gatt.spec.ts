// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { BluetoothPort } from '#core/transport/bluetooth-port.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { DeviceDisconnectedError } from '#core/transport/errors.js'
import { FakeBleClient, type FakeBleServiceTable } from '#core/transport/fake-ble-client.js'
import { NativeGattError, connectNativeGattLink, writeBytesForMtu } from '#core/transport/native-gatt.js'
import {
  NORDIC_UART,
  TIDRADIO_BL1_FF00,
  TIDRADIO_BL1_FFE0,
  UV5RM_BLE,
  normaliseUuid,
} from '#core/transport/bluetooth-uuids.js'

const b = (...xs: number[]) => Uint8Array.from(xs)
const OPEN = { baudRate: 115_200 }
const DEVICE = { deviceId: '68:3D:96:BB:A1:54', name: 'walkie-talkie' }

/** The UV-5R Mini's own module: one FFE1 handle, both directions. Short UUIDs on purpose. */
const FFE0: FakeBleServiceTable = {
  ffe0: { ffe1: { properties: { write: true, writeWithoutResponse: true, notify: true } } },
}

/** The BF_Writer dongle: FF02 in, FF01 out, plus the AE echo pair it also carries. */
const FF00: FakeBleServiceTable = {
  ff00: {
    ff02: { properties: { write: true, writeWithoutResponse: true } },
    ff01: { properties: { notify: true } },
  },
  ae00: {
    ae01: { properties: { write: true } },
    ae02: { properties: { notify: true } },
  },
}

async function linked(table: FakeBleServiceTable, candidates = [UV5RM_BLE], portOpts?: { maxWriteBytes?: number }) {
  const client = new FakeBleClient({ services: table, notifyChunk: 2 })
  const { link, maxWriteBytes } = await connectNativeGattLink(client, DEVICE, candidates)
  const port = new BluetoothPort(link, portOpts ?? {})
  const t = new SerialTransport(port)
  await t.open(OPEN)
  return { client, link, port, t, maxWriteBytes }
}

describe('choosing a profile from what the device enumerates', () => {
  it('takes the first candidate the device carries', async () => {
    const client = new FakeBleClient({ services: FF00 })
    const { link } = await connectNativeGattLink(client, DEVICE, [TIDRADIO_BL1_FF00, TIDRADIO_BL1_FFE0])
    expect(link.profile).toBe(TIDRADIO_BL1_FF00)
    expect(link.write.uuid).toBe(normaliseUuid('ff02'))
    expect(link.notify.uuid).toBe(normaliseUuid('ff01'))
  })

  it('moves to the second candidate when the first service is absent', async () => {
    // The dongle list leads with FF00; a unit carrying the HM-10 shape instead
    // must still connect, at the cost of nothing - the enumeration is one call.
    const client = new FakeBleClient({ services: FFE0 })
    const { link } = await connectNativeGattLink(client, DEVICE, [TIDRADIO_BL1_FF00, TIDRADIO_BL1_FFE0])
    expect(link.profile).toBe(TIDRADIO_BL1_FFE0)
    expect(client.connectCount).toBe(1)
  })

  it('matches a short enumerated UUID against a long profile one', async () => {
    // The table above spells FFE0 as four digits; the profile holds the
    // 128-bit expansion. A plugin may do either, and a compare on the raw
    // strings would miss the radio for a reason nobody could see.
    const client = new FakeBleClient({ services: FFE0 })
    const { link } = await connectNativeGattLink(client, DEVICE, [UV5RM_BLE])
    expect(link.profile).toBe(UV5RM_BLE)
  })

  it('names both what was tried and what the device has when nothing matches', async () => {
    /*
     * This is the one thing the native path can say that the browser cannot.
     * Web Bluetooth hands over only the services named up front, so a miss
     * there is a miss into the dark. Here the whole enumeration is in hand,
     * and somebody adding a radio needs to see it.
     */
    const client = new FakeBleClient({
      services: { ae30: { ae01: { properties: { write: true } } } },
    })
    const attempt = connectNativeGattLink(client, DEVICE, [UV5RM_BLE, NORDIC_UART])
    await expect(attempt).rejects.toThrow(NativeGattError)
    await expect(attempt).rejects.toThrow(UV5RM_BLE.service)
    await expect(attempt).rejects.toThrow(NORDIC_UART.service)
    await expect(attempt).rejects.toThrow(normaliseUuid('ae30'))
  })

  it('lets go of the device when nothing matches', async () => {
    // A connection left up after a refusal holds the radio and blocks the
    // next attempt, on a platform where the next attempt is the user's only
    // recourse.
    const client = new FakeBleClient({ services: { ae30: {} } })
    await expect(connectNativeGattLink(client, DEVICE, [UV5RM_BLE])).rejects.toThrow(NativeGattError)
    expect(client.disconnectCount).toBe(1)
    expect(client.connected).toBe(false)
  })

  it('refuses a service that lacks the characteristic the profile names', async () => {
    const client = new FakeBleClient({
      services: { ffe0: { ffe2: { properties: { notify: true } } } },
    })
    const attempt = connectNativeGattLink(client, DEVICE, [UV5RM_BLE])
    await expect(attempt).rejects.toThrow(NativeGattError)
    await expect(attempt).rejects.toThrow(normaliseUuid('ffe1'))
    await expect(attempt).rejects.toThrow(normaliseUuid('ffe2'))
    expect(client.connected).toBe(false)
  })

  it('serves both directions from one object when the profile has one handle', async () => {
    const client = new FakeBleClient({ services: FFE0 })
    const { link } = await connectNativeGattLink(client, DEVICE, [UV5RM_BLE])
    expect(link.write).toBe(link.notify)
  })

  it('labels the link with the advertised name', async () => {
    const client = new FakeBleClient({ services: FFE0 })
    const { link } = await connectNativeGattLink(client, DEVICE, [UV5RM_BLE])
    expect(link.label).toBe('walkie-talkie')
    expect(link.device.id).toBe(DEVICE.deviceId)
    expect(new BluetoothPort(link).label).toBe('walkie-talkie')
  })
})

describe('notifications reach the port', () => {
  it('delivers each one through target.value, reassembled by the transport', async () => {
    const { client, t } = await linked(FFE0)
    client.notify('ffe0', 'ffe1', b(1, 2, 3, 4, 5, 6))
    expect(await t.readExactly(6)).toEqual(b(1, 2, 3, 4, 5, 6))
    await t.close()
  })

  it('is copied, so the plugin reusing its buffer cannot rewrite queued bytes', async () => {
    /*
     * With a two-byte chunk, `de ad be ef` crosses two notifications over the
     * same scratch buffer. A port that kept the `DataView` would read the
     * first pair as `be ef` once the second had landed - and then whatever
     * the test scribbles over the buffer afterwards.
     */
    const { client, t } = await linked(FFE0)
    client.notify('ffe0', 'ffe1', b(0xde, 0xad, 0xbe, 0xef))
    client.scratch.fill(0x00)
    expect(await t.readExactly(4)).toEqual(b(0xde, 0xad, 0xbe, 0xef))
    await t.close()
  })

  it('subscribes on open and unsubscribes on close', async () => {
    const { client, t } = await linked(FFE0)
    expect(client.notifying).toEqual([`${normaliseUuid('ffe0')}/${normaliseUuid('ffe1')}`])
    await t.close()
    expect(client.notifying).toEqual([])
  })
})

describe('writes reach the plugin', () => {
  it('uses the acknowledged write when the characteristic offers it', async () => {
    const { client, t } = await linked(FFE0)
    await t.write(b(0x50, 0x52, 0x4f))
    expect(client.writes).toHaveLength(1)
    expect(client.writes[0]!.acknowledged).toBe(true)
    expect(client.writes[0]!.bytes).toEqual(b(0x50, 0x52, 0x4f))
    expect(client.writes[0]!.service).toBe(normaliseUuid('ffe0'))
    expect(client.writes[0]!.characteristic).toBe(normaliseUuid('ffe1'))
    await t.close()
  })

  it('falls back to the unacknowledged write when that is all there is', async () => {
    const table: FakeBleServiceTable = {
      ffe0: { ffe1: { properties: { write: false, writeWithoutResponse: true, notify: true } } },
    }
    const { client, t } = await linked(table)
    await t.write(b(0x06))
    expect(client.writes[0]!.acknowledged).toBe(false)
    await t.close()
  })

  it('splits at the port limit, one plugin call per piece', async () => {
    const { client, t } = await linked(FFE0)
    await t.write(Uint8Array.from({ length: 45 }, (_, i) => i))
    expect(client.writes.map((w) => w.bytes.length)).toEqual([20, 20, 5])
    await t.close()
  })

  it('copies what it is handed, because the plugin reads the view later', async () => {
    // The port slices too, but the characteristic is reachable on its own,
    // and the plugin serialises the DataView when its queue gets there.
    const client = new FakeBleClient({ services: FFE0 })
    const { link } = await connectNativeGattLink(client, DEVICE, [UV5RM_BLE])
    const frame = b(1, 2, 3, 4)
    await link.write.writeValueWithResponse!(frame)
    frame.fill(0xff)
    expect(client.writes[0]!.bytes).toEqual(b(1, 2, 3, 4))
  })

  it('routes a two-handle profile to the write handle, not the notify one', async () => {
    const { client, t } = await linked(FF00, [TIDRADIO_BL1_FF00])
    await t.write(b(0x06))
    expect(client.writes[0]!.characteristic).toBe(normaliseUuid('ff02'))
    client.notify('ff00', 'ff01', b(0x06))
    expect(await t.readExactly(1)).toEqual(b(0x06))
    await t.close()
  })
})

describe('losing the radio', () => {
  it('fans a drop out to every listener and fails a pending read', async () => {
    const { client, link, t } = await linked(FFE0)
    let heard = 0
    link.device.addEventListener('gattserverdisconnected', () => {
      heard++
    })
    const pending = t.readExactly(4, { timeoutMs: 5000 })
    client.drop()
    await expect(pending).rejects.toThrow(DeviceDisconnectedError)
    expect(heard).toBe(1)
    expect(t.state).toBe('disconnected')
    expect(link.device.gatt?.connected).toBe(false)
    await t.close()
  })

  it('settles closed on a drop, since there is nothing left to wait for', async () => {
    const { client, link, t } = await linked(FFE0)
    client.drop()
    await expect(link.closed).resolves.toBeUndefined()
    await t.close()
  })
})

describe('closing', () => {
  it('does not report our own disconnect as a drop', async () => {
    /*
     * The plugin fires the same callback for a disconnect we asked for as for
     * a radio walking off - natively it is one connection-state event. The
     * port removes its listener before disconnecting, and the fake reproduces
     * the callback, so this is the assertion that the two agree.
     */
    const { client, link, t } = await linked(FFE0)
    await t.close()
    await link.closed
    expect(client.disconnectCount).toBe(1)
    expect(t.state).toBe('closed')
  })

  it('settles closed only after the plugin disconnect has run', async () => {
    const { client, link, t } = await linked(FFE0)
    let settled = false
    void link.closed.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await t.close()
    await link.closed
    expect(settled).toBe(true)
    expect(client.connected).toBe(false)
  })

  it('leaves the link up when the port is told to', async () => {
    const client = new FakeBleClient({ services: FFE0 })
    const { link } = await connectNativeGattLink(client, DEVICE, [UV5RM_BLE])
    const t = new SerialTransport(new BluetoothPort(link, { disconnectOnClose: false }))
    await t.open(OPEN)
    await t.close()
    expect(client.connected).toBe(true)
    expect(client.disconnectCount).toBe(0)
  })
})

describe('the MTU', () => {
  it.each([
    [undefined, undefined],
    [23, 20],
    [247, 244],
    [517, 244],
    [10, 20],
  ])('turns an MTU of %s into %s bytes per write', (mtu, expected) => {
    expect(writeBytesForMtu(mtu)).toBe(expected)
  })

  it('is requested and read back when asked for', async () => {
    const client = new FakeBleClient({ services: FFE0, mtu: 247 })
    const { maxWriteBytes } = await connectNativeGattLink(client, DEVICE, [UV5RM_BLE], { requestMtu: 247 })
    expect(client.mtuRequests).toEqual([247])
    expect(maxWriteBytes).toBe(244)
  })

  it('is left alone when not asked for', async () => {
    const client = new FakeBleClient({ services: FFE0, mtu: 247 })
    const { maxWriteBytes } = await connectNativeGattLink(client, DEVICE, [UV5RM_BLE])
    expect(client.mtuRequests).toEqual([])
    expect(maxWriteBytes).toBeUndefined()
  })

  it('tolerates a platform that cannot request one', async () => {
    // iOS negotiates on its own and exposes nothing. The port keeps its
    // 20-byte default, which is correct for any MTU.
    const client = new FakeBleClient({ services: FFE0, platform: 'ios' })
    expect(client.requestMtu).toBeUndefined()
    const { link, maxWriteBytes } = await connectNativeGattLink(client, DEVICE, [UV5RM_BLE], { requestMtu: 247 })
    expect(maxWriteBytes).toBeUndefined()
    expect(link.profile).toBe(UV5RM_BLE)
    expect(client.priorityRequests).toEqual([])
  })

  it('asks for a high connection priority where it can', async () => {
    const client = new FakeBleClient({ services: FFE0 })
    await connectNativeGattLink(client, DEVICE, [UV5RM_BLE])
    expect(client.priorityRequests).toEqual([1])
  })
})
