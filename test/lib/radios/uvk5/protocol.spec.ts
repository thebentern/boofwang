// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fromHex, toHex } from '#core/codec/checksum.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'
import { ProtocolError } from '#core/transport/errors.js'
import { LoopbackDetectedError, RadioInProgrammingModeError } from '#core/radio/driver.js'
import {
  BAUD_RATE,
  HELLO,
  MEM_BLOCK,
  MEM_SIZE,
  PROG_SIZE,
  RESET,
  buildFrame,
  buildReadMem,
  buildWriteMem,
  parseFirmwareString,
  readFrame,
  readMem,
  sayHello,
  writeMem,
  xorArray,
} from '#core/radios/uvk5/protocol.js'

/**
 * The expected frames below were produced by running CHIRP's own
 * `_send_command` from `chirp/drivers/uvk5.py` in Python. They are golden
 * output from the reference implementation, not a re-derivation of the same
 * reasoning that produced our encoder - which is the only way this test can
 * catch a shared misunderstanding.
 */
const GOLDEN = {
  hello: 'abcd0800026910e644a85a24b9a9dcba',
  read0000: 'abcd0c000d691ce62e918d404b0c822456ecdcba',
  read1c80: 'abcd0c000d691ce6ae8d8d404b0c8224c774dcba',
  write0f50: 'abcd1c000b690ce67e9e1d414b0c82241302eb83126912e12698074b2d38db4f2cfadcba',
  reset: 'abcd0400cb6914e65bebdcba',
  helloReplyOk: 'abcd1c00036914e645a452720f05e46e2135e980166c14e62e910d402135d540f2dadcba',
  helloReplyProgMode: 'abcd1c000e6914e645a452720f05e46e2135e980166c14e62e910d402135d540b758dcba',
}

const OPEN = { baudRate: BAUD_RATE }

describe('constants match CHIRP', () => {
  it('uses the only baud rate the radio accepts', () => {
    expect(BAUD_RATE).toBe(38400)
  })

  it('reads the whole EEPROM but programs only the lower part', () => {
    expect(MEM_SIZE).toBe(0x2000)
    expect(PROG_SIZE).toBe(0x1d00)
    expect(MEM_BLOCK).toBe(0x80)
    // The gap is the calibration region, which a normal upload never touches.
    expect(MEM_SIZE - PROG_SIZE).toBe(0x300)
  })
})

describe('obfuscation', () => {
  it('is its own inverse', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (d) => {
        expect([...xorArray(xorArray(d))]).toEqual([...d])
      }),
    )
  })

  it('cycles the table every 16 bytes', () => {
    const zeros = new Uint8Array(32)
    const out = xorArray(zeros)
    expect([...out.subarray(0, 16)]).toEqual([...out.subarray(16, 32)])
    expect(out[0]).toBe(22)
  })
})

describe('frame construction matches CHIRP byte for byte', () => {
  it('builds the hello frame', () => {
    expect(toHex(buildFrame(HELLO))).toBe(GOLDEN.hello)
  })

  it('builds a read command at offset 0', () => {
    expect(toHex(buildFrame(buildReadMem(0x0000, 0x80)))).toBe(GOLDEN.read0000)
  })

  it('builds a read command at a high offset', () => {
    expect(toHex(buildFrame(buildReadMem(0x1c80, 0x80)))).toBe(GOLDEN.read1c80)
  })

  it('builds a write command', () => {
    const data = Uint8Array.from({ length: 16 }, (_, i) => i)
    expect(toHex(buildFrame(buildWriteMem(0x0f50, data)))).toBe(GOLDEN.write0f50)
  })

  it('builds the reset frame', () => {
    expect(toHex(buildFrame(RESET))).toBe(GOLDEN.reset)
  })

  it('declares the payload length without its checksum', () => {
    // The body carries len+2 bytes but the header says len. Getting this
    // backwards produces frames the radio silently ignores.
    const frame = buildFrame(HELLO)
    expect(frame[2]).toBe(HELLO.length)
    expect(frame.length).toBe(4 + HELLO.length + 2 + 2)
  })

  it('refuses a payload that will not fit the length byte', () => {
    expect(() => buildFrame(new Uint8Array(256))).toThrow(RangeError)
  })
})

