// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump, sha256Hex } from '../../codec/checksum.js'
import { equalBytes } from '../../codec/struct.js'
import { emptyCodeplug, type Channel, type Codeplug, type TxSpec } from '../../model/index.js'
import { txFrequency } from '../../model/channel.js'
import { CTCSS_DECIHZ, ctcss, dtcs, NO_TONE, type TonePair, type ToneSpec } from '../../model/tones.js'
import { hz } from '../../model/units.js'
import {
  BackupRequiredError,
  DEFAULT_DRIVER_TIMEOUT_MS,
  DriverError,
  WriteBlockedError,
  WriteVerifyError,
  type WriteOperation,
  type Diagnostic,
  type DriverCtx,
  type IdentifyResult,
  type RadioDriver,
  type WriteReport,
} from '../../radio/driver.js'
import type { RadioImage } from '../../radio/image.js'
import type { RadioSchema } from '../../radio/schema.js'
import { locate } from '../../radio/image.js'
import type { Transport } from '../../transport/transport.js'
import {
  BANDWIDTH_NARROW_HZ,
  BANDWIDTH_WIDE_HZ,
  BASETYPE_UV82,
  BASETYPE_UV82HP,
  CHANNEL_BASE,
  CHANNEL_COUNT,
  POWER_LOW,
  TONE_CTCSS_FLOOR,
  TONE_DTCS_INVERTED,
  UV82_CHANNEL,
  UV82_DTCS,
  UV82_NAME,
  channelAddr,
  nameAddr,
  NAME_LENGTH,
  ownedRanges as uv82OwnedRanges,
  REGIONS,
} from './layout.js'
import {
  AUX_END,
  AUX_START,
  BLOCK_SIZE,
  IDENT_SIZE,
  IMAGE_SIZE,
  MAGIC_UV82,
  MAIN_SIZE,
  NEVER_WRITE,
  WRITE_BLOCK_SIZE,
  identify as doIdentify,
  readBlock,
  readFirmware,
  writeBlock,
} from './protocol.js'
import { UV82_SCHEMA, UV82_SERIAL } from './schema.js'

/**
 * Decode one of the family's `ul16` tone words.
 *
 * The encoding overloads a single number: zero and all-ones mean no tone, a
 * value at or above 0x0258 is CTCSS in tenths of a hertz, and anything below is
 * a one-based index into the DTCS table, offset by 0x6A for inverted codes.
 */
export function decodeToneWord(word: number): ToneSpec | null {
  if (word === 0 || word === 0xffff) return null
  if (word >= TONE_CTCSS_FLOOR) return ctcss(word)
  const inverted = word >= TONE_DTCS_INVERTED
  const index = inverted ? word - TONE_DTCS_INVERTED : word - 1
  const code = UV82_DTCS[index]
  return code === undefined ? null : dtcs(code, inverted ? 'R' : 'N')
}

export function encodeToneWord(t: ToneSpec | null, where: string): number {
  if (t === null) return 0
  if (t.kind === 'ctcss') {
    if (!CTCSS_DECIHZ.includes(t.deciHz)) {
      throw new DriverError(`${where}: ${(t.deciHz / 10).toFixed(1)} Hz is not a CTCSS tone this radio supports.`)
    }
    return t.deciHz
  }
  const index = UV82_DTCS.indexOf(t.code)
  if (index < 0) {
    throw new DriverError(`${where}: DTCS code ${String(t.code).padStart(3, '0')} is not one this radio supports.`)
  }
  return t.polarity === 'R' ? index + TONE_DTCS_INVERTED : index + 1
}

/** Whether a firmware version string belongs to a plain or tri-power UV-82. */
export function classifyBasetype(version: string): { model: string; triPower: boolean } | null {
  if (BASETYPE_UV82HP.some((p) => version.startsWith(p))) return { model: 'UV-82HP', triPower: true }
  if (BASETYPE_UV82.some((p) => version.startsWith(p))) return { model: 'UV-82', triPower: false }
  return null
}

