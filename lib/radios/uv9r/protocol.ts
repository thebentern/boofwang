// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump } from '../../codec/checksum.js'
import { ProtocolError } from '../../transport/errors.js'
import { delay, type ReadOpts, type Transport } from '../../transport/transport.js'
import { LoopbackDetectedError, NoRadioResponseError } from '../../radio/driver.js'

/**
 * The serial protocol of CHIRP's WP970I family: the Baofeng UV-9R, the UV-9G
 * and the radios sold beside them.
 *
 * Transcribed from CHIRP's `chirp/drivers/baofeng_common.py` (GPL-3.0), which
 * `baofeng_wp970i.py` builds every member of the family on. On the wire it is
 * the classic UV-5R conversation - 9600 baud, a seven-byte magic, 'S' and 'X'
 * blocks - and `lib/radios/uv82/protocol.ts` already speaks that dialect. It is
 * written out a second time because CHIRP wrote it out a second time, and the
 * places where the two disagree are exactly the places a radio would notice:
 *
 * - the magic goes out in one write (`_rawsend(radio, magic)`), where uv5r.py
 *   dribbles it a byte at a time;
 * - the identification reply is exactly eight bytes framed `AA .. DD`
 *   (`_magic_response_length`), where uv5r.py reads up to a `DD`;
 * - the host acknowledges every block it receives with 0x06 and then waits
 *   50 ms, on every read, which boofwang's UV-5R family driver does not do;
 * - memory is read as one flat 0x2000, not as a main block and an aux block.
 *
 * None of this has been seen on a wire by boofwang. It is what CHIRP sends,
 * and CHIRP is reported downloading and uploading a UV-9R, a UV-9G and a
 * UV-9R Pro over an FTDI cable (CHIRP issue 10270, 2023-11-30). Where boofwang
 * has a choice it makes CHIRP's, because the reference is the only prior there
 * is. See docs/protocols/uv9r.md.
 */

/** `_do_ident` sets 9600 8N1 and nothing else is tried. */
export const BAUD_RATE = 9600

/** `_mem_size`: the whole radio memory, read in one sweep. */
export const MEM_SIZE = 0x2000
/** `_magic_response_length`. */
export const IDENT_SIZE = 8
/**
 * Where the ident sits in the image.
 *
 * CHIRP's `_download` ends `data += ident`, so this family's image carries
 * the eight ident bytes *after* the memory - the opposite of uv5r.py, which
 * prefixes them. Image offset and radio address are therefore the same number
 * for every byte below 0x2000.
 */
export const IDENT_OFFSET = MEM_SIZE
/** Memory plus the trailing ident: CHIRP's 0x2008-byte image. */
export const IMAGE_SIZE = MEM_SIZE + IDENT_SIZE

/** `_recv_block_size`. */
export const BLOCK_SIZE = 0x40
/**
 * `_send_block_size`: writes go out in sixteen-byte frames even though reads
 * come back in sixty-four.
 */
export const WRITE_BLOCK_SIZE = 0x10

/**
 * CHIRP's 50 ms pause: after each acknowledgment it sends while reading
 * (`time.sleep(0.05)` in `_read_block` and `_download`), and after each frame
 * it sends while writing, before it reads the radio's answer (`_upload`).
 *
 * Kept although it costs about six seconds a read. It is part of the only
 * sequence anyone has reported working against these radios, and taking it
 * out is a hardware experiment, not a cleanup.
 */
export const ACK_PAUSE_MS = 50

const ACK = 0x06

/**
 * `MSTRING_WP970I`: the magic CHIRP sends for the WP970I, BF-A58, UV-82WP,
 * GT-3WP, RT6, BF-A58S and UV-9R alike.
 *
 * And not only for this family. The same seven bytes are `UV5R_MODEL_A58` in
 * uv5r.py, which CHIRP sends to the tri-power BF-F8HP - a UV-5R family radio,
 * 8 W where the UV-9R is 5 - so an acknowledgment does not even say which
 * family answered. CHIRP separates them by the model the user picked from a
 * list, and boofwang by the radio picked on the connect screen; what the
 * radio says after the magic is weighed in `identify` before writing is
 * offered.
 */
export const MAGIC_WP970I = Uint8Array.from([0x50, 0xbb, 0xff, 0x20, 0x14, 0x04, 0x13])

export interface IdentResult {
  /** The eight bytes the radio sent after 0x02, framed `AA .. DD`. */
  readonly ident: Uint8Array
}

/**
 * Put the radio in programming mode and return its identification reply.
 *
 * `_do_ident` and `_ident_radio`, with one addition. CHIRP sends each magic
 * once and moves on to the next after a two-second pause. Here each magic is
 * tried up to three times, the line drained before every try, because the
 * UV-5G bench unit answered the first contact after sitting idle with 0xfe and
 * acknowledged the very next attempt - and the UV-9G sends the same ident
 * bytes as that UV-5G, which makes the same hardware a reasonable guess. A
 * retry costs a second against a radio that answers first time.
 *
 * An echo of the magic fails at once: a shorted adapter answers every attempt
 * identically, and three tries against it say no more than one.
 */
