// SPDX-License-Identifier: GPL-3.0-or-later
import { DriverError, LoopbackDetectedError } from '../../radio/driver.js'
import { ProtocolError } from '../../transport/errors.js'
import type { ReadOpts, Transport } from '../../transport/transport.js'
import { hexDump } from '../../codec/checksum.js'

/**
 * The Baofeng UV-5R Mini, which CHIRP calls `5RM`.
 *
 * A UV-17 Pro family radio rather than a UV-5R one, despite the name: the
 * classic UV-5R speaks 9600 baud in plain blocks, and this speaks 115200 with
 * every payload obfuscated. Offsets transcribed from CHIRP's
 * `baofeng_uv17Pro.py` (GPL-3.0), class `BF5RM`.
 *
 * Not to be confused with `UV-5RM Plus`, which is a separate CHIRP class with a
 * different third magic and a different obfuscation key. Programming one as the
 * other would read nonsense.
 */

export const BAUD_RATE = 115_200
export const BLOCK_SIZE = 0x40

export interface MemRegion {
  readonly start: number
  readonly size: number
  readonly label: string
}

/**
 * The two radios that answer to "UV-5R Mini", and how they differ.
 *
 * CHIRP carries both as separate classes and they are not interchangeable:
 * `UV5RMini` ("UV-5R Mini") identifies with `PROGRAMCOLORPROU`, has three
 * memory regions and 999 channels, and offers two power levels. `BF5RM`
 * ("5RM", sold as UV-5RM and relabelled as several other things) identifies
 * with `PROGRAMBFNORMALU`, has four regions and 1000 channels, and offers
 * three power levels in the order High, Low, Medium.
 *
 * The names are close enough that a user cannot reasonably be asked which they
 * have, so both idents are tried and whichever answers decides the layout.
 * Reading one as the other would put every channel's power on the wrong table
 * and ask for a region the radio does not have.
 */
export interface Uv5rVariant {
  readonly id: 'uv5rmini' | '5rm'
  readonly label: string
  readonly ident: Uint8Array
  readonly regions: readonly MemRegion[]
  readonly channelCount: number
  /**
   * Indexed directly by the channel record's two-bit `lowpower` field.
   *
   * Both the values and the names differ: 5 W is "High" on the UV-5R Mini and
   * "Medium" on the 5RM, so the label travels with the level rather than being
   * looked up from a shared table.
   */
  readonly power: readonly { mW: number; label: string }[]
}

const text = (s: string) => new TextEncoder().encode(s)

export const VARIANTS: readonly Uv5rVariant[] = [
  {
    id: 'uv5rmini',
    label: 'UV-5R Mini',
    ident: text('PROGRAMCOLORPROU'), // MSTRING_UV17PROGPS
    regions: [
      { start: 0x0000, size: 0x8040, label: 'channels and settings' },
      { start: 0x9000, size: 0x0040, label: 'block 0x9000' },
      { start: 0xa000, size: 0x01c0, label: 'block 0xa000' },
    ],
    channelCount: 999,
    power: [
      { mW: 5000, label: 'High' },
      { mW: 1000, label: 'Low' },
    ],
  },
  {
    id: '5rm',
    label: '5RM / UV-5RM',
    ident: text('PROGRAMBFNORMALU'), // MSTRING_UV17L
    regions: [
      { start: 0x0000, size: 0x8040, label: 'channels and settings' },
      { start: 0x9000, size: 0x0040, label: 'block 0x9000' },
      { start: 0xa000, size: 0x02c0, label: 'block 0xa000' },
      { start: 0xd000, size: 0x0040, label: 'block 0xd000' },
    ],
    channelCount: 1000,
    power: [
      { mW: 8000, label: 'High' },
      { mW: 1000, label: 'Low' },
      { mW: 5000, label: 'Medium' },
    ],
  },
]

export const imageSize = (v: Uv5rVariant): number => v.regions.reduce((n, r) => n + r.size, 0)

export const ACK = 0x06

/**
 * The three follow-up magics, each with the reply length it must produce.
 *
 * Shared by both variants: neither overrides `_magics`. `UV-5RM Plus` does, and
 * also changes the obfuscation key, which is why it is not handled here.
 */
export const MAGICS: readonly { send: Uint8Array; replyLength: number }[] = [
  { send: Uint8Array.from([0x46]), replyLength: 16 },
  { send: Uint8Array.from([0x4d]), replyLength: 15 },
  {
    send: Uint8Array.from([
      0x53, 0x45, 0x4e, 0x44, 0x21, 0x05, 0x0d, 0x01, 0x01, 0x01, 0x04, 0x11, 0x08, 0x05, 0x0d,
      0x0d, 0x01, 0x11, 0x0f, 0x09, 0x12, 0x09, 0x10, 0x04, 0x00,
    ]),
    replyLength: 1,
  },
]

/**
 * The obfuscation key: entry 1 of CHIRP's table, `"CO 7"`.
 *
 * Not encryption - a rotating four-byte XOR with exceptions - but the payload
 * is unreadable without it. The exceptions are what make it fiddly: a byte is
 * left alone when the key byte is a space, or when the byte is 0x00, 0xFF, the
 * key byte itself, or the key byte inverted. Getting one exception wrong
 * corrupts scattered bytes rather than all of them, which looks like a bad
 * cable rather than a bad implementation.
 */
