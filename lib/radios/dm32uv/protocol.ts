// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump } from '../../codec/checksum.js'
import { ProtocolError } from '../../transport/errors.js'
import { delay, type ReadOpts, type Transport } from '../../transport/transport.js'
import { LoopbackDetectedError } from '../../radio/driver.js'

/**
 * Baofeng DM-32UV serial protocol.
 *
 * Transcribed from the MIT-licensed DM32-Protocol-Spec
 * (github.com/infamy/DM32-Protocol-Spec). CHIRP has no driver for this radio,
 * so that specification plus what a real radio does are the only sources.
 *
 * Two things make this radio different from the others here. Physical addresses
 * are assigned by what behaves like a flash translation layer and move between
 * sessions, so nothing may be hardcoded - see pagemap.ts. And there is **no
 * command to leave programming mode**: the radio exits when the port closes, so
 * an interrupted session leaves it needing a power cycle.
 */

export const BAUD_RATE = 115_200

/** 4 KiB pages; the last byte of each is its logical block id. */
export const PAGE_SIZE = 0x1000
export const PAGE_TAIL = PAGE_SIZE - 1

/**
 * The largest address this radio can be asked about.
 *
 * A read command carries a 3-byte little-endian address, so nothing above this
 * is even expressible on the wire. Used to reject a reported memory range that
 * cannot be real.
 */
export const MAX_ADDRESS = 0xff_ffff

/**
 * Settling time between opening the port and the first byte.
 *
 * Not decoration. The reference implementation found ~800 ms is required in
 * practice, and without it `PSEARCH` goes unanswered. The captures cannot show
 * this - a serial log records bytes, not silence - so the value is empirical.
 */
export const OPEN_SETTLE_MS = 800
/** The radio needs a moment before its PSEARCH reply is readable. */
export const PSEARCH_READ_DELAY_MS = 150
const STEP_DELAY_MS = 50
const ACK = 0x06

const enc = (s: string) => new TextEncoder().encode(s)

export const CMD_PSEARCH = enc('PSEARCH')
export const CMD_PASSSTA = enc('PASSSTA')
export const CMD_SYSINFO = enc('SYSINFO')
/** `FF FF FF FF 0C` + "PROGRAM"; the 0x0C is undocumented. */
export const CMD_PROGRAM = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x0c, ...enc('PROGRAM')])

export interface HandshakeResult {
  /** Model string the radio reports; a DM-32UV answers "DP570UV". */
  model: string
}

/** Accepted model strings, matched as substrings the way the spec describes. */
const MODEL_MARKERS = ['DP570', 'DM32', 'DM-32']

/**
 * Recovering after a previous session needs a **new port**, not just patience.
 *
 * Measured on hardware. Opening a fresh port at increasing gaps after a close:
 *
 *   gap 0.0s -> no reply    gap 2.0s -> no reply
 *   gap 0.5s -> no reply    gap 3.0s -> 06 44 50 35 37 30 55 56, PASSSTA 50 00 00
 *   gap 1.0s -> no reply
 *
 * Retrying on the *same* open port never recovers, however long it waits -
 * tried, and it fails identically four attempts running. The specification's
 * state machine says why: the radio leaves programming mode on "close port
 * (DTR reset)", so the close is the reset, and there is no command that does
 * it. A driver holding the port open has already missed its chance.
 *
 * So this does not retry. It fails with an accurate description, and the next
 * connection - a new port, after a few seconds - succeeds.
 */
export const REOPEN_SETTLE_MS = 3200

/**
 * The radio's idle heartbeat.
 *
 * Captured from a real session: `90 fe 98 fe` arrives roughly every three
 * seconds while the radio is out of programming mode, and lands inside
 * whichever read happens to be waiting. It is why the failure moved from step
 * to step as each one was fixed - PSEARCH, then PASSSTA, then Mode 02 - and why
 * every step drains before it speaks rather than only the first.
 */
