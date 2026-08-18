// SPDX-License-Identifier: GPL-3.0-or-later
import { crc16Xmodem, hexDump } from '../../codec/checksum.js'
import { ProtocolError } from '../../transport/errors.js'
import type { ReadOpts, Transport } from '../../transport/transport.js'
import { LoopbackDetectedError, NoRadioResponseError, RadioInProgrammingModeError } from '../../radio/driver.js'

/**
 * Quansheng UV-K5 serial protocol.
 *
 * Transcribed from CHIRP's `chirp/drivers/uvk5.py` (GPL-3.0), which in turn
 * derives from Jacek Lipkowski SQ5BPF's reverse engineering. Function names
 * here mirror CHIRP's so the two can be read side by side.
 */

/** The radio accepts no other line rate. */
export const BAUD_RATE = 38_400

export const MEM_SIZE = 0x2000
/** The programmable range. Everything from here up is calibration. */
export const PROG_SIZE = 0x1d00
/** The largest block that can be read or written reliably. */
export const MEM_BLOCK = 0x80

/** A session constant that appears in every command. */
const MAGIC = Uint8Array.from([0x6a, 0x39, 0x57, 0x64])

const HDR_0 = 0xab
const HDR_1 = 0xcd
const FTR_0 = 0xdc
const FTR_1 = 0xba

/**
 * The obfuscation table. Applied cyclically from the start of each packet's
 * payload, and symmetric - the same call encodes and decodes.
 */
const XOR_TABLE = Uint8Array.from([22, 108, 20, 230, 46, 145, 13, 64, 33, 53, 213, 64, 19, 3, 233, 128])

export function xorArray(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ XOR_TABLE[i % XOR_TABLE.length]!
  return out
}

/**
 * Wrap a payload for transmission.
 *
 * `AB CD <len> 00` + obfuscate(payload ‖ crc16(payload) little-endian) + `DC BA`
 *
 * Note the length byte counts the payload *without* its CRC, while the
 * obfuscated body is two bytes longer. That asymmetry is deliberate in the
 * original protocol and makes send and receive framing identical: after the
 * header come `len` payload bytes, then two CRC bytes, then the footer.
 */
export function buildFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > 0xff) throw new RangeError(`UV-K5 payload too long: ${payload.length}`)
  const withCrc = new Uint8Array(payload.length + 2)
  withCrc.set(payload, 0)
  const crc = crc16Xmodem(payload)
  withCrc[payload.length] = crc & 0xff
  withCrc[payload.length + 1] = (crc >> 8) & 0xff

  const body = xorArray(withCrc)
  const frame = new Uint8Array(4 + body.length + 2)
  frame[0] = HDR_0
  frame[1] = HDR_1
  frame[2] = payload.length
  frame[3] = 0x00
  frame.set(body, 4)
  frame[frame.length - 2] = FTR_0
  frame[frame.length - 1] = FTR_1
  return frame
}

export interface FramingOpts extends ReadOpts {
  /** Human-readable USB adapter description, quoted back in a loopback error. */
  adapter?: string | undefined
  /** Verify the reply CRC. CHIRP does not; we do by default, and say so on failure. */
  verifyCrc?: boolean | undefined
}

/**
 * Read one reply frame and return its deobfuscated payload.
 *
 * The header is read first so the body length is known before waiting on it -
 * which is what keeps a truncated reply from silently becoming the front of the
 * next one.
 */