export interface Uv82Options {
  /**
   * Whether this build may write.
   *
   * Off by default and turned on in the registry, so that a driver built for a
   * test or a file import cannot reach a radio at all.
   */
  enableWrite?: boolean
}

export function createUv82Driver(options: Uv82Options = {}): RadioDriver {
  const schema: RadioSchema = options.enableWrite
    ? { ...UV82_SCHEMA, status: 'beta', capabilities: { ...UV82_SCHEMA.capabilities, write: true } }
    : UV82_SCHEMA

  const driver: RadioDriver = {
    id: 'uv82',
    schema,
    serial: { ...UV82_SERIAL, signals: { ...UV82_SERIAL.signals } },
    // No reset command exists in this protocol; the radio leaves clone mode
    // when the port closes, and the UI says so.
    abortPolicy: 'power-cycle',
    writeBlockBytes: BLOCK_SIZE,

    /**
     * Nothing on this radio distinguishes one unit from another.
     *
     * Its calibration is not exposed as a separate readable region, and the
     * identify reply carries only firmware. Null means "cannot tell", which
     * callers must not read as a match.
     */
    async unitFingerprint(): Promise<string | null> {
      return null
    },

    match(info) {
      const KNOWN_BRIDGES = [0x1a86, 0x067b, 0x10c4, 0x0403]
      return info.usbVendorId !== undefined && KNOWN_BRIDGES.includes(info.usbVendorId) ? 'possible' : 'no'
    },

    async identify(t: Transport, ctx: DriverCtx = {}): Promise<IdentifyResult> {
      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      ctx.progress?.({ phase: 'handshake', done: 0, total: 1, label: 'Saying hello' })
      const { ident, raw } = await doIdentify(t, MAGIC_UV82, opts)
      const fw = await readFirmware(t, opts)
      const basetype = classifyBasetype(fw.version)

      ctx.log?.info(`UV-82 ident ${[...ident].map((b) => b.toString(16)).join(' ')}, firmware ${fw.version}`)
      ctx.progress?.({ phase: 'handshake', done: 1, total: 1, label: fw.version })

      // The ident block differs between units, so it already identifies this
      // radio rather than merely its model - no separate fingerprint read is
      // needed the way the UV-K5 needs one.
      return {
        radioId: 'uv82',
        variant: fw.version,
        layout: basetype?.triPower ? 'uv82hp' : 'uv82',
        raw,
        caps: {
          read: true,
          /*
           * Writable only on a plain UV-82, and only on a firmware whose layout
           * is recognised.
           *
           * The HP is excluded deliberately. It shares this radio's magic and
           * this driver identifies it, but it has three power levels where the
           * plain UV-82 has two, indexed by the same two-bit field. This build
           * models two, so a Low channel on an HP would decode as High and be
           * written back at 8 W - promoting a channel the user never touched.
           * Reading and backing one up is unaffected.
           */
          write: schema.capabilities.write && basetype !== null && !basetype.triPower,
          ...(basetype === null
            ? {
                reason:
                  `Firmware ${JSON.stringify(fw.version)} is not one this build recognises, so its memory ` +
                  'layout cannot be assumed. The radio can still be read and backed up.',
              }
            : basetype.triPower
            ? {
                reason:
                  `The ${basetype.model} has three power levels and this build models two, so writing could ` +
                  'change the power on channels you did not touch. It can still be read and backed up.',
              }
            : {}),
        },
        identHash: await sha256Hex(Uint8Array.from([...ident, ...new TextEncoder().encode(fw.version)])),
        meta: { droppedByte: fw.droppedByte, basetype: basetype?.model ?? null },
      }
    },

    async readImage(t: Transport, ident: IdentifyResult, ctx: DriverCtx = {}): Promise<RadioImage> {
      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      const image = new Uint8Array(IMAGE_SIZE)
      image.set(ident.raw.subarray(0, IDENT_SIZE), 0)

      let done = 0
      const total = MAIN_SIZE + (AUX_END - AUX_START)

      for (let addr = 0; addr < MAIN_SIZE; addr += BLOCK_SIZE) {
        ctx.signal?.throwIfAborted()
        image.set(await readBlock(t, addr, BLOCK_SIZE, false, opts), IDENT_SIZE + addr)
        done += BLOCK_SIZE
        ctx.progress?.({ phase: 'read', done, total, label: `0x${addr.toString(16).padStart(4, '0')}` })
      }

      // Some units drop the byte at 0x1FCF when the tail of the aux area is
      // read in 0x40 blocks, silently shifting everything after it. Where that
      // is detected the last stretch is read in 0x10 blocks instead.
      const droppedByte = ident.meta?.droppedByte === true
      const tailStart = droppedByte ? 0x1fc0 : AUX_END
      for (let addr = AUX_START; addr < tailStart; addr += BLOCK_SIZE) {
        ctx.signal?.throwIfAborted()
        image.set(await readBlock(t, addr, BLOCK_SIZE, false, opts), IDENT_SIZE + MAIN_SIZE + (addr - AUX_START))
        done += BLOCK_SIZE
        ctx.progress?.({ phase: 'read', done, total, label: `0x${addr.toString(16).padStart(4, '0')}` })
      }
      for (let addr = tailStart; addr < AUX_END; addr += 0x10) {
        ctx.signal?.throwIfAborted()
        image.set(await readBlock(t, addr, 0x10, false, opts), IDENT_SIZE + MAIN_SIZE + (addr - AUX_START))
        done += 0x10
        ctx.progress?.({ phase: 'read', done, total, label: `0x${addr.toString(16).padStart(4, '0')}` })
      }

      return {
        radioId: 'uv82',
        variant: ident.variant,
        layout: ident.layout,
        createdAt: new Date().toISOString(),
        regions: REGIONS.map((r) => ({
          start: r.start,
          data: image.slice(r.start, r.start + r.length),
          readOnly: r.readOnly,
          label: r.label,
        })),
        meta: { firmware: ident.variant, ident: [...ident.raw.subarray(0, IDENT_SIZE)] },
        sha256: await sha256Hex(image),
      }
    },

    async writeImage(t: Transport, image: RadioImage, ctx: DriverCtx = {}): Promise<WriteReport> {
      if (image.radioId !== 'uv82') throw new DriverError(`Not a UV-82 image: ${image.radioId}`)
      if (!schema.capabilities.write && !ctx.dryRun) throw new WriteBlockedError('the UV-82')
      if (!ctx.dryRun && !ctx.backup) throw new BackupRequiredError('uv82')

      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      const next = locate(image, 0)?.region.data
      if (!next) throw new DriverError('This image has no memory region')

      // Re-identify unless the session already did. Unlike the DM-32UV this
      // radio answers a second handshake happily, but repeating it costs a
      // second and tells us nothing new.
      const ident = ctx.ident ?? (await driver.identify(t, ctx))
      if (ctx.backup && ctx.backup.identHash !== ident.identHash) throw new BackupRequiredError('uv82')
      if (!ctx.dryRun && !ident.caps.write) {
        throw new WriteBlockedError(ident.caps.reason ?? `firmware ${ident.variant}`)
      }

      /*
       * The base is what the radio held when it was read.
       *
       * Only blocks that differ from it are sent. That is what keeps a
       * one-channel edit to a handful of frames instead of rewriting six
       * kilobytes, and it is also what keeps the write inside the ranges this
       * driver understands - a block with no change in it is never a candidate,
       * so the parts of memory nobody has modelled are never touched.
       */
      /*
       * What to diff against.
       *
       * An ordinary write supplies the image the radio was read from, so only
       * edited blocks are sent. A restore does not - it deliberately expects the
       * radio to differ from the image being restored, which is the whole point
       * of restoring. There the radio itself is read first and used as the base,
       * so a restore still sends only what actually differs rather than
       * rewriting six kilobytes, and there is still a way back from a bad write.
       */
      let base = ctx.baseImage ? locate(ctx.baseImage, 0)?.region.data : undefined
      if (!base) {
        const live = new Uint8Array(next.length)
        live.set(next.subarray(0, IDENT_SIZE), 0)
        for (let addr = 0; addr < MAIN_SIZE; addr += BLOCK_SIZE) {
          ctx.signal?.throwIfAborted()
          live.set(await readBlock(t, addr, BLOCK_SIZE, addr === 0, opts), IDENT_SIZE + addr)
          ctx.progress?.({
            phase: 'read',
            done: addr + BLOCK_SIZE,
            total: MAIN_SIZE,
            label: 'Reading what is on the radio now',
          })
        }
        base = live
      }
      if (base.length !== next.length) {
        throw new DriverError('The edited image is a different size to the one that was read')
      }

      const owned = uv82OwnedRanges()
      const inOwned = (from: number, to: number) =>
        owned.some(([s2, e2]: readonly [number, number]) => from >= s2 && to <= e2)
      const forbidden = (from: number, to: number) =>
        NEVER_WRITE.some(([s2, e2]: readonly [number, number]) => from < e2 && to > s2)

      // Collect the blocks to send before sending any of them, so a refusal
      // happens with nothing on the wire.
      const blocks: { imageOffset: number; radioAddr: number; data: Uint8Array }[] = []
      for (let off = IDENT_SIZE; off + WRITE_BLOCK_SIZE <= IDENT_SIZE + MAIN_SIZE; off += WRITE_BLOCK_SIZE) {
        const to = off + WRITE_BLOCK_SIZE
        let differs = false
        for (let i = off; i < to; i++) {
          if (base[i] !== next[i]) { differs = true; break }
        }
        if (!differs) continue

        if (forbidden(off, to)) {
          throw new DriverError(
            `Refusing to write: 0x${off.toString(16)} is one of the windows CHIRP has always skipped, ` +
              'and boofwang does not model anything there. That is a defect in the encoder.',
          )
        }
        if (!inOwned(off, to)) {
          throw new DriverError(
            `Refusing to write: byte 0x${off.toString(16)} changed but sits outside the ranges this ` +
              'driver claims to understand. That is a defect in boofwang, not in your codeplug.',
          )
        }
        blocks.push({ imageOffset: off, radioAddr: off - IDENT_SIZE, data: next.slice(off, to) })
      }

      const operations: WriteOperation[] = blocks.map((b) => ({
        addr: b.radioAddr,
        length: WRITE_BLOCK_SIZE,
        label: `0x${b.radioAddr.toString(16).padStart(4, '0')}`,
      }))

      if (blocks.length === 0) {
        return { blocksWritten: 0, bytesWritten: 0, verified: true, dryRun: ctx.dryRun === true, operations }
      }
      if (ctx.dryRun) {
        return {
          blocksWritten: blocks.length,
          bytesWritten: blocks.length * WRITE_BLOCK_SIZE,
          verified: false,
          dryRun: true,
          operations,
        }
      }

      let sent = 0
      const committed: WriteReport = {
        blocksWritten: 0,
        bytesWritten: 0,
        verified: false,
        dryRun: false,
        operations,
      }
      const withReport = (e: unknown) => {
        if (e instanceof Error) (e as Error & { partial?: WriteReport }).partial = { ...committed, blocksWritten: sent, bytesWritten: sent * WRITE_BLOCK_SIZE }
        return e
      }

      try {
        for (const b of blocks) {
          ctx.signal?.throwIfAborted()
          await writeBlock(t, b.radioAddr, b.data, opts)
          sent++
          ctx.progress?.({
            phase: 'write',
            done: sent * WRITE_BLOCK_SIZE,
            total: blocks.length * WRITE_BLOCK_SIZE,
            label: `0x${b.radioAddr.toString(16).padStart(4, '0')}`,
          })
        }
      } catch (e) {
        throw withReport(e)
      }

      /*
       * Read every block back before calling the write done.
       *
       * The radio acknowledges each frame, but an acknowledgement only says it
       * arrived - not that it landed where it was meant to or survived being
       * written to flash. Reading back is the only thing that distinguishes
       * those, and it is cheap next to the cost of being wrong.
       */
      try {
        for (const [i, b] of blocks.entries()) {
          ctx.signal?.throwIfAborted()
          const got = await readBlock(t, b.radioAddr, WRITE_BLOCK_SIZE, false, opts)
          if (!equalBytes(got, b.data)) {
            const at = got.findIndex((x, j) => x !== b.data[j])
            throw new WriteVerifyError(
              b.radioAddr,
              hexDump(b.data.subarray(at, at + 8), 8),
              hexDump(got.subarray(at, at + 8), 8),
              i + 1,
            )
          }
          ctx.progress?.({
            phase: 'verify',
            done: (i + 1) * WRITE_BLOCK_SIZE,
            total: blocks.length * WRITE_BLOCK_SIZE,
            label: `0x${b.radioAddr.toString(16).padStart(4, '0')}`,
          })
        }
      } catch (e) {
        throw withReport(e)
      }

      return {
        blocksWritten: blocks.length,
        bytesWritten: blocks.length * WRITE_BLOCK_SIZE,
        verified: true,
        dryRun: false,
        operations,
      }
    },

    decode(image: RadioImage): Codeplug {
      if (image.radioId !== 'uv82') throw new DriverError(`Not a UV-82 image: ${image.radioId}`)
      const found = locate(image, CHANNEL_BASE)
      if (!found) throw new DriverError('UV-82 image has no memory region')
      const mem = found.region.data

      const cp = emptyCodeplug('uv82', image.createdAt)
      cp.meta.title = 'UV-82 codeplug'
      cp.meta.variant = image.variant

      for (let i = 0; i < CHANNEL_COUNT; i++) {
        const ch = decodeChannel(mem, i)
        if (ch) cp.channels.set(ch.index, ch)
      }
      return cp
    },

    encode(doc: Codeplug, base: RadioImage): RadioImage {
      if (doc.radio !== 'uv82') throw new DriverError(`Not a UV-82 codeplug: ${doc.radio}`)
      if (base.radioId !== 'uv82') throw new DriverError(`Not a UV-82 image: ${base.radioId}`)

      const found = locate(base, 0)
      if (!found) throw new DriverError('UV-82 image has no memory region')

      // A copy of the bytes that came off the radio, patched in place. There is
      // deliberately no way to build one from nothing: the parts of this memory
      // map nobody has decoded survive only because they are carried through.
      const mem = found.region.data.slice()

      for (let i = 0; i < CHANNEL_COUNT; i++) {
        encodeChannel(mem, i, doc.channels.get(i + 1) ?? null)
      }

      return {
        ...base,
        createdAt: new Date().toISOString(),
        regions: base.regions.map((r) => (r.start === found.region.start ? { ...r, data: mem } : r)),
      }
    },

    validate(doc: Codeplug): Diagnostic[] {
      const out: Diagnostic[] = []
      for (const ch of doc.channels.values()) {
        const band = UV82_SCHEMA.rf.bands.find((b) => ch.rxFreq >= b.loHz && ch.rxFreq <= b.hiHz)
        if (!band) {
          out.push({
            severity: 'error',
            ruleId: 'radio.band.rx-out-of-range',
            channel: ch.index,
            field: 'rxFreq',
            message: `${(ch.rxFreq / 1e6).toFixed(5)} MHz is outside both bands this radio covers.`,
          })
        }
        if (ch.name.length > UV82_SCHEMA.memory.nameLength) {
          out.push({
            severity: 'warning',
            ruleId: 'radio.name.too-long',
            channel: ch.index,
            field: 'name',
            message: `Name is ${ch.name.length} characters; the radio shows ${UV82_SCHEMA.memory.nameLength}.`,
          })
        }
      }
      return out
    },

    ownedRanges: (regionStart: number) => (regionStart === 0 ? uv82OwnedRanges() : []),
  }

  return driver
}