export const IDLE_HEARTBEAT = Uint8Array.from([0x90, 0xfe, 0x98, 0xfe])

export async function handshake(t: Transport, opts?: ReadOpts): Promise<HandshakeResult> {
  const signalOpt = opts?.signal ? { signal: opts.signal } : {}

  // Discard whatever the radio emitted while the port was settling. It talks on
  // its own after a port opens, and those bytes otherwise sit in the buffer
  // waiting to be mistaken for a reply: PSEARCH consumes them, every read after
  // that is one response behind, and the failure surfaces as a PASSSTA error
  // pointing at entirely the wrong command.
  await t.resync(150, { timeoutMs: 2000, ...signalOpt }).catch(() => {})

  await t.write(CMD_PSEARCH, opts)
  await delay(PSEARCH_READ_DELAY_MS, opts?.signal)

  // Read the first byte on its own, then decide.
  //
  // A real reply is ACK followed by seven ASCII bytes of model. An echoing
  // adapter sends back the seven bytes of "PSEARCH" and nothing more, so
  // waiting for eight before looking at any of them meant the echo case always
  // timed out and was reported as "the radio did not answer at all" - the
  // adapter misdiagnosis this check exists to prevent, delivered by the check
  // itself. One byte is enough to tell ACK (0x06) from 'P' (0x50).
  const head = await t.readExactly(1, opts).catch(() => null)
  if (head === null) throw notReady('the radio did not answer at all')
  if (head[0] === CMD_PSEARCH[0]) throw new LoopbackDetectedError('while identifying the radio')
  if (head[0] !== ACK) throw notReady(`it answered ${hexDump(head, 1)}`)

  const rest = await t.readExactly(7, opts).catch(() => null)
  if (rest === null) throw notReady('it acknowledged but sent no model')
  const reply = Uint8Array.from([head[0]!, ...rest])

  const model = new TextDecoder()
    .decode(reply.subarray(1, 8))
    .replace(/\0/g, '')
    .trim()
  if (!MODEL_MARKERS.some((m) => model.includes(m))) {
    throw new ProtocolError(`This is not a DM-32UV: it identifies as ${JSON.stringify(model)}`)
  }

  return finishHandshake(t, model, opts)
}

/**
 * The error for "the radio is not ready", which is nearly always the real
 * cause and is fixed by waiting a moment and connecting again.
 */
function notReady(detail: string): ProtocolError {
  return new ProtocolError(
    `The radio is not ready (${detail}). This is normal for a few seconds after a previous session: the ` +
      'DM-32UV has no command to leave programming mode, so it resets only when the port closes and needs ' +
      'about three seconds afterwards. Wait a moment and try again.',
  )
}

async function finishHandshake(t: Transport, model: string, opts?: ReadOpts): Promise<HandshakeResult> {
  const signalOpt = opts?.signal ? { signal: opts.signal } : {}

  await delay(STEP_DELAY_MS, opts?.signal)
  // Drain again before each step, not only at the start.
  //
  // This radio emits unsolicited bytes on its own schedule, and some arrive
  // *after* the initial settle and after PSEARCH has been answered correctly.
  // They then land in the next command's read, which is why the failure looked
  // like `PASSSTA failed: received 90 fe 98` while PSEARCH was working
  // perfectly. Starting each step from a quiet line costs a few hundred
  // milliseconds once per session and removes the whole class of problem.
  await t.resync(120, { timeoutMs: 1500, ...signalOpt }).catch(() => {})
  await t.write(CMD_PASSSTA, opts)
  await delay(STEP_DELAY_MS, opts?.signal)
  const status = await t.readExactly(3, opts).catch(() => null)
  if (status === null || status[0] !== 0x50) {
    // Seen on hardware: the radio answers PSEARCH correctly and then replies
    // to PASSSTA with noise. Naming PASSSTA here sends people to the wrong
    // step; the cause is the same not-ready state.
    throw notReady(`it answered PSEARCH but not PASSSTA${status ? ` (${hexDump(status)})` : ''}`)
  }

  await delay(STEP_DELAY_MS, opts?.signal)
  await t.resync(120, { timeoutMs: 1500, ...signalOpt }).catch(() => {})
  await t.write(CMD_SYSINFO, opts)
  await delay(STEP_DELAY_MS, opts?.signal)
  const sys = await t.readExactly(1, opts).catch(() => null)
  if (sys === null || sys[0] !== ACK) {
    throw notReady(`it did not acknowledge SYSINFO${sys ? ` (${hexDump(sys)})` : ''}`)
  }
  await delay(10, opts?.signal)

  return { model }
}

