// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump } from '../../codec/checksum.js'
import { ProtocolError } from '../../transport/errors.js'
import { delay, type ReadOpts, type Transport } from '../../transport/transport.js'
import { LoopbackDetectedError, NoRadioResponseError } from '../../radio/driver.js'

/**
 * Baofeng UV-82 serial protocol.
 *
 * Transcribed from CHIRP's `chirp/drivers/uv5r.py` (GPL-3.0), which serves the
 * whole classic UV-5R family. This is an entirely different protocol from the
 * UV-17 Pro family that the UV-5R *Mini* belongs to, despite the similar name:
 * 9600 baud rather than 115200, a seven-byte magic rather than an ASCII string,
 * plain unobfuscated blocks, and 'S'/'X' commands instead of framed packets.
 */

/** The classic family runs at 9600; nothing else is accepted. */
export const BAUD_RATE = 9600

/** Ident bytes prefix the image, so every documented offset includes them. */
export const IDENT_SIZE = 8
/** Radio address space of the main block. */
export const MAIN_SIZE = 0x1800
/** The auxiliary area, read separately from 0x1EC0. */
export const AUX_START = 0x1ec0
export const AUX_END = 0x2000
export const BLOCK_SIZE = 0x40
/** ident + main + aux. */
export const IMAGE_SIZE = IDENT_SIZE + MAIN_SIZE + (AUX_END - AUX_START)

const ACK = 0x06

/**
 * Model magics, from `UV5R_MODEL_*` in uv5r.py.
 *
 * The radio answers exactly one of these, which is how the family is told
 * apart. Trying the wrong one gets silence rather than a wrong answer.
 */
export const MAGIC_UV82 = Uint8Array.from([0x50, 0xbb, 0xff, 0x20, 0x13, 0x01, 0x05])

/**
 * Send the magic, paced for the carrier it is going over.
 *
 * Over a cable, one byte at a time. CHIRP pauses ~10 ms between bytes and it
 * is not decoration: sent as a single write, these radios frequently miss it.
 * Cheap insurance on a 7-byte string.
 *
 * Over Bluetooth, one write. Seven single-byte writes are seven round trips
 * down the slowest link in the system to deliver seven bytes, and there is
 * no UART on this side of a GATT link whose timing the pacing could be
 * protecting. The UV-5R Mini's driver has always sent its magic whole.
 *
 * Keyed on `kind`, the carrier, not on `radioLink`: how to chunk a write
 * belongs to the link the host is on, where the block size belongs to what
 * the radio believes. This is the distinction those two fields exist for.
 *
 * Worth knowing what this is NOT. It was written to explain why a UV-82
 * behind a Baofeng BT-A1D drew nothing where a UV-5R Mini through the same
 * dongle read a whole codeplug - a bench probe had found single-byte writes
 * drawing silence and whole writes drawing replies. That hypothesis is dead:
 * the UV-82 was tried again with the magic going out whole, confirmed on the
 * wire by a trace, and stayed just as silent. This is a round-trip
 * improvement and nothing more. See docs/protocols/ble-dongle.md.
 */
async function sendMagic(t: Transport, magic: Uint8Array, opts?: ReadOpts): Promise<void> {
  if (t.kind === 'bluetooth') {
    await t.write(magic, opts)
    return
  }
  for (const byte of magic) {
    await t.write(Uint8Array.from([byte]), opts)
    await delay(10, opts?.signal)
  }
}

export interface IdentResult {
  /** The 8 ident bytes that prefix the image. */
  ident: Uint8Array
  raw: Uint8Array
}

/**
 * Handshake, and return the ident block that prefixes the image.
 *
 * The reply is read a byte at a time until 0xDD because its length varies: 8
 * bytes on most of the family, 12 on some UV-6 units. A 12-byte reply is
 * squeezed back to 8 by keeping bytes 0, 3, 5 and 7.. so that every offset in
 * the memory map stays where CHIRP put it.
 */