export async function identify(t: Transport, magics: readonly Uint8Array[], opts?: ReadOpts): Promise<IdentResult> {
  let ack: Uint8Array | null = null
  const ATTEMPTS = 3
  identified: for (let m = 0; m < magics.length; m++) {
    const magic = magics[m]!
    // `_ident_radio` sleeps two seconds before the next magic.
    if (m > 0) await delay(2000, opts?.signal)
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      // `_clean_buffer`: whatever an earlier session left in the adapter would
      // otherwise come back as the answer to the magic.
      await t.resync(120, { timeoutMs: 2000, ...(opts?.signal ? { signal: opts.signal } : {}) }).catch(() => {})
      await t.write(magic, opts)
      ack = await t.readExactly(1, opts).catch(() => null)
      if (ack !== null && ack[0] === ACK) break identified
      if (ack !== null && ack[0] === magic[0]) throw new LoopbackDetectedError('while identifying the radio')
      if (attempt < ATTEMPTS) await delay(1000, opts?.signal)
    }
  }
  if (ack === null) {
    throw new NoRadioResponseError('the radio did not answer the identification sequence')
  }
  if (ack[0] !== ACK) {
    throw new ProtocolError('The radio refused the identification sequence', '06', hexDump(ack))
  }

  await t.write(Uint8Array.from([0x02]), opts)

  // Exactly eight, and framed. `_do_ident` refuses anything that does not
  // start 0xAA and end 0xDD, and so does this.
  const ident = await t.readExactly(IDENT_SIZE, opts)
  if (ident[0] !== 0xaa || ident[IDENT_SIZE - 1] !== 0xdd) {
    throw new ProtocolError('Unexpected identification reply from the radio', 'aa .. dd, 8 bytes', hexDump(ident))
  }

  await t.write(Uint8Array.from([ACK]), opts)
  const ack2 = await t.readExactly(1, opts)
  if (ack2[0] !== ACK) {
    throw new ProtocolError('The radio refused to start a clone', '06', hexDump(ack2))
  }

  return { ident }
}

/**
 * Read one block: `_read_block`, including the half the UV-82 driver leaves out.
 *
 * `S <addr:u16be> <len:u8>` out; the radio sends 0x06 - except on the first
 * read after the handshake, CHIRP's `first_command` - then `X <addr> <len>`
 * and the data. Then the host sends 0x06 of its own and waits 50 ms.
 *
 * That last step is the difference. boofwang's UV-5R family driver never
 * sends it and works on three radios, which proves those radios do not need
 * it. It proves nothing about these: if the radio's 0x06 before a header is
 * its answer to the host's 0x06 rather than to the 'S', a reader that stays
 * silent waits for an acknowledgment that never comes. CHIRP's sequence works
 * under either reading, so it is the one used.
 *
 * The echoed address and length are checked, because a mismatch means the
 * conversation slipped a block. They do not catch a radio that echoes the
 * address it was asked for and returns another block's bytes - which the
 * UV-5R does when asked for sixteen bytes - so nothing here reads in sixteen
 * except the dropped-byte tail CHIRP itself reads that way.
 */
export async function readBlock(
  t: Transport,
  start: number,
  size: number,
  first = false,
  opts?: ReadOpts,
): Promise<Uint8Array> {
  const at = `0x${start.toString(16).padStart(4, '0')}`
  await t.write(Uint8Array.from([0x53, (start >> 8) & 0xff, start & 0xff, size & 0xff]), opts)

  if (!first) {
    const ack = await t.readExactly(1, opts)
    if (ack[0] !== ACK) {
      throw new ProtocolError(`The radio would not send the block at ${at}`, '06', hexDump(ack))
    }
  }

  const header = await t.readExactly(4, opts)
  const addr = (header[1]! << 8) | header[2]!
  if (header[0] !== 0x58 || addr !== start || header[3] !== size) {
    throw new ProtocolError(
      `Unexpected block header at ${at}`,
      hexDump(Uint8Array.from([0x58, (start >> 8) & 0xff, start & 0xff, size & 0xff])),
      hexDump(header),
    )
  }

  const data = await t.readExactly(size, opts)
  await t.write(Uint8Array.from([ACK]), opts)
  await delay(ACK_PAUSE_MS, opts?.signal)
  return data
}