/**
 * Query a V-frame: `56 00 00 <hint> <id>` in, `56 <id> <len> <payload>` back.
 *
 * Byte 3 is a requested-length hint. It is zero for everything except frame
 * 0x0D, which returns nothing unless asked for 0x40 bytes.
 */
export async function vframe(t: Transport, id: number, hint = 0x00, opts?: ReadOpts): Promise<Uint8Array> {
  /*
   * Drain first, like every other step that speaks to this radio.
   *
   * The handshake drains around its own steps, so the five V-frames read
   * immediately after it were always safe. The startup-image range is not read
   * then - it is read when someone presses the button, which can be minutes
   * later, by which time the radio has emitted several `90 fe 98 fe`
   * heartbeats. `readExactly(3)` then returns `90 fe 98` and the frame is
   * rejected for a bad header, which is exactly what it looks like from the
   * outside: reading and writing the picture both fail on a radio that is
   * working perfectly.
   */
  await t.resync(120, { timeoutMs: 1500, ...(opts?.signal ? { signal: opts.signal } : {}) }).catch(() => {})
  await t.write(Uint8Array.from([0x56, 0x00, 0x00, hint, id]), opts)
  await delay(STEP_DELAY_MS, opts?.signal)
  const header = await t.readExactly(3, opts)
  if (header[0] !== 0x56) {
    throw new ProtocolError(`Bad V-frame 0x${id.toString(16)} header`, '56 ..', hexDump(header))
  }
  const length = header[2]!
  return length === 0 ? new Uint8Array(0) : t.readExactly(length, opts)
}

/** Two little-endian uint32s: an inclusive address range. */
/**
 * A range the radio may legitimately report as absent.
 *
 * The contacts region is optional: a radio with the feature turned off answers
 * `start == 0 && end == 0`, which {@link parseRange} correctly rejects as
 * inverted. Rejecting it is right for the configuration region - a radio that
 * cannot say where its codeplug lives is broken - and wrong for this one, where
 * "there is no such region" is a real answer.
 */
export function parseOptionalRange(payload: Uint8Array): { start: number; end: number } | null {
  if (payload.length < 8) return null
  const rd = (o: number) => payload[o]! | (payload[o + 1]! << 8) | (payload[o + 2]! << 16) | payload[o + 3]! * 0x1000000
  if (rd(0) === 0 && rd(4) === 0) return null
  return parseRange(payload)
}

/**
 * An integer of however many bytes the radio actually sent.
 *
 * The maximum-contacts frame answers with three bytes on this firmware
 * (`50 c3 00` = 50,000). The reference implementation requires four, fails, and
 * falls back to a hardcoded 50,000 that happens to be right here - which is the
 * kind of luck that stops working on the next firmware.
 */
export function parseLE(payload: Uint8Array): number {
  let out = 0
  for (let i = 0; i < payload.length; i++) out += payload[i]! * 2 ** (8 * i)
  return out
}

