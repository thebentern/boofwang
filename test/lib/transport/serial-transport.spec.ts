// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { FakeSerialPort, scriptedResponder } from '#core/transport/fake-serial-port.js'
import {
  DesyncedError,
  DeviceDisconnectedError,
  ReadLimitError,
  TransferAbortedError,
  TransportClosedError,
  TransportTimeoutError,
} from '#core/transport/errors.js'

const b = (...xs: number[]) => Uint8Array.from(xs)
const OPEN = { baudRate: 38400 }

async function opened(opts?: ConstructorParameters<typeof FakeSerialPort>[0]) {
  const port = new FakeSerialPort(opts)
  const t = new SerialTransport(port)
  await t.open(OPEN)
  return { port, t }
}

describe('open / close lifecycle', () => {
  it('opens the port with the requested options', async () => {
    const { port, t } = await opened()
    expect(t.state).toBe('open')
    expect(port.openOptions).toMatchObject({ baudRate: 38400 })
    await t.close()
    expect(t.state).toBe('closed')
    expect(port.closed).toBe(true)
  })

  it('applies opening signals, so a DTR-asserting cable cannot reset the radio', async () => {
    const port = new FakeSerialPort()
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115200, signals: { dataTerminalReady: false, requestToSend: false } })
    expect(port.signalHistory[0]).toEqual({ dataTerminalReady: false, requestToSend: false })
    await t.close()
  })

  it('refuses a second open', async () => {
    const { t } = await opened()
    await expect(t.open(OPEN)).rejects.toThrow(/already open/)
    await t.close()
  })

  it('close is idempotent', async () => {
    const { t } = await opened()
    await t.close()
    await expect(t.close()).resolves.toBeUndefined()
  })

  it('releases both stream locks so port.close() can succeed', async () => {
    const { port, t } = await opened()
    await t.readExactly(0)
    await t.close()
    // If a lock had leaked, reopening the same port object would throw.
    await expect(port.open(OPEN)).resolves.toBeUndefined()
  })

  it('rejects reads once closed', async () => {
    const { t } = await opened()
    await t.close()
    await expect(t.readExactly(1)).rejects.toBeInstanceOf(TransportClosedError)
    await expect(t.write(b(1))).rejects.toBeInstanceOf(TransportClosedError)
  })
})