export interface FirmwareInfo {
  /**
   * The firmware string, or '' when the radio stores none.
   *
   * `block1[48:62]` of the aux area - radio 0x1EF0, CHIRP's `firmware_msg`.
   * On every unit of this family boofwang has bytes from, that window holds no
   * firmware at all: all 0xFF on a 2017 UV-9R, and `???????` then 0xFF on a
   * 2018 UV-9R Pro, a UV-9G and a BF-A58S. A run of question marks is the
   * factory's placeholder rather than a version, so it reads as '' instead of
   * reaching the connect screen as "firmware ???????". The raw window travels
   * in `window` and in the identify result's `meta`.
   */
  readonly version: string
  readonly window: Uint8Array
  /**
   * Some later units drop the byte at 0x1FCF when the tail of memory is read
   * in 0x40 blocks, shifting everything after it. Detected the way CHIRP
   * detects it - 0xFF at that address - and worked around the same way, by
   * reading the last 0x40 bytes in sixteens.
   *
   * The test is CHIRP's and it is not specific: any radio whose 0x1FCF is
   * simply erased takes the slow path too. The synthetic UV-9R image is one,
   * by construction. A BF-A58S in CHIRP's own test images holds 0xFF there,
   * where its third band's limit record ends - and whether it also drops a
   * byte that capture cannot say, because 0x1FD0 is 0xFF as well and the
   * shifted read would look the same.
   */
  readonly droppedByte: boolean
}

/** The printable run at the start of the firmware window, as CHIRP prints it. */
export function firmwareVersion(window: Uint8Array): string {
  let s = ''
  for (const b of window) {
    if (b < 0x20 || b > 0x7e) break
    s += String.fromCharCode(b)
  }
  s = s.trimEnd()
  return /^\?*$/.test(s) ? '' : s
}

/**
 * Read the firmware window and find out whether this unit drops a byte.
 *
 * `_get_radio_firmware_version`, block for block. The read of 0x1E80 is
 * deliberate and discarded: CHIRP records that newer radios answer with
 * "alternative (aka: bad) data" for the aux area unless a block outside it
 * was read first.
 */
export async function readFirmware(t: Transport, opts?: ReadOpts): Promise<FirmwareInfo> {
  await readBlock(t, 0x1e80, BLOCK_SIZE, true, opts)
  const block1 = await readBlock(t, 0x1ec0, BLOCK_SIZE, false, opts)
  const block2 = await readBlock(t, 0x1fc0, BLOCK_SIZE, false, opts)
  const window = block1.slice(48, 62)
  return { version: firmwareVersion(window), window, droppedByte: block2[15] === 0xff }
}

/**
 * Send one sixteen-byte block and wait for the radio to take it.
 *
 * `_upload`'s inner loop: `X <addr> <len> <data>`, a 50 ms pause, then one
 * byte back that must be 0x06. The address is the radio's, which in this
 * family is also the image offset.
 *
 * The pause is the part that is easy to drop, and it was dropped here at
 * first, on the reasoning that waiting for the acknowledgment waits anyway.
 * It does not, and that is the other unsettled thing about this
 * acknowledgment. If the radio's 0x06 before a block header answers the
 * host's 0x06 after the previous block, then one of those is still in flight
 * when the first write goes out, and every write reads the acknowledgment of
 * the one before it - which is already there, so without the pause frames go
 * out back to back while the radio may still be programming the last one.
 * CHIRP's pause paces the frames whichever reading is right, so it is kept.
 *
 * CHIRP never notices the off-by-one because every byte involved is 0x06.
 * Neither does the write path here, for the same reason - and it never treats
 * an acknowledgment as proof of anything, because every block it sends is
 * read back before the write is called done.
 */
export async function writeBlock(t: Transport, addr: number, data: Uint8Array, opts?: ReadOpts): Promise<void> {
  if (data.length !== WRITE_BLOCK_SIZE) {
    throw new ProtocolError(
      `A WP970I-family write block is ${WRITE_BLOCK_SIZE} bytes`,
      String(WRITE_BLOCK_SIZE),
      String(data.length),
    )
  }
  const frame = new Uint8Array(4 + data.length)
  frame[0] = 0x58
  frame[1] = (addr >> 8) & 0xff
  frame[2] = addr & 0xff
  frame[3] = data.length
  frame.set(data, 4)

  await t.write(frame, opts)
  await delay(ACK_PAUSE_MS, opts?.signal)
  const ack = await t.readExactly(1, opts)
  if (ack[0] !== ACK) {
    throw new ProtocolError(
      `The radio refused the block at 0x${addr.toString(16).padStart(4, '0')}`,
      '06',
      hexDump(ack),
    )
  }
}

/**
 * `_ranges` on `WP970I`: every span CHIRP's upload sends when the radio's
 * auxiliary memory does not match the image.
 *
 * Kept as a ceiling rather than a plan. boofwang writes far less - only the
 * channel records, the settings block and the names - and every byte it owns
 * sits inside these spans, which a test asserts. So nothing boofwang would
 * ever send to this radio is something CHIRP does not also send to it.
 */
export const CHIRP_UPLOAD_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0df0],
  [0x0e00, 0x1800],
  [0x1ee0, 0x1ef0],
  [0x1f60, 0x1f70],
  [0x1f80, 0x1f90],
  [0x1fc0, 0x1fd0],
]
