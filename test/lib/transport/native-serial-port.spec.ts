// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeSerialError, NativeSerialPort } from '#core/transport/native-serial-port.js'
import { FakeNativeSerialLink } from '#core/transport/fake-native-serial-link.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { RecordingTransport } from '#core/transport/recording-transport.js'
import { DeviceDisconnectedError } from '#core/transport/errors.js'
import type { SerialOpenOptions } from '#core/transport/transport.js'
import { UVK5_SERIAL } from '#core/radios/uvk5/schema.js'
import { UV82_SERIAL } from '#core/radios/uv82/schema.js'
import { UV5RMINI_SERIAL } from '#core/radios/uv5rmini/schema.js'
import { DM32UV_SERIAL } from '#core/radios/dm32uv/schema.js'
import { createUv5gDriver } from '#core/radios/uv5g/driver.js'
import { createUv5rDriver } from '#core/radios/uv5r/driver.js'

const b = (...xs: number[]) => Uint8Array.from(xs)
const OPEN = { baudRate: 115_200 }

async function opened(opts?: ConstructorParameters<typeof FakeNativeSerialLink>[0]) {
  const link = new FakeNativeSerialLink(opts)
  const port = new NativeSerialPort(link)
  const t = new SerialTransport(port)
  await t.open(OPEN)
  return { link, port, t }
}

describe('the port looks like a serial port to everything above it', () => {
  it('opens the device and exposes both streams', async () => {
    const { link, port, t } = await opened()
    expect(t.state).toBe('open')
    expect(link.openCount).toBe(1)
    expect(port.readable).not.toBeNull()
    expect(port.writable).not.toBeNull()
    await t.close()
  })

  it('declares itself as serial, fused, through the transport and the recorder', async () => {
    // A radio on a phone's cable is on a wired UART. `radioLink` is what the
    // UV-5R Mini reads to pick its upload block size, and through this port it
    // must be the cable one whatever wrapper sits in between.
    const { t } = await opened()
    expect(t.kind).toBe('serial')
    expect(t.radioLink).toBe('serial')
    const recorded = new RecordingTransport(t)
    expect(recorded.kind).toBe('serial')
    expect(recorded.radioLink).toBe('serial')
    await t.close()
  })

  it('reports the USB identity the link was built with', () => {
    const link = new FakeNativeSerialLink({ info: { usbVendorId: 0x0403, usbProductId: 0x6001 } })
    const port = new NativeSerialPort(link)
    expect(port.getInfo()).toEqual({ usbVendorId: 0x0403, usbProductId: 0x6001 })
  })

  it('has a label to show a person, with a fallback', () => {
    expect(new NativeSerialPort(new FakeNativeSerialLink({ label: 'FT232R USB UART' })).label).toBe('FT232R USB UART')
    expect(new NativeSerialPort(new FakeNativeSerialLink()).label).toBe('a USB serial cable')
  })

  it('refuses a second open', async () => {
    const { t, port } = await opened()
    await expect(port.open(OPEN)).rejects.toThrow(NativeSerialError)
    await t.close()
  })

  it('leaves nothing half-open when the device refuses', async () => {
    // The caller is entitled to try again on the same device, which a port
    // holding stale subscriptions would poison with a duplicate delivery.
    const link = new FakeNativeSerialLink()
    link.open = async () => {
      throw new Error('permission denied')
    }
    const port = new NativeSerialPort(link)
    await expect(port.open(OPEN)).rejects.toThrow(/did not open: permission denied/)
    expect(link.dataListenerCount).toBe(0)
    expect(link.lostListenerCount).toBe(0)
    expect(port.readable).toBeNull()
  })
})

