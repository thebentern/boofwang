// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump, sha256Hex } from '../../codec/checksum.js'
import { equalBytes } from '../../codec/struct.js'
import { emptyCodeplug, type Channel, type Codeplug, type TxSpec } from '../../model/index.js'
import { NO_TONE, type TonePair } from '../../model/tones.js'
import { hz, mW } from '../../model/units.js'
import { txFrequency } from '../../model/channel.js'
import {
  BackupRequiredError,
  DEFAULT_DRIVER_TIMEOUT_MS,
  DriverError,
  WriteVerifyError,
  type WriteOperation,
  WriteBlockedError,
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
  BLOCK_SIZE,
  VARIANTS,
  handshake,
  imageSize,
  readBlock,
  writeBlock,
  type Uv5rVariant,
} from './protocol.js'
import {
  CHANNEL_BASE,
  CHANNEL_SIZE,
  NAME_LENGTH,
  UV5RM_CHANNEL,
  decodeName,
  decodeToneWord,
  encodeName,
  encodeToneWord,
  isChannelEmpty,
  isTxInhibited,
} from './layout.js'
import { UV5RMINI_SCHEMA, UV5RMINI_SERIAL } from './schema.js'

/**
 * Pull whatever printable text the handshake replies carry.
 *
 * Nothing documents their structure, so this takes the longest run of
 * printable characters rather than pretending to know a field layout. It is
 * used as the variant string, which is what binds an image to the radio it was
 * read from - so it has to be stable, not merely informative.
 */
export function describeIdent(detail: Uint8Array): string {
  let best = ''
  let run = ''
  for (const b of detail) {
    if (b >= 0x20 && b < 0x7f) {
      run += String.fromCharCode(b)
    } else {
      if (run.length > best.length) best = run
      run = ''
    }
  }
  if (run.length > best.length) best = run
  return best.trim()
}

export interface Uv5rMiniOptions {
  /** Whether this build may write. Turned on in the registry. */
  enableWrite?: boolean
}