export const CRYPT_KEY = Uint8Array.from([0x43, 0x4f, 0x20, 0x37]) // "CO 7"

export function decrypt(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) {
    const key = CRYPT_KEY[i % 4]!
    const b = data[i]!
    const skip = key === 0x20 || b === 0x00 || b === 0xff || b === key || b === (key ^ 0xff)
    out[i] = skip ? b : b ^ key
  }
  return out
}

/** The transform is its own inverse: XOR, with exceptions on values it preserves. */
export const encrypt = decrypt

/**
 * `cmd + 16-bit big-endian address + one length byte`.
 *
 * Big-endian, unlike almost everything else in this codebase. CHIRP builds it
 * as `struct.pack(">i", addr)[2:]`, which is the low half of a big-endian
 * 32-bit value.
 */
export function frame(cmd: number, addr: number, length: number, data?: Uint8Array): Uint8Array {
  const head = Uint8Array.from([cmd, (addr >> 8) & 0xff, addr & 0xff, length & 0xff])
  if (!data) return head
  const out = new Uint8Array(head.length + data.length)
  out.set(head, 0)
  out.set(data, head.length)
  return out
}

export interface IdentResult {
  /** Which of the two radios answered. */
  readonly variant: Uv5rVariant
  /** The 16-byte reply to the 0x46 magic. */
  readonly info: Uint8Array
  /** The 15-byte reply to the 0x4d magic, which carries printable model text. */
  readonly detail: Uint8Array
}

/**
 * Try each ident in turn, then walk the three magics.
 *
 * The first byte back decides everything, so it is read on its own: a cable
 * shorting transmit to receive answers with the first byte of whatever was
 * sent - 0x50, the 'P' of `PROGRAM...` - and saying so beats reporting a radio
 * that will not talk. That distinction cost hours on another radio in this
 * project, so it is made before anything else.
 */
export async function handshake(t: Transport, opts?: ReadOpts): Promise<IdentResult> {
  const signalOpt = opts?.signal ? { signal: opts.signal } : {}
  let sawEcho = false

  for (const variant of VARIANTS) {
    await t.resync(120, { timeoutMs: 2000, ...signalOpt }).catch(() => {})
    await t.write(variant.ident, opts)

    const ack = await t.readExactly(1, opts).catch(() => null)
    if (ack === null) continue
    if (ack[0] === variant.ident[0]) {
      sawEcho = true
      continue
    }
    if (ack[0] !== ACK) continue

    const replies: Uint8Array[] = []
    for (const magic of MAGICS) {
      await t.write(magic.send, opts)
      const reply = await t.readExactly(magic.replyLength, opts).catch(() => null)
      if (reply === null || reply.length !== magic.replyLength) {
        throw new ProtocolError(
          `The ${variant.label} stopped answering part way through the handshake ` +
            `(magic ${hexDump(magic.send, 4)} wanted ${magic.replyLength} bytes)`,
        )
      }
      replies.push(reply)
    }
    return { variant, info: replies[0]!, detail: replies[1]! }
  }

  if (sawEcho) throw new LoopbackDetectedError('while identifying the radio')
  throw new ProtocolError(
    'No UV-5R Mini answered. Check the radio is switched on and the plug is pushed all the way in.',
  )
}

/**
 * Read one block, and check the radio echoed the address it was asked for.
 *
 * The reply repeats the four-byte request header before the payload. CHIRP
 * discards it; comparing it instead is what catches a read that has slipped a
 * frame, which would otherwise return a neighbouring block's bytes and store
 * them under the wrong address.
 */
export async function readBlock(
  t: Transport,
  addr: number,
  length = BLOCK_SIZE,
  opts?: ReadOpts,
): Promise<Uint8Array> {
  await t.write(frame(0x52, addr, length), opts)
  const reply = await t.readExactly(length + 4, opts)

  const wantHeader = frame(0x52, addr, length)
  for (let i = 0; i < 4; i++) {
    if (reply[i] !== wantHeader[i]) {
      throw new ProtocolError(
        `The radio answered for a different address than the one requested`,
        hexDump(wantHeader, 4),
        hexDump(reply.subarray(0, 4), 4),
      )
    }
  }
  return decrypt(reply.subarray(4))
}

/**
 * Write one block and wait for the acknowledgement.
 *
 * Kept beside the reader so the two cannot drift, and unused until the write
 * path is exercised against hardware.
 */
export async function writeBlock(
  t: Transport,
  addr: number,
  data: Uint8Array,
  opts?: ReadOpts,
): Promise<void> {
  if (data.length !== BLOCK_SIZE) {
    throw new DriverError(`A block is ${BLOCK_SIZE} bytes, not ${data.length}`)
  }
  await t.write(frame(0x57, addr, data.length, encrypt(data)), opts)
  const ack = await t.readExactly(1, opts)
  if (ack[0] !== ACK) {
    throw new ProtocolError(
      `The radio did not acknowledge the block at 0x${addr.toString(16)}`,
      hexDump(Uint8Array.from([ACK]), 1),
      hexDump(ack, 1),
    )
  }
}
