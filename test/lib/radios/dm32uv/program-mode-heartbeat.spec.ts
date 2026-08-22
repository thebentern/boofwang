// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { IDLE_HEARTBEAT, enterProgrammingMode } from '#core/radios/dm32uv/protocol.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'

/**
 * A heartbeat that lands inside the programming-mode entry sequence.
 *
 * The three steps after PROGRAM are deliberately not drained - they sit 10 ms
 * apart and a drain costs two seconds, after which the radio has left the
 * window. That leaves each reply read exposed: the radio emits `90 fe 98 fe`
 * roughly every three seconds while out of programming mode, and one arriving
 * during the sequence lands at the front of whichever read is waiting. On a
 * real radio the final ACK read returned `90` and the startup-picture read
 * failed with "The final programming-mode ACK failed expected: 06 received: 90".
 */
describe('programming-mode entry with a heartbeat in the sequence', () => {
  /** A radio that answers the sequence correctly but slips a heartbeat in where asked. */
  function radio(heartbeatBefore: 'mode02' | 'finalAck' | null) {
    let step = 0
    return (written: Uint8Array): Uint8Array | null => {
      // PROGRAM: FF FF FF FF 0C "PROGRAM"
      if (written.length >= 5 && written[4] === 0x0c) { step = 1; return Uint8Array.from([0x06]) }
      if (step === 1 && written.length === 1 && written[0] === 0x02) {
        step = 2
        const eight = new Uint8Array(8).fill(0xff)
        return heartbeatBefore === 'mode02' ? Uint8Array.from([...IDLE_HEARTBEAT, ...eight]) : eight
      }
      if (step === 2 && written.length === 1 && written[0] === 0x06) {
        step = 3
        return heartbeatBefore === 'finalAck' ? Uint8Array.from([...IDLE_HEARTBEAT, 0x06]) : Uint8Array.from([0x06])
      }
      return null
    }
  }

  async function enter(heartbeatBefore: 'mode02' | 'finalAck' | null) {
    const port = new FakeSerialPort({ respond: radio(heartbeatBefore) })
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115_200 })
    try { await enterProgrammingMode(t, { timeoutMs: 2000 }) } finally { await t.close() }
  }

  it('enters cleanly when nothing interrupts', async () => {
    await expect(enter(null)).resolves.toBeUndefined()
  })

  it('survives a heartbeat arriving just before the final ACK', async () => {
    // This is the one seen on hardware.
    await expect(enter('finalAck')).resolves.toBeUndefined()
  })

  it('survives a heartbeat arriving just before the Mode 02 reply', async () => {
    await expect(enter('mode02')).resolves.toBeUndefined()
  })
})
