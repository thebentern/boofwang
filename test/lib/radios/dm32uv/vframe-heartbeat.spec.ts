// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { IDLE_HEARTBEAT, vframe } from '#core/radios/dm32uv/protocol.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'

/**
 * A V-frame read minutes after the handshake meets a heartbeat first.
 *
 * The radio emits `90 fe 98 fe` roughly every three seconds while it is out of
 * programming mode. The five V-frames in `identify` are read straight after the
 * handshake, which drains, so they never met one. The startup-image range is
 * read when somebody presses a button - after choosing a picture and cropping
 * it - and by then several heartbeats are sitting in the queue. `readExactly(3)`
 * returned `90 fe 98`, the header check rejected it, and both reading and
 * writing the picture failed on a radio that was working perfectly.
 */
describe('a V-frame read with a heartbeat already in the queue', () => {
  const RANGE = [0x00, 0x00, 0x15, 0x00, 0xff, 0x5f, 0x17, 0x00]

  /**
   * The reply arrives in answer to the query, not before it, which is the whole
   * point: a drain that ran first must not have eaten it.
   */
  function respond(written: Uint8Array): Uint8Array | null {
    if (written[0] === 0x56 && written[4] === 0x0e) {
      return Uint8Array.from([0x56, 0x0e, RANGE.length, ...RANGE])
    }
    return null
  }

  async function query(greeting: number[]) {
    const port = new FakeSerialPort({ greeting: Uint8Array.from(greeting), respond })
    const t = new SerialTransport(port)
    await t.open({ baudRate: 115_200 })
    const payload = await vframe(t, 0x0e, 0x00, { timeoutMs: 3000 })
    await t.close()
    return [...payload]
  }

  it('still reads the frame when one heartbeat arrived first', async () => {
    expect(await query([...IDLE_HEARTBEAT])).toEqual(RANGE)
  })

  it('still reads the frame after several of them', async () => {
    // Three seconds apart, so a minute of cropping is twenty of these.
    const many = Array.from({ length: 5 }, () => [...IDLE_HEARTBEAT]).flat()
    expect(await query(many)).toEqual(RANGE)
  })

  it('reads a clean line exactly as before', async () => {
    expect(await query([])).toEqual(RANGE)
  })
})