export async function identify(t: Transport, magic: Uint8Array, opts?: ReadOpts): Promise<IdentResult> {
  /*
   * The magic is tried three times, with the line drained before each try.
   *
   * Both halves earned their place on the UV-5G bench unit. The drain is for
   * a byte left over in the adapter from an earlier session, which comes back
   * as the answer to the magic. The retry is for the radio itself: the first
   * contact after it has sat idle for a while was answered with 0xfe, every
   * time, by a radio that then acknowledged the very next attempt - the
   * first exchange evidently wakes it rather than reaching it. CHIRP has the
   * same structure in `_ident_radio`, which sleeps and moves on to the next
   * magic; with one magic per radio here, moving on means trying it again.
   *
   * An echo of our own magic still fails immediately: a shorted adapter
   * answers every attempt identically, and three tries against it is just a
   * slower way to say what one try already said.
   */
  let ack: Uint8Array | null = null
  const ATTEMPTS = 3
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await t.resync(120, { timeoutMs: 2000, ...(opts?.signal ? { signal: opts.signal } : {}) }).catch(() => {})
    await sendMagic(t, magic, opts)
    ack = await t.readExactly(1, opts).catch(() => null)
    if (ack !== null && ack[0] === ACK) break
    if (ack !== null && ack[0] === magic[0]) throw new LoopbackDetectedError('while identifying the radio')
    if (attempt < ATTEMPTS) await delay(1000, opts?.signal)
  }
  if (ack === null) {
    throw new NoRadioResponseError('the radio did not answer the identification sequence')
  }
  if (ack[0] !== ACK) {
    throw new ProtocolError('The radio refused the identification sequence', '06', hexDump(ack))
  }

  await t.write(Uint8Array.from([0x02]), opts)

  const bytes: number[] = []
  for (let i = 0; i < 12; i++) {
    const b = await t.readExactly(1, opts)
    bytes.push(b[0]!)
    if (b[0] === 0xdd) break
  }

  const raw = Uint8Array.from(bytes)
  let ident: Uint8Array
  if (raw.length === IDENT_SIZE) {
    ident = raw
  } else if (raw.length === 12) {
    ident = Uint8Array.from([raw[0]!, raw[3]!, raw[5]!, ...raw.subarray(7)])
  } else {
    throw new ProtocolError('Unexpected identification reply from the radio', '8 or 12 bytes', hexDump(raw))
  }

  // The radio wants one more acknowledgement before it will clone.
  await t.write(Uint8Array.from([ACK]), opts)
  const ack2 = await t.readExactly(1, opts)
  if (ack2[0] !== ACK) {
    throw new ProtocolError('The radio refused to start a clone', '06', hexDump(ack2))
  }

  return { ident, raw }
}

/**
 * Read one block.
 *
 * `S <addr:u16be> <len:u8>` out; the radio replies `X <addr> <len>` followed by
 * the data. Every block after the first is preceded by an acknowledgement,
 * which is why `first` exists - asking for it on the first block hangs.
 *
 * The echoed address and length are checked rather than assumed: a mismatch
 * means the conversation has slipped a block, and carrying on would assemble an
 * image out of correctly-formed pieces in the wrong order.
 */
export async function readBlock(
  t: Transport,
  start: number,
  size: number,
  first = false,
  opts?: ReadOpts,
): Promise<Uint8Array> {
  const cmd = Uint8Array.from([0x53, (start >> 8) & 0xff, start & 0xff, size & 0xff])
  await t.write(cmd, opts)

  if (!first) {
    const ack = await t.readExactly(1, opts)
    if (ack[0] !== ACK) {
      throw new ProtocolError(
        `The radio would not send the block at 0x${start.toString(16).padStart(4, '0')}`,
        '06',
        hexDump(ack),
      )
    }
  }

  const header = await t.readExactly(4, opts)
  const addr = (header[1]! << 8) | header[2]!
  if (header[0] !== 0x58 || addr !== start || header[3] !== size) {
    throw new ProtocolError(
      `Unexpected block header at 0x${start.toString(16).padStart(4, '0')}`,
      `58 ${((start >> 8) & 0xff).toString(16).padStart(2, '0')} ${(start & 0xff).toString(16).padStart(2, '0')} ${size.toString(16).padStart(2, '0')}`,
      hexDump(header),
    )
  }

  return t.readExactly(size, opts)
}