export async function readFrame(t: Transport, opts: FramingOpts = {}): Promise<Uint8Array> {
  const header = await t.readExactly(4, opts)
  if (header[0] !== HDR_0 || header[1] !== HDR_1 || header[3] !== 0x00) {
    throw new ProtocolError('Bad UV-K5 reply header', `${HDR_0.toString(16)} ${HDR_1.toString(16)} ?? 00`, hexDump(header))
  }
  const length = header[2]!
  const body = await t.readExactly(length, opts)
  const footer = await t.readExactly(4, opts)
  if (footer[2] !== FTR_0 || footer[3] !== FTR_1) {
    throw new ProtocolError('Bad UV-K5 reply footer', `?? ?? ${FTR_0.toString(16)} ${FTR_1.toString(16)}`, hexDump(footer))
  }

  const payload = xorArray(body)

  if (opts.verifyCrc !== false) {
    // The first two footer bytes are the CRC over the payload, obfuscated
    // continuing from where the body left off.
    const deob = xorArray(Uint8Array.from([...body, footer[0]!, footer[1]!]))
    const got = deob[length]! | (deob[length + 1]! << 8)
    const want = crc16Xmodem(payload)
    if (got !== want) {
      throw new ProtocolError(
        'UV-K5 reply failed its checksum',
        `crc16 ${want.toString(16).padStart(4, '0')}`,
        `crc16 ${got.toString(16).padStart(4, '0')} for payload ${hexDump(payload, 16)}`,
      )
    }
  }

  return payload
}

export async function sendCommand(t: Transport, payload: Uint8Array, opts?: ReadOpts): Promise<void> {
  await t.write(buildFrame(payload), opts)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Send a command and return the radio's reply, skipping an echo of the command
 * itself.
 *
 * Some cables put the transmitted bytes back on the receive line. The echo is a
 * structurally perfect frame, so nothing below this notices - which is why it
 * has to be handled by identity rather than by validation. Comparing against
 * what was just sent is unambiguous: command opcodes (0x14 hello, 0x1B read,
 * 0x1D write, 0xDD reset) and reply opcodes (0x15/0x18, 0x1C, 0x1E) are
 * disjoint, so a genuine reply can never equal the command.
 *
 * Exactly one echo is skipped. If the echo is all that comes back, the radio is
 * not talking, and saying so is far more useful than letting the caller puzzle
 * over a reply that happens to be its own question.
 */
export async function command(t: Transport, payload: Uint8Array, opts?: FramingOpts): Promise<Uint8Array> {
  await sendCommand(t, payload, opts)
  const reply = await readFrame(t, opts)
  if (!sameBytes(reply, payload)) return reply

  try {
    const second = await readFrame(t, opts)
    if (sameBytes(second, payload)) throw new LoopbackDetectedError(describeCommand(payload), opts?.adapter)
    return second
  } catch (e) {
    if (e instanceof LoopbackDetectedError) throw e
    // Nothing followed the echo: the adapter is looping back and the radio is silent.
    throw new LoopbackDetectedError(describeCommand(payload), opts?.adapter)
  }
}

function describeCommand(payload: Uint8Array): string {
  switch (payload[0]) {
    case 0x14:
      return 'while identifying the radio'
    case 0x1b:
      return 'while reading memory'
    case 0x1d:
      return 'while writing memory'
    default:
      return `command 0x${(payload[0] ?? 0).toString(16).padStart(2, '0')}`
  }
}

// ----------------------------------------------------------------- commands --

export const HELLO = Uint8Array.from([0x14, 0x05, 0x04, 0x00, ...MAGIC])
export const RESET = Uint8Array.from([0xdd, 0x05, 0x00, 0x00])

/**
 * Extract the firmware string from a hello reply.
 *
 * Mirrors CHIRP's `_getstring(rep, 4, 24)`: start at offset 4 and stop at the
 * first byte outside printable ASCII. CHIRP returns an empty string if it never
 * finds one, and that behaviour is kept - a reply with 24 printable bytes and
 * no terminator is not a firmware string we recognise, and pretending otherwise
 * would let an unknown radio through the variant gate.
 */
export function parseFirmwareString(reply: Uint8Array, begin = 4, maxLen = 24): string {
  const end = Math.min(begin + maxLen + 1, reply.length)
  let s = ''
  for (let i = begin; i < end; i++) {
    const c = reply[i]!
    if (c < 0x20 || c > 0x7e) return s
    s += String.fromCharCode(c)
  }
  return ''
}

/**
 * Say hello and return the firmware string.
 *
 * Retried, because the first packet after the cable is seated is frequently
 * lost. A reply beginning `18 05` means the radio booted into programming mode
 * and has to be restarted - a distinct condition worth its own error, since the
 * fix is physical.
 */
export async function sayHello(t: Transport, tries = 5, opts?: FramingOpts): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const reply = await command(t, HELLO, opts)
      if (reply.length >= 2 && reply[0] === 0x18 && reply[1] === 0x05) {
        throw new RadioInProgrammingModeError()
      }
      const firmware = parseFirmwareString(reply)
      // An empty string means no terminator was found in the reply, so nothing
      // in it looks like a firmware version. Treating that as an unrecognised
      // *firmware* would be wrong and actively misleading - it points at the
      // radio's software when the real problem is that this is not a firmware
      // reply at all.
      if (firmware === '') {
        throw new NoRadioResponseError('the reply to the hello command contained no firmware version')
      }
      return firmware
    } catch (e) {
      // Neither of these improves with retrying, and both need the user to do
      // something physical.
      if (e instanceof RadioInProgrammingModeError || e instanceof LoopbackDetectedError) throw e
      lastError = e
      if (t.state === 'desynced') await t.resync(100).catch(() => {})
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ProtocolError('The radio did not respond to the hello command')
}