/**
 * Write one channel back into the image, in place.
 *
 * The exact inverse of `decodeChannel`, and deliberately a partial patch: every
 * field the decoder does not model - the unknown bit runs, the icon flags, the
 * scan-list membership this build does not read - keeps whatever the radio had.
 * That is what makes `encode(decode(image), image)` byte-identical, and it is
 * the only reason it is safe to send bytes to a radio whose memory map is only
 * partly understood.
 */
export function encodeChannel(mem: Uint8Array, i: number, ch: Channel | null): void {
  const addr = channelAddr(i)

  if (ch === null) {
    /*
     * An empty slot is marked by its first byte alone, and the rest is left
     * exactly as found.
     *
     * This radio does not blank a record it is done with - on the unit this was
     * developed against, every slot from 28 upwards reads `ff 00 57 15 …`,
     * which is stale data behind an 0xFF marker. Filling the record with 0xFF
     * would be inventing sixteen bytes per empty slot, which breaks
     * `encode(decode(image), image)` and sends the radio bytes it never had.
     */
    if (mem[addr] === 0xff) return

    // A slot that had content and no longer does was cleared deliberately, so
    // mark it the way the radio marks one and leave the remains alone.
    mem[addr] = 0xff
    UV82_NAME.write(mem, nameAddr(i), { name: '' })
    return
  }

  /*
   * A receive-only channel keeps whichever marker it already carries.
   *
   * This family expresses "do not transmit" by filling the transmit frequency,
   * and CHIRP accepts two fillings: all 0xFF and all 0x00. Both decode as
   * inhibited, so normalising one to the other changes four bytes to say
   * exactly what they already said - which breaks the byte-exact round trip and
   * puts bytes on the wire that nobody asked to change.
   */
  const txBytes = mem.subarray(addr + 0x04, addr + 0x08)
  const alreadyInhibited = txBytes.every((b) => b === 0xff) || txBytes.every((b) => b === 0x00)
  const keepMarker = !ch.txAllowed && alreadyInhibited

  const txFreq = ch.txAllowed ? (txFrequency(ch) ?? ch.rxFreq) : 0

  UV82_CHANNEL.write(mem, addr, {
    rxFreq: ch.rxFreq,
    ...(ch.txAllowed ? { txFreq } : {}),
    rxTone: encodeToneWord(ch.tone.rx, `Channel ${ch.index} receive tone`),
    txTone: encodeToneWord(ch.tone.tx, `Channel ${ch.index} transmit tone`),
    f0e: { lowPower: ch.power.mW <= UV82_SCHEMA.rf.powerLevels[1]!.mW ? POWER_LOW : 0 },
    f0f: {
      // `wide` is 1 for wide, the opposite sense to the UV-K5's bandwidth bit.
      wide: ch.bandwidthHz >= BANDWIDTH_WIDE_HZ ? 1 : 0,
      scan: ch.skip === 'skip' ? 0 : 1,
      bcl: Number(ch.extras.vendor?.busyChannelLockout ?? 0) ? 1 : 0,
      pttId: Number(ch.extras.vendor?.pttId ?? 0) & 0x03,
    },
    f0c: { scode: Number(ch.extras.vendor?.scode ?? 0) & 0x0f },
  })

  /*
   * Receive-only is written as four 0xFF bytes, and only ever as that.
   *
   * CHIRP's `_is_txinh` recognises exactly one marker - `FF FF FF FF`. A
   * transmit frequency of zero is not an inhibit to it: it computes the
   * distance from the receive frequency, calls the channel a split, and reports
   * transmit as *enabled*. So a channel that boofwang marked receive-only would
   * come back transmit-capable in CHIRP and, worse, on the radio.
   *
   * That is the failure this codebase cares about most - it is how a weather or
   * public-safety frequency ends up in a radio someone can key up - so the
   * marker is written explicitly rather than left to a numeric field that
   * cannot express it. An existing 0x00 filling is left alone, because CHIRP
   * reads that as inhibited too and rewriting it would put four pointless bytes
   * on the wire.
   */
  if (!ch.txAllowed && !keepMarker) mem.fill(0xff, addr + 0x04, addr + 0x08)

  UV82_NAME.write(mem, nameAddr(i), { name: ch.name.slice(0, NAME_LENGTH) })
}