export function parseRange(payload: Uint8Array): { start: number; end: number } {
  if (payload.length < 8) throw new ProtocolError('V-frame range payload is too short', '8 bytes', hexDump(payload))
  const rd = (o: number) => payload[o]! | (payload[o + 1]! << 8) | (payload[o + 2]! << 16) | payload[o + 3]! * 0x1000000
  const start = rd(0)
  const end = rd(4)

  // Sanity-check the range rather than trusting it.
  //
  // These four bytes decide how much of the radio a backup covers. A frame that
  // arrives shifted by an idle heartbeat, or answered by a radio in the wrong
  // state, parses perfectly well into a range that is inverted or absurd - and
  // the read that follows then produces an image with no regions at all. That
  // empty image is still a well-formed backup as far as everything downstream
  // is concerned, which is how a "backup" that contains nothing could come to
  // satisfy the requirement to have one before writing.
  if (end <= start) {
    throw new ProtocolError(
      'the radio reported a memory range that ends before it starts',
      'end > start',
      `start 0x${start.toString(16)}, end 0x${end.toString(16)}`,
    )
  }
  if (end - start < PAGE_SIZE) {
    throw new ProtocolError(
      'the radio reported a memory range smaller than one page',
      `at least ${PAGE_SIZE} bytes`,
      `${end - start} bytes`,
    )
  }
  if (end > MAX_ADDRESS) {
    throw new ProtocolError(
      'the radio reported a memory range past the end of its address space',
      `at most 0x${MAX_ADDRESS.toString(16)}`,
      `0x${end.toString(16)}`,
    )
  }

  return { start, end }
}

export const VFRAME_FIRMWARE = 0x01
export const VFRAME_BUILD_DATE = 0x03
/** The main configuration region. Missing or short means the layout is unknown. */
export const VFRAME_CONFIG_RANGE = 0x0a
export const VFRAME_CONTACTS_RANGE = 0x0f
export const VFRAME_MAX_CONTACTS = 0x10

/**
 * Enter programming mode.
 *
 * Three steps, all of which must succeed. There is deliberately no matching
 * exit: the radio leaves programming mode when the port closes, which is why
 * this driver's abort policy is a power cycle.
 */
export async function enterProgrammingMode(t: Transport, opts?: ReadOpts): Promise<void> {
  const signalOpt = opts?.signal ? { signal: opts.signal } : {}
  const quiet = () => t.resync(120, { timeoutMs: 1500, ...signalOpt }).catch(() => {})

  await quiet()
  await t.write(CMD_PROGRAM, opts)
  await delay(STEP_DELAY_MS, opts?.signal)
  const a = await t.readExactly(1, opts)
  if (a[0] !== ACK) throw new ProtocolError('The radio refused PROGRAM', '06', hexDump(a))

  // Deliberately no drain from here on. The three steps are time-sensitive -
  // the specification puts 10 ms between them - and draining first cost about
  // two seconds, after which the radio had left the window and answered
  // nothing at all. The drain before PROGRAM is the last safe moment.
  await delay(10, opts?.signal)
  await t.write(Uint8Array.from([0x02]), opts)
  await delay(STEP_DELAY_MS, opts?.signal)
  const b = await t.readExactly(8, opts)
  if (!b.every((x) => x === 0xff)) {
    throw new ProtocolError('Mode 02 failed', 'eight 0xFF bytes', hexDump(b))
  }

  await delay(10, opts?.signal)
  await t.write(Uint8Array.from([ACK]), opts)
  await delay(STEP_DELAY_MS, opts?.signal)
  const c = await t.readExactly(1, opts)
  if (c[0] !== ACK) throw new ProtocolError('The final programming-mode ACK failed', '06', hexDump(c))
  await delay(10, opts?.signal)
}

/**
 * Read memory: `52 <addr:3 LE> <len:2 LE>` out, `57 <addr> <len> <data>` back.
 *
 * Addresses are 24-bit little-endian, so 0x001000 goes on the wire as
 * `00 10 00`. There is no host-side acknowledgement in the read path.
 */