describe('readFrame', () => {
  async function withReply(hex: string) {
    const port = new FakeSerialPort({ greeting: fromHex(hex) })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    return { port, t }
  }

  it('deobfuscates a reply and verifies its checksum', async () => {
    const { t } = await withReply(GOLDEN.helloReplyOk)
    const payload = await readFrame(t, { timeoutMs: 500 })
    expect(payload[0]).toBe(0x15)
    expect(parseFirmwareString(payload)).toBe('k5_2.01.26')
    await t.close()
  })

  it('rejects a bad header rather than resynchronising on it', async () => {
    const { t } = await withReply('ffff0400' + '00000000' + '0000dcba')
    await expect(readFrame(t, { timeoutMs: 300 })).rejects.toBeInstanceOf(ProtocolError)
    await t.close()
  })

  it('rejects a bad footer', async () => {
    const good = fromHex(GOLDEN.helloReplyOk)
    good[good.length - 1] = 0x00
    const port = new FakeSerialPort({ greeting: good })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await expect(readFrame(t, { timeoutMs: 300 })).rejects.toThrow(/footer/)
    await t.close()
  })

  it('catches a corrupted payload via the checksum, which CHIRP does not verify', async () => {
    const corrupt = fromHex(GOLDEN.helloReplyOk)
    corrupt[6] = corrupt[6]! ^ 0xff
    const port = new FakeSerialPort({ greeting: corrupt })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await expect(readFrame(t, { timeoutMs: 300 })).rejects.toThrow(/checksum/)
    await t.close()
  })

  it('reassembles a reply delivered one byte at a time', async () => {
    const port = new FakeSerialPort()
    const t = new SerialTransport(port)
    await t.open(OPEN)
    const p = readFrame(t, { timeoutMs: 2000 })
    for (const byte of fromHex(GOLDEN.helloReplyOk)) port.push(Uint8Array.from([byte]))
    expect(parseFirmwareString(await p)).toBe('k5_2.01.26')
    await t.close()
  })
})

describe('parseFirmwareString', () => {
  it('reads up to the terminator', () => {
    const reply = Uint8Array.from([0x15, 0x05, 0, 0, ...new TextEncoder().encode('k5_2.01.26'), 0, 0])
    expect(parseFirmwareString(reply)).toBe('k5_2.01.26')
  })

  it('returns empty when no terminator is found, exactly as CHIRP does', () => {
    // A run of 25 printable bytes is not a firmware string we know how to
    // interpret. Returning it anyway would let an unidentified radio through
    // the variant gate and into the write path.
    const reply = Uint8Array.from([0, 0, 0, 0, ...new Array(30).fill(0x41)])
    expect(parseFirmwareString(reply)).toBe('')
  })

  it('is empty for a truncated reply', () => {
    expect(parseFirmwareString(Uint8Array.from([1, 2]))).toBe('')
  })
})

describe('sayHello', () => {
  it('returns the firmware string', async () => {
    const port = new FakeSerialPort({
      respond: (w) => (toHex(w) === GOLDEN.hello ? fromHex(GOLDEN.helloReplyOk) : null),
    })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await expect(sayHello(t, 3, { timeoutMs: 500 })).resolves.toBe('k5_2.01.26')
    await t.close()
  })

  it('reports programming mode as its own condition, since the fix is physical', async () => {
    const port = new FakeSerialPort({ respond: () => fromHex(GOLDEN.helloReplyProgMode) })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await expect(sayHello(t, 2, { timeoutMs: 500 })).rejects.toBeInstanceOf(RadioInProgrammingModeError)
    await t.close()
  })

  it('retries, because the first packet after seating the cable is often lost', async () => {
    let n = 0
    const port = new FakeSerialPort({
      respond: () => {
        n++
        return n < 3 ? null : fromHex(GOLDEN.helloReplyOk)
      },
    })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await expect(sayHello(t, 5, { timeoutMs: 300 })).resolves.toBe('k5_2.01.26')
    expect(n).toBe(3)
    await t.close()
  })

  it('gives up after the retry budget', async () => {
    const port = new FakeSerialPort({ respond: () => null })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await expect(sayHello(t, 2, { timeoutMs: 40 })).rejects.toThrow()
    await t.close()
  })
})