describe('readExactly', () => {
  it('consumes bytes queued before the read was requested', async () => {
    const { t } = await opened({ greeting: b(0x06, 0x44, 0x50) })
    expect([...(await t.readExactly(3))]).toEqual([0x06, 0x44, 0x50])
    await t.close()
  })

  it('waits for bytes that arrive later', async () => {
    const { port, t } = await opened()
    const p = t.readExactly(4)
    port.push(b(1, 2))
    port.push(b(3, 4))
    expect([...(await p)]).toEqual([1, 2, 3, 4])
    await t.close()
  })

  it('does not confuse a partial read with a frame boundary', async () => {
    // The single most common Web Serial bug: assuming one read() is one frame.
    const { port, t } = await opened()
    const p = t.readExactly(8)
    for (const byte of [1, 2, 3, 4, 5, 6, 7, 8]) port.push(b(byte))
    expect([...(await p)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    await t.close()
  })

  it('serves queued reads strictly in order', async () => {
    const { port, t } = await opened()
    const first = t.readExactly(2)
    const second = t.readExactly(3)
    port.push(b(1, 2, 3, 4, 5))
    expect([...(await first)]).toEqual([1, 2])
    expect([...(await second)]).toEqual([3, 4, 5])
    await t.close()
  })
})

describe('readUntil', () => {
  it('returns everything up to and including the delimiter', async () => {
    const { port, t } = await opened()
    const p = t.readUntil(b(0xdc, 0xba))
    port.push(b(0xab, 0xcd, 0x02, 0x00))
    port.push(b(0xdc, 0xba))
    expect([...(await p)]).toEqual([0xab, 0xcd, 0x02, 0x00, 0xdc, 0xba])
    await t.close()
  })

  it('gives up rather than buffering forever', async () => {
    const { port, t } = await opened()
    const p = t.readUntil(b(0xff, 0xff), { max: 16, timeoutMs: 2000 })
    port.push(new Uint8Array(32))
    await expect(p).rejects.toBeInstanceOf(ReadLimitError)
    await t.close()
  })
})

describe('timeouts poison the stream', () => {
  it('reports what was actually buffered', async () => {
    const { port, t } = await opened()
    port.push(b(0x06, 0x44))
    const err = await t.readExactly(8, { timeoutMs: 30 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransportTimeoutError)
    const te = err as TransportTimeoutError
    expect(te.bufferedLength).toBe(2)
    expect(te.buffered).toBe('06 44')
    expect(te.message).toContain('read 8 byte(s)')
    await t.close()
  })

  it('marks the transport desynced and refuses further traffic', async () => {
    const { t } = await opened()
    await expect(t.readExactly(4, { timeoutMs: 20 })).rejects.toBeInstanceOf(TransportTimeoutError)
    expect(t.state).toBe('desynced')
    await expect(t.readExactly(1)).rejects.toBeInstanceOf(DesyncedError)
    await expect(t.write(b(1))).rejects.toBeInstanceOf(DesyncedError)
    await t.close()
  })

  it('never lets a late reply satisfy the following read', async () => {
    // This is the bug the desync state exists to prevent: without it, the
    // stale reply below would be handed to the *next* command, shifting every
    // subsequent frame and eventually writing garbage to a radio.
    const { port, t } = await opened()
    await expect(t.readExactly(4, { timeoutMs: 20 })).rejects.toBeInstanceOf(TransportTimeoutError)
    port.push(b(0xde, 0xad, 0xbe, 0xef)) // the late reply finally turns up
    await expect(t.readExactly(4, { timeoutMs: 20 })).rejects.toBeInstanceOf(DesyncedError)
    await t.close()
  })

  it('resync drains the stale bytes and reopens the line', async () => {
    const { port, t } = await opened()
    await expect(t.readExactly(4, { timeoutMs: 20 })).rejects.toBeInstanceOf(TransportTimeoutError)
    port.push(b(0xde, 0xad))
    const drained = await t.resync(20)
    expect([...drained]).toEqual([0xde, 0xad])
    expect(t.state).toBe('open')

    port.push(b(1, 2))
    expect([...(await t.readExactly(2))]).toEqual([1, 2])
    await t.close()
  })

  it('a timeout does not disturb a read that already had its bytes', async () => {
    const { port, t } = await opened()
    port.push(b(7, 7))
    expect([...(await t.readExactly(2, { timeoutMs: 50 }))]).toEqual([7, 7])
    await new Promise((r) => setTimeout(r, 80))
    expect(t.state).toBe('open')
    await t.close()
  })
})

describe('abort', () => {
  it('rejects an in-flight read and desyncs', async () => {
    const { t } = await opened()
    const ac = new AbortController()
    const p = t.readExactly(8, { signal: ac.signal, timeoutMs: 5000 })
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(TransferAbortedError)
    expect(t.state).toBe('desynced')
    await t.close()
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const { t } = await opened()
    const ac = new AbortController()
    ac.abort()
    await expect(t.readExactly(1, { signal: ac.signal })).rejects.toBeInstanceOf(TransferAbortedError)
    await expect(t.write(b(1), { signal: ac.signal })).rejects.toBeInstanceOf(TransferAbortedError)
    await t.close()
  })
})

describe('disconnect mid-transfer', () => {
  it('fails the pending read when the stream errors', async () => {
    const { port, t } = await opened()
    const p = t.readExactly(8, { timeoutMs: 5000 })
    port.fault()
    await expect(p).rejects.toThrow()
    expect(t.state).toBe('disconnected')
    await t.close()
  })

  it('notifies listeners exactly once and lets them unsubscribe', async () => {
    const { t } = await opened()
    const seen: Error[] = []
    const off = t.onDisconnect((e) => seen.push(e))
    t.notifyDisconnected()
    t.notifyDisconnected()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(DeviceDisconnectedError)
    off()
    await t.close()
  })

  it('close() after a disconnect does not try to close an invalid port', async () => {
    const { port, t } = await opened()
    t.notifyDisconnected()
    await t.close()
    // port.close() was skipped, so the fake never saw a close call.
    expect(port.closed).toBe(false)
  })

  it('rejects new work once disconnected', async () => {
    const { t } = await opened()
    t.notifyDisconnected()
    await expect(t.readExactly(1)).rejects.toBeInstanceOf(DeviceDisconnectedError)
    await expect(t.write(b(1))).rejects.toBeInstanceOf(DeviceDisconnectedError)
    await t.close()
  })
})

describe('write', () => {
  it('sends bytes through to the port', async () => {
    const { port, t } = await opened()
    await t.write(b(0x14, 0x05, 0x04, 0x00))
    expect(port.writtenHex()).toBe('14 05 04 00')
    await t.close()
  })

  it('splits oversized writes and keeps byte order', async () => {
    const port = new FakeSerialPort()
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115200, writeChunk: 4 })
    await t.write(Uint8Array.from({ length: 10 }, (_, i) => i))
    expect(port.written.map((c) => c.length)).toEqual([4, 4, 2])
    expect([...port.writtenBytes()]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    await t.close()
  })
})

describe('request/response against a scripted device', () => {
  it('drives a multi-step handshake', async () => {
    // Shaped like the DM-32UV handshake: PSEARCH / PASSSTA / SYSINFO.
    const enc = (s: string) => new TextEncoder().encode(s)
    const port = new FakeSerialPort({
      respond: scriptedResponder([
        { expect: enc('PSEARCH'), reply: Uint8Array.from([0x06, ...enc('DP570UV')]), label: 'PSEARCH' },
        { expect: enc('PASSSTA'), reply: b(0x50, 0x00, 0x00), label: 'PASSSTA' },
        { expect: enc('SYSINFO'), reply: b(0x06), label: 'SYSINFO' },
      ]),
    })
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115200 })

    await t.write(enc('PSEARCH'))
    const ident = await t.readExactly(8)
    expect(ident[0]).toBe(0x06)
    expect(new TextDecoder().decode(ident.subarray(1))).toBe('DP570UV')

    await t.write(enc('PASSSTA'))
    expect((await t.readExactly(3))[0]).toBe(0x50)

    await t.write(enc('SYSINFO'))
    expect([...(await t.readExactly(1))]).toEqual([0x06])

    await t.close()
  })

  it('surfaces a script mismatch with both sides in hex', async () => {
    const port = new FakeSerialPort({
      respond: scriptedResponder([{ expect: b(0x01, 0x02), reply: b(0x06), label: 'hello' }]),
    })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await expect(t.write(b(0x09, 0x09))).rejects.toThrow(/mismatch[\s\S]*expected: 01 02[\s\S]*received: 09 09/)
    await t.close()
  })
})

describe('peekHex', () => {
  it('shows unconsumed bytes for bring-up diagnostics', async () => {
    const { t } = await opened({ greeting: b(0xab, 0xcd, 0x01) })
    await new Promise((r) => setTimeout(r, 5))
    expect(t.peekHex()).toBe('ab cd 01')
    await t.close()
  })
})
