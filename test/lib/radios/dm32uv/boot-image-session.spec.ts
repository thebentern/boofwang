// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { queryBootImageRange } from '#core/radios/dm32uv/boot-image.js'
import { IDLE_HEARTBEAT } from '#core/radios/dm32uv/protocol.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'

/**
 * Two operations, two sessions, on a radio that behaves like the real one.
 *
 * The fake here models the one property that broke the flow: a V-frame is
 * answered before programming mode and ignored once inside it, and only a close
 * takes the radio back out. A sequence that keeps the port open across read and
 * write sees the second V-frame go unanswered - which is the timeout the report
 * showed. A sequence that closes between them gets answered both times.
 */
const RANGE = [0x00, 0x00, 0x15, 0x00, 0xff, 0x5f, 0x17, 0x00]

class ProgrammingModeRadio {
  inProgrammingMode = false
  queries = 0

  respond = (written: Uint8Array): Uint8Array | null => {
    // The PROGRAM entry sequence puts us into the mode.
    if (written.length >= 5 && written[4] === 0x0c) {
      this.inProgrammingMode = true
      return Uint8Array.from([0x06])
    }
    if (written[0] === 0x56 && written[4] === 0x0e) {
      this.queries++
      // In programming mode the radio says nothing at all to a V-frame.
      return this.inProgrammingMode ? null : Uint8Array.from([0x56, 0x0e, RANGE.length, ...RANGE])
    }
    return null
  }

  /** The close is the reset. */
  onClose = () => { this.inProgrammingMode = false }
}

async function session(radio: ProgrammingModeRadio, enterMode: boolean) {
  const port = new FakeSerialPort({ greeting: Uint8Array.from(IDLE_HEARTBEAT), respond: radio.respond })
  const t = new SerialTransport(port)
  await t.open({ baudRate: 115_200 })
  const range = await queryBootImageRange(t, { timeoutMs: 800 })
  if (enterMode) {
    await t.write(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x0c, 0x50, 0x52, 0x4f, 0x47, 0x52, 0x41, 0x4d]))
    await t.readExactly(1, { timeoutMs: 800 })
  }
  return { t, port, range }
}

describe('a read then a write on the same radio', () => {
  it('works when the port is closed between them', async () => {
    const radio = new ProgrammingModeRadio()

    const first = await session(radio, true)
    expect(first.range.start).toBe(0x15_0000)
    await first.t.close()
    radio.onClose()

    const second = await session(radio, false)
    expect(second.range.start).toBe(0x15_0000)
    await second.t.close()
    expect(radio.queries).toBe(2)
  })

  it('times out when the port is held open across them, which is the bug', async () => {
    const radio = new ProgrammingModeRadio()
    const { t } = await session(radio, true)
    // Same open port, same radio, now in programming mode: the V-frame is ignored.
    await expect(queryBootImageRange(t, { timeoutMs: 400 })).rejects.toThrow(/Timed out/)
    await t.close()
  })
})