/** Decode one channel record, or null when the slot is empty. */
export function decodeChannel(mem: Uint8Array, i: number): Channel | null {
  const addr = channelAddr(i)

  // An unused slot is marked by its **first byte** alone being 0xFF, which is
  // exactly CHIRP's test (`_mem.get_raw()[:1] == b"\xff"`). This radio does not
  // blank the rest of the record: on the test unit, every slot from 28 upwards
  // reads `ff 00 57 15 00 00 57 15 ...`, so a whole-record 0xFF check would
  // treat a hundred empty slots as programmed channels near 155.7 MHz.
  if (mem[addr] === 0xff) return null

  const raw = UV82_CHANNEL.read(mem, addr)
  // Belt and braces: a record that is not valid BCD cannot be a frequency.
  if (!Number.isFinite(raw.rxFreq) || raw.rxFreq === 0) return null

  const rxFreq = hz(raw.rxFreq)

  // This family stores an absolute transmit frequency rather than a shift, so
  // the offset is derived. A zero transmit frequency is how it says "receive
  // only".
  let tx: TxSpec = { kind: 'simplex' }
  let txAllowed = true
  let txInhibitReason: string | undefined

  if (!Number.isFinite(raw.txFreq) || raw.txFreq === 0) {
    txAllowed = false
    txInhibitReason = 'Transmit frequency is zero'
  } else if (raw.txFreq !== raw.rxFreq) {
    const delta = raw.txFreq - raw.rxFreq
    tx = { kind: 'offset', direction: delta > 0 ? 'plus' : 'minus', offset: hz(Math.abs(delta)) }
  }

  const rx = decodeToneWord(raw.rxTone)
  const txTone = decodeToneWord(raw.txTone)
  const tone: TonePair = rx === null && txTone === null ? NO_TONE : { rx, tx: txTone, rxInverted: false }

  const level = raw.f0e.lowPower === POWER_LOW ? UV82_SCHEMA.rf.powerLevels[1]! : UV82_SCHEMA.rf.powerLevels[0]!

  return {
    index: i + 1,
    name: UV82_NAME.read(mem, nameAddr(i)).name.trimEnd(),
    rxFreq,
    tx,
    txAllowed,
    ...(txInhibitReason === undefined ? {} : { txInhibitReason }),
    tone,
    modulation: 'FM',
    // `wide` is 1 for wide here - the opposite sense to the UV-K5's bandwidth bit.
    bandwidthHz: raw.f0f.wide ? BANDWIDTH_WIDE_HZ : BANDWIDTH_NARROW_HZ,
    power: { mW: level.mW, label: level.label },
    // The family stores no per-channel step; the radio uses its global setting.
    tuningStep: hz(5_000),
    skip: raw.f0f.scan ? 'none' : 'skip',
    comment: '',
    extras: {
      vendor: {
        busyChannelLockout: String(raw.f0f.bcl),
        pttId: String(raw.f0f.pttId),
        scode: String(raw.f0c.scode),
      },
    },
  }
}
