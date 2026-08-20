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
 * Send the magic one byte at a time.
 *
 * CHIRP pauses ~10 ms between bytes and it is not decoration: sent as a single
 * write, these radios frequently miss it. Cheap insurance on a 7-byte string.
 */
async function sendMagic(t: Transport, magic: Uint8Array, opts?: ReadOpts): Promise<void> {
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
  await sendMagic(t, magic, opts)

  const ack = await t.readExactly(1, opts).catch(() => null)
  if (ack === null) {
    throw new NoRadioResponseError('the radio did not answer the identification sequence')
  }
  if (ack[0] !== ACK) {
    // An echo of our own magic is the classic bad-adapter signature.
    if (ack[0] === magic[0]) throw new LoopbackDetectedError('while identifying the radio')
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
