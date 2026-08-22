// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump } from '../../codec/checksum.js'
import { BOOT_IMAGE_BYTES } from '../../io/boot-image.js'
import { ProtocolError } from '../../transport/errors.js'
import type { ReadOpts, Transport } from '../../transport/transport.js'
import { PAGE_SIZE, WRITE_ACK_TIMEOUT_MS, parseRange, readMemory, vframe, writePage } from './protocol.js'

/**
 * Where the DM-32UV keeps its startup image.
 *
 * The region is `0x150000-0x175FFF`, reported by V-frame 0x0E, and it holds
 * 153,600 bytes of raw RGB565 - see `io/boot-image.ts` for the pixels, and for why
 * the specification calling it BGR565 is wrong.
 * Transcribed from the MIT-licensed DM32-Protocol-Spec (`04-MEMORY-LAYOUT.md`
 * for the region, `03-COMMANDS.md` §5.1 and §5.4 for the writes).
 *
 * **This region is outside the codeplug, so it is outside every backup
 * boofwang has ever taken.** A codeplug read covers `0x001000-0x0C8FFF`; this
 * is an order of magnitude further up, no stored `.bwp` contains it, and no
 * fixture in `test/fixtures/images/` does either. A codeplug can be rebuilt
 * from a CSV if the worst happens. The factory splash can be rebuilt from
 * nothing at all, so it has to be read before it is ever written over.
 *
 * **Nothing in the application reaches any of this, and that is deliberate.**
 * No DM-32UV has been connected since it was written, the 2,048-byte tail write
 * is `DERIVED` in the specification rather than captured, and the ordering rule
 * above has no home to live in yet. `test/lib/radios/dm32uv/boot-image.spec.ts`
 * asserts that no file under `lib/` or `app/` imports this module; when the
 * feature is wired up, that test is the thing to read first.
 */

/** V-frame 0x0E: the memory range the startup image occupies. */
export const VFRAME_BOOT_IMAGE_RANGE = 0x0e

/**
 * What V-frame 0x0E answered on the captured radio, for cross-checking only.
 *
 * The range is CONFIRMED by the capture, and physical addresses on this radio
 * still move underneath you, so the address a transfer uses comes from the
 * radio in front of us. These constants exist so a test and a bug report can
 * say what "the usual answer" is.
 */
export const BOOT_IMAGE_REGION_START = 0x15_0000
export const BOOT_IMAGE_REGION_END = 0x17_5fff

/**
 * 37 full pages and a 2,048-byte remainder.
 *
 * 153,600 is not a multiple of 4,096, which is the one unusual thing about this
 * region: every other transfer this radio does is a whole page. The region
 * itself is 155,648 bytes - a round 38 pages - so the last 2,048 bytes of it,
 * from `0x175800`, are past the end of the picture. Nothing here reads or
 * writes them; what they hold is unknown and none of our business.
 */
export const BOOT_IMAGE_FULL_PAGES = Math.floor(BOOT_IMAGE_BYTES / PAGE_SIZE)
export const BOOT_IMAGE_TAIL_BYTES = BOOT_IMAGE_BYTES % PAGE_SIZE

export interface BootImageChunk {
  /** Absolute address on the radio. */
  readonly address: number
  /** Where this chunk starts within the 153,600-byte image. */
  readonly offset: number
  readonly length: number
}

export type BootImageOpts = ReadOpts & { progress?: (done: number, total: number) => void }

/**
 * The transfer plan, which is the same going out as coming back.
 *
 * Separated from the I/O so that the arithmetic - 37 pages then a short chunk,
 * contiguous, covering the payload exactly once - is checkable without a radio
 * or a fake one.
 */
export function bootImageChunks(start: number): BootImageChunk[] {
  const chunks: BootImageChunk[] = []
  for (let i = 0; i < BOOT_IMAGE_FULL_PAGES; i++) {
    const offset = i * PAGE_SIZE
    chunks.push({ address: start + offset, offset, length: PAGE_SIZE })
  }
  if (BOOT_IMAGE_TAIL_BYTES > 0) {
    const offset = BOOT_IMAGE_FULL_PAGES * PAGE_SIZE
    chunks.push({ address: start + offset, offset, length: BOOT_IMAGE_TAIL_BYTES })
  }
  return chunks
}

/**
 * The range from V-frame 0x0E, checked against what a picture needs.
 *
 * The reference implementation takes only the first four bytes and treats them
 * as a base address. Parsing both ends costs nothing and buys the one check
 * worth having: a radio whose startup-image region is smaller than the image is
 * not a radio to start writing pages to.
 */
export function parseBootImageRange(payload: Uint8Array): { start: number; end: number } {
  const range = parseRange(payload)
  const size = range.end - range.start + 1
  if (size < BOOT_IMAGE_BYTES) {
    throw new ProtocolError(
      'the radio reported a startup-image region too small to hold one',
      `at least ${BOOT_IMAGE_BYTES} bytes`,
      `${size} bytes`,
    )
  }
  return range
}