export function createUv5rMiniDriver(options: Uv5rMiniOptions = {}): RadioDriver {
  const schema: RadioSchema = options.enableWrite
    ? {
        ...UV5RMINI_SCHEMA,
        status: 'beta',
        capabilities: { ...UV5RMINI_SCHEMA.capabilities, write: true, writesWholeImage: true },
      }
    : UV5RMINI_SCHEMA

  const driver: RadioDriver = {
    id: 'uv5rmini',
    schema,
    serial: { ...UV5RMINI_SERIAL, signals: { ...UV5RMINI_SERIAL.signals } },
    // No exit command in this protocol; the radio leaves programming mode when
    // the port closes.
    abortPolicy: 'power-cycle',
    writeBlockBytes: BLOCK_SIZE,

    /**
     * Nothing here distinguishes one unit from another.
     *
     * The handshake replies describe the model and firmware, not the radio, and
     * no calibration region is exposed separately. Null means "cannot tell".
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
      const ident = await handshake(t, opts)
      const text = describeIdent(ident.detail)

      ctx.log?.info(`UV-5R Mini ident ${[...ident.info].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`)
      ctx.progress?.({ phase: 'handshake', done: 1, total: 1, label: text || 'identified' })

      const raw = new Uint8Array(ident.info.length + ident.detail.length)
      raw.set(ident.info, 0)
      raw.set(ident.detail, ident.info.length)

      return {
        radioId: 'uv5rmini',
        variant: text || ident.variant.label,
        // The layout is which of the two radios answered, and everything
        // downstream - region map, channel count, power table - keys off it.
        layout: ident.variant.id,
        raw,
        caps: {
          read: true,
          write: schema.capabilities.write,
        },
        identHash: await sha256Hex(raw),
        meta: { ident: [...raw], model: ident.variant.label },
      }
    },

    async readImage(t: Transport, ident: IdentifyResult, ctx: DriverCtx = {}): Promise<RadioImage> {
      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      const variant = variantOf(ident.layout)
      const total = imageSize(variant)
      let done = 0
      const regions: { start: number; data: Uint8Array; label: string }[] = []

      for (const region of variant.regions) {
        const data = new Uint8Array(region.size)
        for (let off = 0; off < region.size; off += BLOCK_SIZE) {
          ctx.signal?.throwIfAborted()
          const addr = region.start + off
          data.set(await readBlock(t, addr, BLOCK_SIZE, opts), off)
          done += BLOCK_SIZE
          ctx.progress?.({
            phase: 'read',
            done,
            total,
            label: `0x${addr.toString(16).padStart(4, '0')}`,
          })
        }
        regions.push({ start: region.start, data, label: region.label })
      }

      // Hash the regions in address order, so the same radio gives the same
      // digest whatever order they happened to be read in.
      const flat = new Uint8Array(total)
      let at = 0
      for (const r of regions) {
        flat.set(r.data, at)
        at += r.data.length
      }

      return {
        radioId: 'uv5rmini',
        variant: ident.variant,
        layout: ident.layout,
        createdAt: new Date().toISOString(),
        regions,
        meta: { ident: ident.meta?.ident ?? [] },
        sha256: await sha256Hex(flat),
      }
    },

    async writeImage(t: Transport, image: RadioImage, ctx: DriverCtx = {}): Promise<WriteReport> {
      if (image.radioId !== 'uv5rmini') throw new DriverError(`Not a UV-5R Mini image: ${image.radioId}`)
      if (!schema.capabilities.write && !ctx.dryRun) throw new WriteBlockedError('the UV-5R Mini')
      if (!ctx.dryRun && !ctx.backup) throw new BackupRequiredError('uv5rmini')

      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      const ident = ctx.ident ?? (await driver.identify(t, ctx))
      if (ctx.backup && ctx.backup.identHash !== ident.identHash) throw new BackupRequiredError('uv5rmini')
      if (!ctx.dryRun && !ident.caps.write) {
        throw new WriteBlockedError(ident.caps.reason ?? `firmware ${ident.variant}`)
      }

      const variant = variantOf(image.layout)
      if (variant.id !== variantOf(ident.layout).id) {
        throw new DriverError(
          `This image came from a ${variant.label} and the radio on the cable is a ` +
            `${variantOf(ident.layout).label}. They differ in region map, channel count and power table.`,
        )
      }

      /*
       * Every block is sent, in order, always.
       *
       * This radio erases a flash page before programming it, and only the
       * block it was handed gets written back - so sending one block wipes
       * everything else that shared its page. That was found the hard way: a
       * single-block write to slot 1 erased channels 3 to 21 on a real radio.
       * The damage is invisible in the write itself, which acknowledges each
       * frame and reads it back correctly, because the block that was sent is
       * genuinely fine. Only a full read afterwards shows the rest is gone.
       *
       * The other three radios here take a sparse write happily and that is
       * what makes a one-channel edit cost one block. This one cannot, so it
       * gets CHIRP's behaviour instead: the whole image, every time. It is 521
       * blocks and about 17 seconds, which is a price worth paying.
       */
      const regionOf = (start: number) => image.regions.find((r) => r.start === start)

      const blocks: { addr: number; data: Uint8Array }[] = []
      for (const region of variant.regions) {
        const data = regionOf(region.start)?.data
        if (!data || data.length !== region.size) {
          throw new DriverError(`The image is missing the region at 0x${region.start.toString(16)}`)
        }
        for (let off = 0; off < region.size; off += BLOCK_SIZE) {
          const chunk = new Uint8Array(BLOCK_SIZE).fill(0xff)
          chunk.set(data.subarray(off, Math.min(off + BLOCK_SIZE, region.size)), 0)
          blocks.push({ addr: region.start + off, data: chunk })
        }
      }

      const operations: WriteOperation[] = blocks.map((b) => ({
        addr: b.addr,
        length: BLOCK_SIZE,
        label: `0x${b.addr.toString(16).padStart(4, '0')}`,
      }))

      if (blocks.length === 0) {
        return { blocksWritten: 0, bytesWritten: 0, verified: true, dryRun: ctx.dryRun === true, operations }
      }
      if (ctx.dryRun) {
        return {
          blocksWritten: blocks.length,
          bytesWritten: blocks.length * BLOCK_SIZE,
          verified: false,
          dryRun: true,
          operations,
        }
      }

      let sent = 0
      const partial = (e: unknown) => {
        if (e instanceof Error) {
          ;(e as Error & { partial?: WriteReport }).partial = {
            blocksWritten: sent,
            bytesWritten: sent * BLOCK_SIZE,
            verified: false,
            dryRun: false,
            operations,
          }
        }
        return e
      }

      try {
        for (const b of blocks) {
          ctx.signal?.throwIfAborted()
          await writeBlock(t, b.addr, b.data, opts)
          sent++
          ctx.progress?.({
            phase: 'write',
            done: sent * BLOCK_SIZE,
            total: blocks.length * BLOCK_SIZE,
            label: `0x${b.addr.toString(16).padStart(4, '0')}`,
          })
        }

        // Every block is read back and compared. An acknowledgement says the
        // frame arrived, not that it landed where it was meant to.
        for (const [i, b] of blocks.entries()) {
          ctx.signal?.throwIfAborted()
          const got = await readBlock(t, b.addr, BLOCK_SIZE, opts)
          if (!equalBytes(got, b.data)) {
            const at = got.findIndex((x, j) => x !== b.data[j])
            throw new WriteVerifyError(
              b.addr,
              hexDump(b.data.subarray(at, at + 8), 8),
              hexDump(got.subarray(at, at + 8), 8),
              i + 1,
              // This driver sends everything, then verifies.
              true,
            )
          }
          ctx.progress?.({
            phase: 'verify',
            done: (i + 1) * BLOCK_SIZE,
            total: blocks.length * BLOCK_SIZE,
            label: `0x${b.addr.toString(16).padStart(4, '0')}`,
          })
        }
      } catch (e) {
        throw partial(e)
      }

      return {
        blocksWritten: blocks.length,
        bytesWritten: blocks.length * BLOCK_SIZE,
        verified: true,
        dryRun: false,
        operations,
      }
    },

    decode(image: RadioImage): Codeplug {
      if (image.radioId !== 'uv5rmini') throw new DriverError(`Not a UV-5R Mini image: ${image.radioId}`)
      const found = locate(image, CHANNEL_BASE)
      if (!found) throw new DriverError('UV-5R Mini image has no channel region')
      const mem = found.region.data

      const cp = emptyCodeplug('uv5rmini', image.createdAt)
      cp.meta.title = 'UV-5R Mini codeplug'
      cp.meta.variant = image.variant

      const variant = variantOf(image.layout)
      for (let i = 0; i < variant.channelCount; i++) {
        const ch = decodeChannel(mem, i, variant)
        if (ch) cp.channels.set(ch.index, ch)
      }
      return cp
    },

    encode(doc: Codeplug, base: RadioImage): RadioImage {
      if (doc.radio !== 'uv5rmini') throw new DriverError(`Not a UV-5R Mini codeplug: ${doc.radio}`)
      if (base.radioId !== 'uv5rmini') throw new DriverError(`Not a UV-5R Mini image: ${base.radioId}`)

      const found = locate(base, CHANNEL_BASE)
      if (!found) throw new DriverError('UV-5R Mini image has no channel region')

      // A copy of the bytes that came off the radio, patched in place. There is
      // no way to build one from nothing: the settings, the VFOs and the two
      // small tail regions this build does not decode survive only because they
      // are carried through untouched.
      const mem = found.region.data.slice()
      const variant = variantOf(base.layout)

      for (let i = 0; i < variant.channelCount; i++) {
        encodeChannel(mem, i, doc.channels.get(i + 1) ?? null, variant)
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
        const band = UV5RMINI_SCHEMA.rf.bands.find((b) => ch.rxFreq >= b.loHz && ch.rxFreq <= b.hiHz)
        if (!band) {
          out.push({
            severity: 'error',
            ruleId: 'radio.band.rx-out-of-range',
            channel: ch.index,
            field: 'rxFreq',
            message: `${(ch.rxFreq / 1e6).toFixed(5)} MHz is outside every band this radio covers.`,
          })
        } else if (!band.txAllowed && ch.txAllowed) {
          out.push({
            severity: 'error',
            ruleId: 'radio.band.tx-not-allowed',
            channel: ch.index,
            field: 'txAllowed',
            message: `${band.label} is receive-only, but this channel is set to transmit.`,
          })
        }
        if (ch.name.length > UV5RMINI_SCHEMA.memory.nameLength) {
          out.push({
            severity: 'warning',
            ruleId: 'radio.name.too-long',
            channel: ch.index,
            field: 'name',
            message: `Name is ${ch.name.length} characters; the radio shows ${UV5RMINI_SCHEMA.memory.nameLength}.`,
          })
        }
      }
      return out
    },

    /**
     * The channel array, and nothing else.
     *
     * Settings, the VFOs and the two small tail regions are read and preserved
     * but not decoded, so a change landing there means the encoder has a bug
     * rather than that the user edited something.
     */
    ownedRanges: (regionStart: number) =>
      regionStart === CHANNEL_BASE
        ? [[CHANNEL_BASE, CHANNEL_BASE + VARIANTS[1]!.channelCount * CHANNEL_SIZE] as const]
        : [],
  }

  return driver
}

