// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump, sha256Hex } from '../../codec/checksum.js'
import { validateCodeplug } from '../../validate/rules.js'
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
import { isKnownBridgeVendor } from '../../transport/usb-bridges.js'
import {
  BLOCK_SIZE,
  SETTINGS_REGION,
  VARIANTS,
  handshake,
  imageSize,
  readBlock,
  uploadBlockSize,
  writeBlock,
  type Uv5rVariant,
} from './protocol.js'
import {
  CHANNEL_BASE,
  CHANNEL_SIZE,
  NAME_LENGTH,
  UV5RM_CHANNEL,
  UV5RM_SETTINGS,
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
      return isKnownBridgeVendor(info.usbVendorId) ? 'possible' : 'no'
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
      if (!schema.capabilities.write && !ctx.dryRun) {
        throw new WriteBlockedError('Writing the UV-5R Mini is not enabled in this build.')
      }
      if (!ctx.dryRun && !ctx.backup) throw new BackupRequiredError('uv5rmini')

      /*
       * Bluetooth writes on the same footing as the cable.
       *
       * There used to be a refusal here, keyed on `t.kind === 'bluetooth'`,
       * because no radio had received a wireless upload. It went at the
       * owner's direction once one had. What is unchanged, and is the reason
       * the block-by-block read-back below matters more over this carrier than
       * over the cable: the upload rewrites every block, because a partial
       * write erases the rest of the flash page, so a link that drops halfway
       * leaves a wiped radio rather than a half-written one. This is the radio
       * whose write path once erased channels 3-21.
       *
       * Nothing about the frames changes with the carrier. `uploadBlockSize`
       * already adapts 0x40 to 0x80 for a GATT link and pads the last block of
       * each region with 0xFF, both transcribed from CHIRP's `UV5RMini._upload`
       * and exercised against a fake in test/lib/radios/uv5rmini/ble-write.spec.ts.
       */

      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      const ident = ctx.ident ?? (await driver.identify(t, ctx))
      if (ctx.backup && ctx.backup.identHash !== ident.identHash) throw new BackupRequiredError('uv5rmini')
      if (!ctx.dryRun && !ident.caps.write) {
        throw new WriteBlockedError(
          ident.caps.reason ?? `This build does not write firmware ${ident.variant}.`,
        )
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

      /**
       * Cut the image into blocks of `size`, padding a short final one with
       * 0xFF.
       *
       * The padding only ever happens over Bluetooth: every region divides by
       * 0x40 and none of them divides by 0x80, so the last block of each region
       * runs past the region's end and has to be filled. CHIRP pads with 0xFF
       * for the same reason, and 0xFF is the right filler because it is what
       * erased flash reads as - the radio ends up holding what it would have
       * held anyway.
       */
      const plan = (size: number) => {
        const out: { addr: number; data: Uint8Array }[] = []
        for (const region of variant.regions) {
          const data = regionOf(region.start)?.data
          if (!data || data.length !== region.size) {
            throw new DriverError(`The image is missing the region at 0x${region.start.toString(16)}`)
          }
          for (let off = 0; off < region.size; off += size) {
            const chunk = new Uint8Array(size).fill(0xff)
            chunk.set(data.subarray(off, Math.min(off + size, region.size)), 0)
            out.push({ addr: region.start + off, data: chunk })
          }
        }
        return out
      }

      /*
       * Over its own Bluetooth module the radio takes twice as much per
       * frame, which halves the number of acknowledgement round trips - and a
       * BLE round trip is what makes this transfer slow. Reads stay at 0x40
       * either way, so the two plans differ and the read-back pass gets its
       * own.
       *
       * Keyed on `radioLink`, not `kind`: what sets the block size is what
       * the RADIO believes it is connected by. Behind a BLE-to-UART dongle
       * the carrier is Bluetooth but the radio sees its own wired UART and
       * takes 0x40 - sending it the 0x80 frames its wireless mode negotiates
       * would write a malformed codeplug rather than fail cleanly.
       */
      const blockSize = uploadBlockSize(t.radioLink)
      const blocks = plan(blockSize)
      const verifyBlocks = blockSize === BLOCK_SIZE ? blocks : plan(BLOCK_SIZE)

      const operations: WriteOperation[] = blocks.map((b) => ({
        addr: b.addr,
        length: blockSize,
        label: `0x${b.addr.toString(16).padStart(4, '0')}`,
      }))

      if (blocks.length === 0) {
        return { blocksWritten: 0, bytesWritten: 0, verified: true, dryRun: ctx.dryRun === true, operations }
      }
      if (ctx.dryRun) {
        return {
          blocksWritten: blocks.length,
          bytesWritten: blocks.length * blockSize,
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
            bytesWritten: sent * blockSize,
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
            done: sent * blockSize,
            total: blocks.length * blockSize,
            label: `0x${b.addr.toString(16).padStart(4, '0')}`,
          })
        }

        // Every block is read back and compared. An acknowledgement says the
        // frame arrived, not that it landed where it was meant to.
        //
        // The read-back walks the 0x40 plan, which over Bluetooth is not the
        // plan that was sent. That covers every byte of the image and leaves
        // only the 0xFF padding past each region's end unchecked - bytes the
        // image never claimed anything about.
        for (const [i, b] of verifyBlocks.entries()) {
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
            total: verifyBlocks.length * BLOCK_SIZE,
            label: `0x${b.addr.toString(16).padStart(4, '0')}`,
          })
        }
      } catch (e) {
        throw partial(e)
      }

      return {
        blocksWritten: blocks.length,
        bytesWritten: blocks.length * blockSize,
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

      /*
       * Radio-wide settings are decoded so they survive an export and can be
       * seen, even though nothing edits them yet.
       *
       * They are the whole of the 64-byte region the radio serves from 0x9000.
       * CHIRP seeks to image offset 0x8040 for them, which is the same bytes
       * seen from the other side: the image is the three regions concatenated,
       * so that offset is where this region begins. Reading them by region
       * start rather than by image offset keeps the two from drifting.
       */
      const block = image.regions.find((r) => r.start === SETTINGS_REGION)?.data
      if (block && block.length >= UV5RM_SETTINGS.size) {
        cp.settings = { ...UV5RM_SETTINGS.read(block, 0) }
      }

      return cp
    },

    encode(doc: Codeplug, base: RadioImage): RadioImage {
      if (doc.radio !== 'uv5rmini') throw new DriverError(`Not a UV-5R Mini codeplug: ${doc.radio}`)
      if (base.radioId !== 'uv5rmini') throw new DriverError(`Not a UV-5R Mini image: ${base.radioId}`)

      const found = locate(base, CHANNEL_BASE)
      if (!found) throw new DriverError('UV-5R Mini image has no channel region')

      // A copy of the bytes that came off the radio, patched in place. There is
      // no way to build one from nothing: the VFO entries, the ANI and PTT-ID
      // region and the gap this build does not decode survive only because they
      // are carried through untouched.
      const mem = found.region.data.slice()
      const variant = variantOf(base.layout)

      for (let i = 0; i < variant.channelCount; i++) {
        encodeChannel(mem, i, doc.channels.get(i + 1) ?? null, variant)
      }

      /*
       * Settings are patched into their own region, and only where they differ.
       *
       * `write()` assigns the keys present in the patch and leaves the rest of
       * the 64 bytes alone, so the fields this build does not name keep whatever
       * the radio had - the same rule the channel records follow, and what keeps
       * `encode(decode(image), image)` byte-exact.
       */
      const settingsRegion = base.regions.find((r) => r.start === SETTINGS_REGION)
      let settings = settingsRegion?.data
      if (settingsRegion && settings && settings.length >= UV5RM_SETTINGS.size) {
        const patch: Record<string, number> = {}
        const current = UV5RM_SETTINGS.read(settings, 0) as Record<string, number>
        for (const [key, value] of Object.entries(doc.settings)) {
          if (typeof value !== 'number') continue
          if (!(key in current)) continue
          if (current[key] === value) continue
          patch[key] = value
        }
        if (Object.keys(patch).length > 0) {
          settings = settings.slice()
          UV5RM_SETTINGS.write(settings, 0, patch)
        }
      }

      return {
        ...base,
        createdAt: new Date().toISOString(),
        regions: base.regions.map((r) => {
          if (r.start === found.region.start) return { ...r, data: mem }
          if (r.start === SETTINGS_REGION && settings) return { ...r, data: settings }
          return r
        }),
      }
    },

    validate(doc: Codeplug): Diagnostic[] {
      return validateCodeplug(doc, UV5RMINI_SCHEMA)
    },

    /**
     * The channel array and the settings block, and nothing else.
     *
     * The VFO entries, the ANI and PTT-ID region at 0xA000 and the gap before
     * 0x8000 are read and preserved but not decoded, so a change landing there
     * means the encoder has a bug rather than that the user edited something.
     */
    ownedRanges: (regionStart: number) =>
      regionStart === CHANNEL_BASE
        ? [[CHANNEL_BASE, CHANNEL_BASE + VARIANTS[1]!.channelCount * CHANNEL_SIZE] as const]
        : regionStart === SETTINGS_REGION
          ? [[0, UV5RM_SETTINGS.size] as const]
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
   * `_is_txinh` for this family (reference/baofeng_common.py) accepts all-0xFF
   * and all-0x00, and a numeric field cannot express either - writing a zero
   * *frequency* is not the same as writing the marker. An existing marker is
   * left in whichever spelling it already uses, because rewriting it would put
   * four bytes on the wire to say what they already said.
   *
   * The classic UV-5R family cannot do this: its `_is_txinh` (uv5r.py) accepts
   * only all-0xFF, so the UV-82 driver canonicalises a zero filling on any
   * record it changes. Do not unify the two - the keep-as-found here is safe
   * precisely because this family's parser reads both spellings.
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