/**
 * Ask the radio where its startup image lives.
 *
 * V-frames are only safe to send during identification, before programming mode
 * - the driver learns the configuration and address-book ranges there for the
 * same reason - so a caller wiring this up wants the answer carried forward in
 * `IdentifyResult.meta`, not fetched at transfer time.
 */
export async function queryBootImageRange(t: Transport, opts?: ReadOpts): Promise<{ start: number; end: number }> {
  return parseBootImageRange(await vframe(t, VFRAME_BOOT_IMAGE_RANGE, 0x00, opts))
}

/**
 * Read the whole startup image: 38 transfers, 153,600 bytes.
 *
 * Requires programming mode, like every other transfer on this radio. The tail
 * needs no new primitive - {@link readMemory} already carries a 16-bit length,
 * and 2,048 is an ordinary value for it; the specification lists that exact
 * length as one the reference implementation issues.
 *
 * No delay between chunks. The specification suggests 150 ms between 4 KiB
 * reads; the hardware session that settled the codeplug read used none.
 */
export async function readBootImage(t: Transport, start: number, opts?: BootImageOpts): Promise<Uint8Array> {
  const chunks = bootImageChunks(start)
  const out = new Uint8Array(BOOT_IMAGE_BYTES)

  for (const [i, chunk] of chunks.entries()) {
    opts?.signal?.throwIfAborted()
    const data = await readMemory(t, chunk.address, chunk.length, opts)
    if (data.length !== chunk.length) {
      throw new ProtocolError(
        `Short startup-image read at 0x${chunk.address.toString(16)}`,
        `${chunk.length} bytes`,
        `${data.length} bytes`,
      )
    }
    out.set(data, chunk.offset)
    opts?.progress?.(i + 1, chunks.length)
  }

  return out
}

/**
 * The 2,048-byte write.
 *
 * **DERIVED, AND UNVERIFIED AGAINST HARDWARE.** `03-COMMANDS.md` §5.4
 * describes the ordinary `0x57` write with a length of `00 08` instead of
 * `00 10`, and marks it `DERIVED`: it is what the reference implementation
 * sends, and it appears in **neither** hardware capture. Everything about it is
 * an inference from the fact that bytes 4-5 of a write are a plain 16-bit
 * little-endian length in every frame that *was* captured.
 *
 * If it turns out the radio wants something else for a short chunk - a padded
 * full page, a different opcode, an erase first - this is the function that is
 * wrong, and it is the only one. Nothing calls it but its test.
 */
export async function writeBootImageTail(
  t: Transport,
  address: number,
  data: Uint8Array,
  opts?: ReadOpts,
): Promise<void> {
  if (data.length !== BOOT_IMAGE_TAIL_BYTES) {
    throw new ProtocolError(`A startup-image tail write is ${BOOT_IMAGE_TAIL_BYTES} bytes, not ${data.length}`)
  }
  const frame = new Uint8Array(6 + data.length)
  frame[0] = 0x57
  frame[1] = address & 0xff
  frame[2] = (address >> 8) & 0xff
  frame[3] = (address >> 16) & 0xff
  frame[4] = data.length & 0xff
  frame[5] = (data.length >> 8) & 0xff
  frame.set(data, 6)

  await t.write(frame, opts)
  const ack = await t.readExactly(1, { ...opts, timeoutMs: Math.max(opts?.timeoutMs ?? 0, WRITE_ACK_TIMEOUT_MS) })
  if (ack[0] !== 0x06) {
    throw new ProtocolError(
      `The radio refused the startup-image tail write at 0x${address.toString(16).padStart(6, '0')}`,
      '06',
      hexDump(ack),
    )
  }
}

/** The whole region, which is exactly 38 pages: 155,648 = 38 x 4,096. */
export const BOOT_IMAGE_REGION_BYTES = BOOT_IMAGE_REGION_END - BOOT_IMAGE_REGION_START + 1
export const BOOT_IMAGE_REGION_PAGES = BOOT_IMAGE_REGION_BYTES / PAGE_SIZE

/**
 * Refuse a write whose address is not this radio's startup-image region.
 *
 * `bootImageChunks` extrapolates 153,600 bytes from a bare `start` with no end
 * to check against, so a wrong base does not fail - it relocates the whole
 * write. `undefined` becomes 0 through the byte masking and sends the picture
 * to the bottom of memory; a digit dropped from 0x150000 lands it inside the
 * configuration region, over the codeplug and its page ids. Every frame would
 * be acknowledged, because this radio has no checksum in either direction and
 * a write is judged solely by a one-byte reply.
 */
function assertInRegion(start: number, length: number, range: { start: number; end: number }): void {
  if (!Number.isInteger(start)) {
    throw new ProtocolError(`A startup-image write needs a real address, not ${String(start)}`)
  }
  if (start % PAGE_SIZE !== 0) {
    throw new ProtocolError(`0x${start.toString(16)} is not on a 4 KiB boundary`)
  }
  if (start !== range.start) {
    throw new ProtocolError(
      `A startup-image write must start at the region the radio reported ` +
        `(0x${range.start.toString(16)}), not 0x${start.toString(16)}`,
    )
  }
  if (start + length - 1 > range.end) {
    throw new ProtocolError(
      `${length} bytes from 0x${start.toString(16)} runs past the region end 0x${range.end.toString(16)}`,
    )
  }
}