export async function readMemory(t: Transport, addr: number, length: number, opts?: ReadOpts): Promise<Uint8Array> {
  const cmd = Uint8Array.from([
    0x52,
    addr & 0xff,
    (addr >> 8) & 0xff,
    (addr >> 16) & 0xff,
    length & 0xff,
    (length >> 8) & 0xff,
  ])
  await t.write(cmd, opts)

  const header = await t.readExactly(6, opts)
  if (header[0] !== 0x57) {
    throw new ProtocolError(
      `Bad read header at 0x${addr.toString(16).padStart(6, '0')}`,
      '57 ...',
      hexDump(header),
    )
  }
  const got = header[4]! | (header[5]! << 8)
  if (got === 0 || got > length) {
    throw new ProtocolError(
      `The radio reported an impossible length at 0x${addr.toString(16).padStart(6, '0')}`,
      `1..${length}`,
      String(got),
    )
  }
  return t.readExactly(got, opts)
}

/**
 * Write one 4 KiB page.
 *
 * `57 <addr:3 LE> <len:2 LE> <4096 bytes>` - 4102 bytes on the wire - answered
 * with a single `0x06`. The payload's last byte is the logical block id, the
 * same byte a 1-byte probe reads at `base + 0xFFF`; it is part of the data, not
 * a trailer.
 */
/**
 * How long to wait for a write acknowledgement.
 *
 * The specification allows 5000 ms, and the wait is a flash page programming
 * rather than a round trip. Giving up early would close the port mid-program,
 * which on this radio is also the only thing that resets it.
 */
export const WRITE_ACK_TIMEOUT_MS = 5000

export async function writePage(t: Transport, base: number, data: Uint8Array, opts?: ReadOpts): Promise<void> {
  if (data.length !== PAGE_SIZE) {
    throw new ProtocolError(`A page write must be exactly ${PAGE_SIZE} bytes, not ${data.length}`)
  }
  const frame = new Uint8Array(6 + PAGE_SIZE)
  frame[0] = 0x57
  frame[1] = base & 0xff
  frame[2] = (base >> 8) & 0xff
  frame[3] = (base >> 16) & 0xff
  frame[4] = PAGE_SIZE & 0xff
  frame[5] = (PAGE_SIZE >> 8) & 0xff
  frame.set(data, 6)

  await t.write(frame, opts)
  const ack = await t.readExactly(1, { ...opts, timeoutMs: Math.max(opts?.timeoutMs ?? 0, WRITE_ACK_TIMEOUT_MS) })
  if (ack[0] !== ACK) {
    throw new ProtocolError(
      `The radio refused the write at 0x${base.toString(16).padStart(6, '0')}`,
      '06',
      hexDump(ack),
    )
  }
}

/**
 * A 4 KiB page from a region that carries no logical block id.
 *
 * {@link readPage} checks the last byte against the id it expects, which is the
 * right thing everywhere in the configuration region and the wrong thing in the
 * DMR address book, where that byte is ordinary data.
 */
export async function readRawPage(t: Transport, base: number, opts?: ReadOpts): Promise<Uint8Array> {
  const data = await readMemory(t, base, PAGE_SIZE, opts)
  if (data.length !== PAGE_SIZE) {
    throw new ProtocolError(`Short page at 0x${base.toString(16)}`, `${PAGE_SIZE} bytes`, `${data.length}`)
  }
  return data
}

/** Read one 4 KiB page and confirm its tail byte is the id we expected. */
export async function readPage(t: Transport, base: number, expectedId: number, opts?: ReadOpts): Promise<Uint8Array> {
  const data = await readMemory(t, base, PAGE_SIZE, opts)
  if (data.length !== PAGE_SIZE) {
    throw new ProtocolError(`Short page at 0x${base.toString(16)}`, `${PAGE_SIZE} bytes`, `${data.length}`)
  }
  if (data[PAGE_TAIL] !== expectedId) {
    // The translation layer moved this page mid-session. Continuing would
    // assemble a codeplug out of correctly-formed pieces from the wrong places.
    throw new ProtocolError(
      `The page at 0x${base.toString(16)} is no longer block 0x${expectedId.toString(16)}`,
      `tail byte ${expectedId.toString(16)}`,
      `tail byte ${data[PAGE_TAIL]!.toString(16)}`,
    )
  }
  return data
}