/** `1B 05 08 00 <offset:u16le> <len:u8> 00 <magic>`; data starts at reply byte 8. */
export function buildReadMem(offset: number, length: number): Uint8Array {
  return Uint8Array.from([
    0x1b, 0x05, 0x08, 0x00,
    offset & 0xff, (offset >> 8) & 0xff,
    length & 0xff, 0x00,
    ...MAGIC,
  ])
}

export async function readMem(t: Transport, offset: number, length: number, opts?: FramingOpts): Promise<Uint8Array> {
  const reply = await command(t, buildReadMem(offset, length), opts)
  if (reply.length < 8 + length) {
    throw new ProtocolError(
      `Short read at 0x${offset.toString(16).padStart(4, '0')}`,
      `${8 + length} bytes`,
      `${reply.length} bytes: ${hexDump(reply, 16)}`,
    )
  }
  return reply.slice(8, 8 + length)
}

/** `1D 05 <len+8> 00 <offset:u16le> <len:u8> 01 <magic> <data>`. */
export function buildWriteMem(offset: number, data: Uint8Array): Uint8Array {
  const n = data.length
  return Uint8Array.from([
    0x1d, 0x05, (n + 8) & 0xff, 0x00,
    offset & 0xff, (offset >> 8) & 0xff,
    n & 0xff, 0x01,
    ...MAGIC,
    ...data,
  ])
}

export async function writeMem(t: Transport, offset: number, data: Uint8Array, opts?: FramingOpts): Promise<void> {
  const reply = await command(t, buildWriteMem(offset, data), opts)
  const ok =
    reply.length >= 6 && reply[0] === 0x1e && reply[4] === (offset & 0xff) && reply[5] === ((offset >> 8) & 0xff)
  if (!ok) {
    throw new ProtocolError(
      `The radio rejected a write at 0x${offset.toString(16).padStart(4, '0')}`,
      `1e ?? ?? ?? ${(offset & 0xff).toString(16).padStart(2, '0')} ${((offset >> 8) & 0xff).toString(16).padStart(2, '0')}`,
      hexDump(reply, 8),
    )
  }
}

/**
 * Reboot the radio out of programming mode.
 *
 * Fire-and-forget: the radio resets rather than replying, so waiting for one
 * would always time out.
 */
export async function resetRadio(t: Transport, opts?: ReadOpts): Promise<void> {
  await sendCommand(t, RESET, opts)
}