/**
 * Which radio a stored image came from.
 *
 * Falls back to the UV-5R Mini for an image that predates the distinction: it
 * is the smaller of the two in every dimension, so nothing reads past the end
 * of a region that might not be there.
 */
export function variantOf(layout: string): Uv5rVariant {
  return VARIANTS.find((v) => v.id === layout) ?? VARIANTS[0]!
}


/**
 * Write one channel back into the image, in place.
 *
 * The exact inverse of `decodeChannel`, and a partial patch on purpose: the
 * unknown bit runs, the four undocumented bytes at 0x10-0x13 and anything else
 * this build does not model keep whatever the radio had. That is what makes
 * `encode(decode(image), image)` byte-identical, and it is the only reason it
 * is safe to send bytes to a radio whose memory map is only partly understood.
 */
export function encodeChannel(
  mem: Uint8Array,
  i: number,
  ch: Channel | null,
  variant: Uv5rVariant = VARIANTS[0]!,
): void {
  const addr = CHANNEL_BASE + i * CHANNEL_SIZE
  if (addr + CHANNEL_SIZE > mem.length) return

  if (ch === null) {
    /*
     * An empty slot is marked by its first byte and nothing else is touched.
     *
     * CHIRP tests only that byte, and these radios leave stale data behind the
     * marker rather than blanking the record. Filling it would invent bytes the
     * radio never held - the mistake that broke the UV-82 round trip.
     */
    if (mem[addr] !== 0xff) mem[addr] = 0xff
    return
  }

  /*
   * A slot being programmed for the first time is cleared before it is filled.
   *
   * An erased record is 32 bytes of 0xFF, which means every bit this build does
   * not model reads as set - scramble, FHSS, the squelch mode, and the unknown
   * runs either side of them. A partial patch leaves all of that switched on, so
   * a channel the user just created arrives with features they never asked for
   * and cannot see. CHIRP pre-fills a new record the same way.
   *
   * Only on the empty-to-programmed transition: an existing channel keeps its
   * unmodelled bytes, which is what makes the round trip byte-exact.
   */
  if (mem[addr] === 0xff) mem.fill(0x00, addr, addr + CHANNEL_SIZE)

  const record = mem.subarray(addr, addr + CHANNEL_SIZE)
  const alreadyInhibited =
    record.subarray(0x04, 0x08).every((b) => b === 0xff) ||
    record.subarray(0x04, 0x08).every((b) => b === 0x00)
  const keepMarker = !ch.txAllowed && alreadyInhibited

  /*
   * Tones and names are only rewritten when they actually changed.
   *
   * Both have two spellings for the same meaning. "No tone" is 0x0000 as the
   * radio writes it and 0xFFFF in blank memory, and both decode to no tone; an
   * unnamed channel is 0x00-filled here and 0xFF-padded when written. Encoding
   * the decoded value unconditionally normalises one spelling to the other,
   * which changes bytes to say exactly what they already said - it breaks the
   * byte-exact round trip and puts pointless blocks on the wire.
   */
  const current = UV5RM_CHANNEL.read(mem, addr)
  const sameTone = (a: ReturnType<typeof decodeToneWord>, b: ReturnType<typeof decodeToneWord>) =>
    a === null || b === null ? a === b : JSON.stringify(a) === JSON.stringify(b)

  const rxToneChanged = !sameTone(decodeToneWord(current.rxTone), ch.tone.rx)
  const txToneChanged = !sameTone(decodeToneWord(current.txTone), ch.tone.tx)
  const nameChanged = decodeName(current.nameBytes) !== ch.name.slice(0, NAME_LENGTH)

  UV5RM_CHANNEL.write(mem, addr, {
    rxFreq: ch.rxFreq,
    ...(ch.txAllowed ? { txFreq: txFrequency(ch) ?? ch.rxFreq } : {}),
    ...(rxToneChanged ? { rxTone: encodeToneWord(ch.tone.rx) } : {}),
    ...(txToneChanged ? { txTone: encodeToneWord(ch.tone.tx) } : {}),
    scode: Number(ch.extras.vendor?.scode ?? 0) & 0xff,
    pttid: Number(ch.extras.vendor?.pttId ?? 0) & 0xff,
    power: { lowpower: powerIndexFor(ch.power.mW, variant) },
    flags: {
      // The bit called `wide` means NARROW: a set bit selects MODES[0], which
      // is NFM. Trusting the name would put every channel on the wrong
      // bandwidth, in both directions.
      wide: ch.bandwidthHz <= 12_500 ? 1 : 0,
      scan: ch.skip === 'skip' ? 0 : 1,
      bcl: Number(ch.extras.vendor?.busyChannelLockout ?? 0) ? 1 : 0,
    },
    ...(nameChanged ? { nameBytes: encodeName(ch.name, NAME_LENGTH) } : {}),
  })

  /*
   * Receive-only is written as four 0xFF bytes.
   *
   * `_is_txinh` for this family accepts all-0xFF and all-0x00, and a numeric
   * field cannot express either - writing a zero *frequency* is not the same as
   * writing the marker. An existing marker is left in whichever spelling it
   * already uses, because rewriting it would put four bytes on the wire to say
   * what they already said.
   */
  if (!ch.txAllowed && !keepMarker) mem.fill(0xff, addr + 0x04, addr + 0x08)
}

