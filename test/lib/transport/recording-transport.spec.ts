// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { RecordingTransport } from '#core/transport/recording-transport.js'
import { FakeSerialPort, scriptedResponder } from '#core/transport/fake-serial-port.js'

const b = (...xs: number[]) => Uint8Array.from(xs)

describe('RecordingTransport', () => {
  it('captures both directions in order with timestamps', async () => {
    const port = new FakeSerialPort({
      respond: scriptedResponder([{ expect: b(0x14, 0x05), reply: b(0x06, 0x01) }]),
    })
    let clock = 1000
    const rec = new RecordingTransport(new SerialTransport(port), 'uvk5-hello', () => clock)
    await rec.open({ baudRate: 38400 })

    await rec.write(b(0x14, 0x05))
    clock = 1042
    expect([...(await rec.readExactly(2))]).toEqual([0x06, 0x01])
    await rec.close()

    const trace = rec.toTrace()
    expect(trace.label).toBe('uvk5-hello')
    expect(trace.entries).toEqual([
      { dir: 'tx', t: 0, hex: '1405' },
      { dir: 'rx', t: 42, hex: '0601' },
    ])
  })

  it('serialises to a replayable JSON fixture', async () => {
    const port = new FakeSerialPort({ greeting: b(0xff) })
    const rec = new RecordingTransport(new SerialTransport(port))
    await rec.open({ baudRate: 9600 })
    await rec.readExactly(1)
    await rec.close()

    const parsed = JSON.parse(rec.toJSON()) as ReturnType<RecordingTransport['toTrace']>
    expect(parsed.version).toBe(1)
    expect(parsed.entries[0]).toMatchObject({ dir: 'rx', hex: 'ff' })
    expect(Date.parse(parsed.startedAt)).not.toBeNaN()
  })

  it('passes state and errors straight through', async () => {
    const port = new FakeSerialPort()
    const inner = new SerialTransport(port)
    const rec = new RecordingTransport(inner)
    await rec.open({ baudRate: 38400 })
    expect(rec.state).toBe('open')
    await expect(rec.readExactly(4, { timeoutMs: 20 })).rejects.toThrow()
    expect(rec.state).toBe('desynced')
    await rec.close()
    expect(rec.state).toBe('closed')
  })

  it('records bytes drained by a resync', async () => {
    const port = new FakeSerialPort()
    const rec = new RecordingTransport(new SerialTransport(port))
    await rec.open({ baudRate: 38400 })
    await expect(rec.readExactly(4, { timeoutMs: 20 })).rejects.toThrow()
    port.push(b(0xde, 0xad))
    await rec.resync(20)
    expect(rec.entries.at(-1)).toMatchObject({ dir: 'rx', hex: 'dead', op: 'resync-drained' })
    await rec.close()
  })
})