describe('readMem / writeMem', () => {
  /** A device that serves an EEPROM image. */
  function eepromPort(image: Uint8Array) {
    const written: { offset: number; data: Uint8Array }[] = []
    const port = new FakeSerialPort({
      respond: (frame) => {
        const payload = xorArray(frame.subarray(4, 4 + frame[2]!))
        if (payload[0] === 0x1b) {
          const offset = payload[4]! | (payload[5]! << 8)
          const length = payload[6]!
          const body = new Uint8Array(8 + length)
          body[0] = 0x1c
          body[4] = offset & 0xff
          body[5] = (offset >> 8) & 0xff
          body[6] = length
          body.set(image.subarray(offset, offset + length), 8)
          return buildFrame(body)
        }
        if (payload[0] === 0x1d) {
          const offset = payload[4]! | (payload[5]! << 8)
          const length = payload[6]!
          written.push({ offset, data: payload.slice(12, 12 + length) })
          return buildFrame(Uint8Array.from([0x1e, 0x05, 0, 0, offset & 0xff, (offset >> 8) & 0xff]))
        }
        return null
      },
    })
    return { port, written }
  }

  it('returns exactly the requested slice of memory', async () => {
    const image = Uint8Array.from({ length: 0x2000 }, (_, i) => i & 0xff)
    const { port } = eepromPort(image)
    const t = new SerialTransport(port)
    await t.open(OPEN)
    const got = await readMem(t, 0x0f50, 0x80, { timeoutMs: 500 })
    expect([...got]).toEqual([...image.subarray(0x0f50, 0x0fd0)])
    await t.close()
  })

  it('reads the whole EEPROM in 128-byte blocks', async () => {
    const image = Uint8Array.from({ length: 0x2000 }, (_, i) => (i * 7) & 0xff)
    const { port } = eepromPort(image)
    const t = new SerialTransport(port)
    await t.open(OPEN)
    const out = new Uint8Array(MEM_SIZE)
    for (let addr = 0; addr < MEM_SIZE; addr += MEM_BLOCK) {
      out.set(await readMem(t, addr, MEM_BLOCK, { timeoutMs: 500 }), addr)
    }
    expect([...out]).toEqual([...image])
    await t.close()
  })

  it('rejects a short reply instead of returning partial data', async () => {
    const port = new FakeSerialPort({
      respond: () => buildFrame(Uint8Array.from([0x1c, 0, 0, 0, 0, 0, 0, 0, 1, 2])),
    })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await expect(readMem(t, 0, 0x80, { timeoutMs: 300 })).rejects.toThrow(/Short read/)
    await t.close()
  })

  it('sends the data the caller asked to write', async () => {
    const { port, written } = eepromPort(new Uint8Array(0x2000))
    const t = new SerialTransport(port)
    await t.open(OPEN)
    const data = Uint8Array.from({ length: 0x80 }, (_, i) => (i ^ 0x5a) & 0xff)
    await writeMem(t, 0x0100, data, { timeoutMs: 500 })
    expect(written).toHaveLength(1)
    expect(written[0]!.offset).toBe(0x0100)
    expect([...written[0]!.data]).toEqual([...data])
    await t.close()
  })

  it('treats an acknowledgement for the wrong address as a failure', async () => {
    // Silently accepting this would mean believing a block landed somewhere it
    // did not, and a verify pass would then compare the wrong bytes.
    const port = new FakeSerialPort({
      respond: () => buildFrame(Uint8Array.from([0x1e, 0x05, 0, 0, 0xff, 0xff])),
    })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await expect(writeMem(t, 0x0100, new Uint8Array(4), { timeoutMs: 300 })).rejects.toThrow(/rejected a write/)
    await t.close()
  })
})

describe('a cable that echoes instead of a radio that answers', () => {
  /**
   * Observed on real hardware: a UV-K5 that was not responding, on a Prolific
   * PL2303 cable, put every transmitted byte back on the receive line. The echo
   * is a structurally perfect frame - right header, right footer, valid CRC -
   * so every validation layer accepted it, and the echoed hello decoded to an
   * empty firmware string, which surfaced as "unrecognised firmware". That sent
   * the user looking for a firmware problem when the radio simply was not
   * talking.
   */
  function loopbackPort() {
    // Returns whatever it is given, exactly as a shorted line would.
    return new FakeSerialPort({ respond: (written) => written })
  }

  it('reports a loopback rather than pretending the radio replied', async () => {
    const t = new SerialTransport(loopbackPort())
    await t.open(OPEN)
    await expect(sayHello(t, 3, { timeoutMs: 200 })).rejects.toBeInstanceOf(LoopbackDetectedError)
    await t.close()
  })

  it('explains what to physically check', async () => {
    const t = new SerialTransport(loopbackPort())
    await t.open(OPEN)
    const err = (await sayHello(t, 2, { timeoutMs: 200 }).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/echoing/)
    expect(err.message).toMatch(/switched on/)
    expect(err.message).toMatch(/pushed all the way in/)
    // And it must not blame the firmware, which is what the old code did.
    expect(err.message).not.toMatch(/firmware/i)
    await t.close()
  })

  it('reports a loopback on a memory read too', async () => {
    const t = new SerialTransport(loopbackPort())
    await t.open(OPEN)
    const err = (await readMem(t, 0x0000, 0x80, { timeoutMs: 200 }).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(LoopbackDetectedError)
    expect(err.message).toMatch(/while reading memory/)
    await t.close()
  })

  it('still works on a cable that echoes AND carries a real reply', async () => {
    // Some cables echo but the radio answers behind it. Skipping exactly one
    // echo keeps those working.
    const port = new FakeSerialPort({
      respond: (written) => {
        const payload = xorArray(written.subarray(4, 4 + written[2]!))
        if (payload[0] !== 0x14) return written
        const body = new Uint8Array(28)
        body[0] = 0x15
        body[1] = 0x05
        for (let i = 0; i < 'k5_2.01.26'.length; i++) body[4 + i] = 'k5_2.01.26'.charCodeAt(i)
        // Echo first, then the genuine reply.
        return Uint8Array.from([...written, ...buildFrame(body)])
      },
    })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await expect(sayHello(t, 3, { timeoutMs: 500 })).resolves.toBe('k5_2.01.26')
    await t.close()
  })

  it('refuses a hello reply with no firmware version in it', async () => {
    // Distinct from a loopback: a well-formed reply that simply carries nothing
    // resembling a version string is not an "unknown firmware" either.
    const port = new FakeSerialPort({
      respond: () => buildFrame(Uint8Array.from([0x15, 0x05, 0x00, 0x00, ...new Array(24).fill(0x41)])),
    })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    const err = (await sayHello(t, 2, { timeoutMs: 200 }).catch((e: unknown) => e)) as Error
    expect(err.name).toBe('NoRadioResponseError')
    await t.close()
  })
})