describe('what each driver asks for lands on the device', () => {
  /**
   * `openSettleMs` is zeroed because it is awaited twice on the way up - once
   * by the port, once by the transport - and it is not what this is checking.
   * The line parameters and the two modem signals are.
   */
  const radios: [string, SerialOpenOptions][] = [
    ['uvk5', UVK5_SERIAL],
    ['uv82', UV82_SERIAL],
    ['uv5rmini', UV5RMINI_SERIAL],
    ['dm32uv', DM32UV_SERIAL],
    // The UV-5G and the UV-5R are the UV-82's driver behind different ident
    // magics and have no serial constant of their own, so their drivers are
    // asked directly.
    ['uv5g', createUv5gDriver().serial],
    ['uv5r', createUv5rDriver().serial],
  ]

  for (const [id, serial] of radios) {
    it(`${id}: opens 8N1 with DTR and RTS low, then deasserts both again`, async () => {
      // Every one of these cables resets the radio when either line is
      // asserted. The driver says so at open, and `SerialTransport.open`
      // says it a second time through `setSignals` - both have to arrive.
      const link = new FakeNativeSerialLink()
      const t = new SerialTransport(new NativeSerialPort(link))
      await t.open({ ...serial, openSettleMs: 0 })
      expect(link.openParams).toEqual({
        baudRate: serial.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        dtr: false,
        rts: false,
      })
      expect(link.signalHistory).toEqual([{ dataTerminalReady: false, requestToSend: false }])
      await t.close()
    })
  }

  it('defaults the signals low when a driver says nothing', async () => {
    // The safe default is the one every driver would have given, and the one
    // `BridgeSerialPort` gives. A plugin that asserted DTR on a bare open
    // would reset a UV-K5 before its first byte.
    const { link, t } = await opened()
    expect(link.openParams).toMatchObject({ dtr: false, rts: false, dataBits: 8, stopBits: 1, parity: 'none' })
    await t.close()
  })

  it('forwards a signal change and ignores break, which the plugin has no call for', async () => {
    const { link, t } = await opened()
    await t.setSignals({ dataTerminalReady: true, break: true })
    expect(link.signalHistory.at(-1)).toEqual({ dataTerminalReady: true })
    await t.close()
  })

  it('waits the settle time before the first byte', async () => {
    vi.useFakeTimers()
    try {
      const port = new NativeSerialPort(new FakeNativeSerialLink())
      let settled = false
      const opening = port.open({ baudRate: 9600, openSettleMs: 200 }).then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(150)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(60)
      expect(settled).toBe(true)
      await opening
      await port.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('framing: what the device delivers becomes a byte stream', () => {
  it('reassembles a reply that arrived in pieces', async () => {
    // The plugin reads the device in whatever sizes the USB driver returns.
    // A 68-byte UV-5R Mini block reply across four events must never be
    // visible above the transport.
    const { link, t } = await opened()
    const reply = Uint8Array.from({ length: 68 }, (_, i) => i & 0xff)
    link.push(reply.subarray(0, 20))
    link.push(reply.subarray(20, 40))
    link.push(reply.subarray(40, 60))
    link.push(reply.subarray(60))
    expect(await t.readExactly(68)).toEqual(reply)
    await t.close()
  })

  it('serves a read that spans events and leaves the remainder', async () => {
    const { link, t } = await opened()
    link.push(b(1, 2, 3, 4))
    link.push(b(5, 6, 7, 8, 9, 10))
    expect(await t.readExactly(6)).toEqual(b(1, 2, 3, 4, 5, 6))
    expect(await t.readExactly(4)).toEqual(b(7, 8, 9, 10))
    await t.close()
  })

  it('copies each event, because the bridge reuses its buffer', async () => {
    /*
     * The fake delivers every event as a view onto one scratch buffer. The
     * first two bytes sit unread in the queue while the second event
     * overwrites that buffer; a port that had kept the view would read
     * be ef be ef here, and the failure would look exactly like a bad cable.
     */
    const { link, t } = await opened()
    link.push(b(0xde, 0xad))
    link.push(b(0xbe, 0xef))
    expect(await t.readExactly(4)).toEqual(b(0xde, 0xad, 0xbe, 0xef))
    await t.close()
  })

  it('hands the stream a chunk that survives the next delivery', async () => {
    // The same trap checked at the port itself, with no queue in the way.
    const link = new FakeNativeSerialLink()
    const port = new NativeSerialPort(link)
    await port.open(OPEN)
    const reader = port.readable!.getReader()
    link.push(b(0x11, 0x22, 0x33))
    const first = (await reader.read()).value!
    link.push(b(0xaa, 0xbb, 0xcc))
    expect(first).toEqual(b(0x11, 0x22, 0x33))
    reader.releaseLock()
    await port.close()
  })

  it('does not lose a byte the device sends the moment it opens', async () => {
    // The subscription has to be in place before the device is opened, or a
    // radio that greets on connect is a radio that appears not to answer.
    const { t } = await opened({ greeting: b(0x06) })
    expect(await t.readExactly(1)).toEqual(b(0x06))
    await t.close()
  })

  it('ignores an empty event rather than enqueuing nothing', async () => {
    const { link, t } = await opened()
    link.push(new Uint8Array(0))
    expect(t.peekHex()).toBe('')
    link.push(b(0x06))
    expect(await t.readExactly(1)).toEqual(b(0x06))
    await t.close()
  })
})

describe('framing: what a driver writes becomes device writes', () => {
  it('sends seven one-byte writes as seven calls', async () => {
    // The UV-82 family's identify sends its magic a byte at a time, and CHIRP
    // sends it the same way. A port that batched them would send a different
    // handshake from the one the radio is known to answer.
    const { link, t } = await opened()
    for (const byte of [0x50, 0x52, 0x4f, 0x47, 0x52, 0x41, 0x4d]) await t.write(b(byte))
    expect(link.written).toHaveLength(7)
    expect(link.written.map((w) => w.length)).toEqual([1, 1, 1, 1, 1, 1, 1])
    expect(link.writtenHex()).toBe('50 52 4f 47 52 41 4d')
    await t.close()
  })

  it('sends a whole frame as one call, never chunking it here', async () => {
    // Chunking is `SerialTransport`'s job, and only when a driver asks.
    const { link, t } = await opened()
    const frame = Uint8Array.from({ length: 132 }, (_, i) => i & 0xff)
    await t.write(frame)
    expect(link.written).toHaveLength(1)
    expect(link.written[0]).toEqual(frame)
    await t.close()
  })

  it('copies what it was handed, so a caller may reuse its buffer', async () => {
    const { link, t } = await opened()
    const frame = b(1, 2, 3, 4)
    await t.write(frame)
    frame.fill(0xff)
    expect(link.written[0]).toEqual(b(1, 2, 3, 4))
    await t.close()
  })

  it('hands the device a buffer that is exactly the bytes, even for a subarray', async () => {
    // A bridge that encodes `bytes.buffer` rather than the view would send
    // the whole backing array. Chunked writes are subarrays, so that matters.
    const link = new FakeNativeSerialLink()
    const t = new SerialTransport(new NativeSerialPort(link))
    await t.open({ baudRate: 9600, writeChunk: 4 })
    await t.write(Uint8Array.from({ length: 10 }, (_, i) => i))
    expect(link.written.map((w) => w.length)).toEqual([4, 4, 2])
    expect(link.written.every((w) => w.buffer.byteLength === w.length)).toBe(true)
    await t.close()
  })
})

describe('losing the cable', () => {
  it('reports a device loss as a disconnect, not as a timeout', async () => {
    const { link, t } = await opened()
    const pending = t.readExactly(4, { timeoutMs: 5000 })
    link.lose('unplugged')
    await expect(pending).rejects.toThrow(DeviceDisconnectedError)
    await expect(pending).rejects.toThrow(/unplugged/)
    expect(t.state).toBe('disconnected')
    await t.close()
  })

  it('tells whoever is listening', async () => {
    const { link, t } = await opened()
    const seen: Error[] = []
    t.onDisconnect((e) => seen.push(e))
    link.lose('unplugged')
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(DeviceDisconnectedError)
    await t.close()
  })

  it('stops listening once the device is gone', async () => {
    // A second loss event, or a straggling data event, must not reach a
    // controller that has already been errored.
    const { link, t } = await opened()
    const pending = t.readExactly(1, { timeoutMs: 5000 })
    link.lose('unplugged')
    await expect(pending).rejects.toThrow(DeviceDisconnectedError)
    expect(link.dataListenerCount).toBe(0)
    expect(link.lostListenerCount).toBe(0)
    await t.close()
  })
})

describe('closing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('unsubscribes before closing the device, so our own close is never a loss', async () => {
    const { link, t } = await opened()
    const seen: Error[] = []
    t.onDisconnect((e) => seen.push(e))
    await t.close()
    expect(link.closeCount).toBe(1)
    expect(link.dataListenerCount).toBe(0)
    expect(link.lostListenerCount).toBe(0)
    // Nothing is listening any more, so a plugin that reports the close it
    // was asked for as a detach has nobody to mislead.
    link.lose('closed by host')
    expect(seen).toEqual([])
  })

  it('is idempotent', async () => {
    const { t, port, link } = await opened()
    await t.close()
    await expect(port.close()).resolves.toBeUndefined()
    expect(link.closeCount).toBe(1)
  })

  it('survives a device that fails its own close', async () => {
    const link = new FakeNativeSerialLink()
    link.close = async () => {
      throw new Error('device already detached')
    }
    const { t } = { t: new SerialTransport(new NativeSerialPort(link)) }
    await t.open(OPEN)
    await expect(t.close()).resolves.toBeUndefined()
    expect(t.state).toBe('closed')
  })

  it('rejects a signal change once closed, rather than poking a device it gave up', async () => {
    const link = new FakeNativeSerialLink()
    const port = new NativeSerialPort(link)
    await port.open(OPEN)
    await port.close()
    await expect(port.setSignals({ dataTerminalReady: false })).rejects.toThrow(NativeSerialError)
    expect(link.signalHistory).toEqual([])
  })
})