/**
 * Write the whole startup-image region, then read it back and compare.
 *
 * Prefer this to {@link writeBootImage}. The region the radio reports is
 * 155,648 bytes, which is exactly 38 pages of 4,096 - so the entire thing goes
 * out through `writePage`, the only write form this radio is *confirmed* to
 * accept, and the derived 2,048-byte frame is not needed at all.
 *
 * That is not a stylistic preference. The picture is 153,600 bytes and ends at
 * 0x175800, halfway through the last sector. Sending 2,048 bytes to 0x175000
 * fills the first half of that sector, and this flash has no separate erase
 * command - the erase happens inside the 0x57 handler - so unless the firmware
 * does a read-modify-write for a short payload, the other half comes back
 * erased. On this radio those 2,048 bytes read as 0xFF and hold nothing, but
 * that was not knowable before reading them, and it would not have been
 * knowable afterwards either: having never read them, you could not tell
 * erased-by-you from erased-at-the-factory.
 *
 * Passing the full region sidesteps the question. The caller supplies all
 * 155,648 bytes, including whatever sits past the picture, and every frame is
 * a confirmed one.
 *
 * The read-back is not optional. A write here is judged by a single 0x06 and
 * there is no checksum in either direction, so an acknowledged frame that
 * programmed nothing, or programmed somewhere else, looks exactly like success.
 */
export async function writeBootImageRegion(
  t: Transport,
  range: { start: number; end: number },
  region: Uint8Array,
  opts?: BootImageOpts,
): Promise<void> {
  const expected = range.end - range.start + 1
  if (region.length !== expected) {
    throw new ProtocolError(
      `This radio's startup-image region is ${expected} bytes; got ${region.length}`,
    )
  }
  if (expected % PAGE_SIZE !== 0) {
    throw new ProtocolError(
      `This radio reports a ${expected}-byte region, which is not a whole number of 4 KiB pages. ` +
        'Writing it would need the derived short-frame form, which no capture contains.',
    )
  }
  assertInRegion(range.start, region.length, range)

  const pages = expected / PAGE_SIZE
  for (let i = 0; i < pages; i++) {
    opts?.signal?.throwIfAborted()
    const off = i * PAGE_SIZE
    await writePage(t, range.start + off, region.subarray(off, off + PAGE_SIZE), opts)
    opts?.progress?.(i + 1, pages * 2)
  }

  // Read it back. The radio told us 38 times that it was happy; this is what
  // finds out whether it was.
  for (let i = 0; i < pages; i++) {
    opts?.signal?.throwIfAborted()
    const off = i * PAGE_SIZE
    const got = await readMemory(t, range.start + off, PAGE_SIZE, opts)
    const want = region.subarray(off, off + PAGE_SIZE)
    if (got.length !== PAGE_SIZE || !got.every((b, j) => b === want[j])) {
      const at = [...got].findIndex((b, j) => b !== want[j])
      throw new ProtocolError(
        `The startup image read back wrong at 0x${(range.start + off + Math.max(at, 0)).toString(16)}`,
        hexDump(want.subarray(Math.max(at, 0), Math.max(at, 0) + 8), 8),
        hexDump(got.subarray(Math.max(at, 0), Math.max(at, 0) + 8), 8),
      )
    }
    opts?.progress?.(pages + i + 1, pages * 2)
  }
}

/**
 * Write a whole startup image.
 *
 * **Read the existing image first and keep it.** This overwrites the factory
 * splash, and nothing else anywhere holds a copy: not a `.bwp`, not a stored
 * backup, not a fixture. There is no restore without a prior
 * {@link readBootImage}, and the caller is the only thing that can enforce
 * that, which is one of the reasons nothing calls this yet.
 *
 * 37 pages through the ordinary write, then the derived tail form. Prefer
 * {@link writeBootImageRegion}, which needs no derived frame at all: the region
 * is a whole number of pages even though the picture is not.
 *
 * No delay between chunks, matching the codeplug writer, which does the same
 * and is verified on hardware. The specification's 150 ms is described there as
 * conservative rather than required, and it notes the reference implementation
 * writes one of its own paths back to back with no gap at all.
 */
export async function writeBootImage(
  t: Transport,
  start: number,
  image: Uint8Array,
  opts?: BootImageOpts,
): Promise<void> {
  if (image.length !== BOOT_IMAGE_BYTES) {
    throw new ProtocolError(`A startup image is ${BOOT_IMAGE_BYTES} bytes, not ${image.length}`)
  }
  const chunks = bootImageChunks(start)

  for (const [i, chunk] of chunks.entries()) {
    opts?.signal?.throwIfAborted()
    const data = image.subarray(chunk.offset, chunk.offset + chunk.length)
    if (chunk.length === PAGE_SIZE) await writePage(t, chunk.address, data, opts)
    else await writeBootImageTail(t, chunk.address, data, opts)
    opts?.progress?.(i + 1, chunks.length)
  }
}