/**
 * Which power index this radio uses for a given output.
 *
 * The two variants order their tables differently and 5 W is "High" on one and
 * "Medium" on the other, so the index is resolved against the table of whatever
 * answered the handshake rather than a shared constant.
 */
function powerIndexFor(mw: number, variant: Uv5rVariant): number {
  let best = 0
  for (let i = 1; i < variant.power.length; i++) {
    const here = variant.power[i]!.mW
    if (Math.abs(here - mw) < Math.abs(variant.power[best]!.mW - mw)) best = i
  }
  return best
}

/** Decode one channel record, or null when the slot is unused. */
export function decodeChannel(
  mem: Uint8Array,
  i: number,
  variant: Uv5rVariant = VARIANTS[0]!,
): Channel | null {
  const addr = CHANNEL_BASE + i * CHANNEL_SIZE
  if (addr + CHANNEL_SIZE > mem.length) return null

  const record = mem.subarray(addr, addr + CHANNEL_SIZE)
  // CHIRP tests the first byte alone, and so does this: an unused slot on these
  // radios keeps stale bytes in the rest of the record.
  if (isChannelEmpty(record)) return null

  const raw = UV5RM_CHANNEL.read(mem, addr)
  if (!Number.isFinite(raw.rxFreq) || raw.rxFreq === 0) return null

  const rxFreq = hz(raw.rxFreq)

  let tx: TxSpec = { kind: 'simplex' }
  let txAllowed = true
  let txInhibitReason: string | undefined

  if (isTxInhibited(record) || !Number.isFinite(raw.txFreq)) {
    txAllowed = false
    txInhibitReason = 'Transmit frequency is blank'
  } else if (raw.txFreq !== raw.rxFreq) {
    const delta = raw.txFreq - raw.rxFreq
    tx = { kind: 'offset', direction: delta > 0 ? 'plus' : 'minus', offset: hz(Math.abs(delta)) }
  }

  const rx = decodeToneWord(raw.rxTone)
  const txTone = decodeToneWord(raw.txTone)
  const tone: TonePair = rx === null && txTone === null ? NO_TONE : { rx, tx: txTone, rxInverted: false }

  // `lowpower` indexes the power table directly, and this radio's order is
  // High, Low, Medium. An out-of-range value falls back to the first entry,
  // which is what CHIRP does.
  // Indexed straight off the variant's own table: the UV-5R Mini has two
  // levels and the 5RM has three, in a different order, and 5 W is called
  // "High" on one and "Medium" on the other. Sharing one table would put every
  // channel on the wrong power and label it wrongly too.
  const level = variant.power[raw.power.lowpower] ?? variant.power[0]!

  // AM is not a stored flag: the radio uses it when the channel is tuned to the
  // air band, so the modulation is derived from the frequency the way CHIRP
  // derives it.
  const airband = UV5RMINI_SCHEMA.rf.bands[0]!
  const isAir = rxFreq >= airband.loHz && rxFreq <= airband.hiHz

  return {
    index: i + 1,
    name: decodeName(raw.nameBytes),
    rxFreq,
    tx,
    txAllowed,
    ...(txInhibitReason === undefined ? {} : { txInhibitReason }),
    tone,
    modulation: isAir ? 'AM' : 'FM',
    // The bit CHIRP calls `wide` means NARROW. `MODES = ["NFM", "FM"]` and
    // `mem.mode = _mem.wide and MODES[0] or MODES[1]`, so a set bit selects
    // MODES[0], which is NFM. The write side agrees: `_mem.wide = mem.mode ==
    // MODES[0]`. Trusting the field name here would have put every channel on
    // the wrong bandwidth.
    bandwidthHz: raw.flags.wide ? 12_500 : 25_000,
    power: { mW: mW(level.mW), label: level.label },
    // No per-channel step is stored; the radio uses its global setting.
    tuningStep: hz(5_000),
    skip: raw.flags.scan ? 'none' : 'skip',
    comment: '',
    extras: {
      vendor: {
        busyChannelLockout: String(raw.flags.bcl),
        pttId: String(raw.pttid),
        scode: String(raw.scode),
      },
    },
  }
}