export interface FirmwareInfo {
  version: string
  /**
   * Some later units drop the byte at 0x1FCF when the last part of the aux area
   * is read in 0x40-byte blocks, shifting everything after it. Detected the way
   * CHIRP detects it, and worked around by reading that stretch in 0x10 blocks.
   */
  droppedByte: boolean
}

/**
 * Read the firmware version, and find out whether this unit has the
 * dropped-byte quirk.
 *
 * The read of 0x1E80 is deliberate and its result is discarded: these radios
 * return rubbish for the auxiliary area unless a block outside it has been read
 * first. CHIRP does the same, for the same reason.
 */
export async function readFirmware(t: Transport, opts?: ReadOpts): Promise<FirmwareInfo> {
  await readBlock(t, 0x1e80, BLOCK_SIZE, true, opts)
  const block1 = await readBlock(t, 0x1ec0, BLOCK_SIZE, false, opts)
  const block2 = await readBlock(t, 0x1fc0, BLOCK_SIZE, false, opts)

  let version = ''
  for (const b of block1.subarray(48, 62)) {
    if (b < 0x20 || b > 0x7e) break
    version += String.fromCharCode(b)
  }

  return { version, droppedByte: block2[15] === 0xff }
}

/**
 * The unit a write is sent in.
 *
 * Reads come back in 0x40 blocks but writes go out in 0x10 ones - CHIRP's
 * `_send_block` is called with `mmap[i:i+0x10]`, and the radio does not accept
 * a larger frame. Getting this wrong looks like a radio that refuses the first
 * block for no reason.
 */
export const WRITE_BLOCK_SIZE = 0x10

/**
 * Image offsets that must never be sent, even though they sit inside the main
 * block.
 *
 * CHIRP skips these two sixteen-byte windows on every upload and has done for
 * years. Nothing documents what lives there, which is exactly why they are left
 * alone: the cost of writing them is unknown and the benefit is zero, because
 * boofwang does not model anything in that part of memory.
 *
 * They fall outside both ranges this driver claims to own, so a diff-driven
 * write cannot reach them anyway. They are declared so that stays true by
 * construction rather than by coincidence.
 */
export const NEVER_WRITE: readonly (readonly [number, number])[] = [
  [0x0cf8, 0x0d08],
  [0x0df8, 0x0e08],
]

/**
 * Send one block and wait for the radio to accept it.
 *
 * `addr` is the **radio** address, which is the image offset less the eight
 * ident bytes that prefix the image but do not exist on the radio. Confusing
 * the two writes every block one notch off and is not recoverable by reading
 * back, because the read would be shifted the same way.
 */
export async function writeBlock(
  t: Transport,
  addr: number,
  data: Uint8Array,
  opts?: ReadOpts,
): Promise<void> {
  if (data.length !== WRITE_BLOCK_SIZE) {
    throw new ProtocolError(
      `A UV-82 write block is ${WRITE_BLOCK_SIZE} bytes`,
      String(WRITE_BLOCK_SIZE),
      String(data.length),
    )
  }

  const frame = new Uint8Array(4 + data.length)
  frame[0] = 0x58 // 'X'
  frame[1] = (addr >> 8) & 0xff
  frame[2] = addr & 0xff
  frame[3] = data.length
  frame.set(data, 4)

  await t.write(frame, opts)
  const ack = await t.readExactly(1, opts)
  if (ack[0] !== ACK) {
    throw new ProtocolError(
      `The radio refused the block at 0x${addr.toString(16).padStart(4, '0')}`,
      '06',
      hexDump(ack),
    )
  }
}
