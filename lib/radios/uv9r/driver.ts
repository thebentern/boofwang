// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump, sha256Hex } from '../../codec/checksum.js'
import { equalBytes } from '../../codec/struct.js'
import { emptyCodeplug, type Channel, type Codeplug, type RadioId, type TxSpec } from '../../model/index.js'
import { txFrequency } from '../../model/channel.js'
import { NO_TONE, type TonePair, type ToneSpec } from '../../model/tones.js'
import { hz } from '../../model/units.js'
import {
  BackupRequiredError,
  DEFAULT_DRIVER_TIMEOUT_MS,
  DriverError,
  WriteBlockedError,
  WriteVerifyError,
  type Diagnostic,
  type DriverCtx,
  type IdentifyResult,
  type RadioDriver,
  type WriteOperation,
  type WriteReport,
} from '../../radio/driver.js'
import { locate, type RadioImage } from '../../radio/image.js'
import { clampPower, type PowerLevel, type RadioSchema } from '../../radio/schema.js'
import type { Transport } from '../../transport/transport.js'
import { isKnownBridgeVendor } from '../../transport/usb-bridges.js'
import { validateCodeplug } from '../../validate/rules.js'
import { decodeToneWord, encodeToneWord } from '../uv82/driver.js'
import {
  BANDWIDTH_NARROW_HZ,
  BANDWIDTH_WIDE_HZ,
  CHANNEL_COUNT,
  channelAddr,
  nameAddr,
  NAME_LENGTH,
  ownedRanges as wp970iOwnedRanges,
  POWERON_MSG_BASE,
  REGIONS,
  SETTINGS_BASE,
  UNIT_AREAS,
  VALID_BANDS,
  WP970I_CHANNEL,
  WP970I_NAME,
  WP970I_POWERON_MSG,
  WP970I_SETTINGS,
} from './layout.js'
import {
  BLOCK_SIZE,
  CHIRP_UPLOAD_RANGES,
  IDENT_OFFSET,
  IDENT_SIZE,
  IMAGE_SIZE,
  MAGIC_WP970I,
  MEM_SIZE,
  WRITE_BLOCK_SIZE,
  identify as doIdentify,
  readBlock,
  readFirmware,
  writeBlock,
} from './protocol.js'
import { UV9R_SCHEMA, UV9R_SERIAL } from './schema.js'

/**
 * What a write on this family can reach, for the restore screen and the gate.
 *
 * The three ranges `ownedRanges` claims, in the user's words. Everything else
 * the radio holds - VFOs, the PTT ID and ANI codes, the power-on message, the
 * squelch tables and band limits, and the calibration CHIRP itself refuses to
 * upload across radios - is read, kept in every backup, and never sent.
 */
export const WP970I_WRITE_SCOPE = 'channels, channel names and radio settings'

export interface Wp970iFamilyOptions {
  /**
   * Whether this build may write.
   *
   * Off by default and turned on in the registry, so that a driver built for a
   * test or a file import cannot reach a radio at all. The registry turns it
   * on for this family without a boofwang bench session behind it, and says
   * why there; docs/protocols/uv9r.md says what that rests on.
   */
  enableWrite?: boolean
}

/**
 * One member of CHIRP's WP970I family.
 *
 * `baofeng_wp970i.py` carries the WP970I, BF-A58, UV-82WP, GT-3WP, RT6,
 * BF-A58S, UV-S9X3, 5RX, UV-9R and UV-9G as subclasses of `WP970I` that differ
 * in magic, name length, power table and band plan. The memory map, the
 * protocol and every rule in this file are shared, so the driver is written
 * once and each member supplies what its CHIRP class would - the same seam
 * `createUv5rFamilyDriver` is for the UV-5R family.
 */
export interface Wp970iFamilyModel {
  readonly id: RadioId
  /** How the radio is named in errors and logs: 'UV-9R', 'UV-9G'. */
  readonly label: string
  /** The seven-byte ident magics this member answers, in the order to try them. */
  readonly magics: readonly Uint8Array[]
  readonly schema: RadioSchema
  /**
   * Identification replies a real capture of this radio has carried.
   *
   * Half of what `identify` weighs before offering a write; the other half is
   * the firmware window, which is empty on every unit of this family anyone
   * has published bytes from and holds a real version string on the UV-5R
   * family radios that answer the same magic. CHIRP checks neither - the user
   * picks the model from a list - so a radio whose ident no capture of this
   * model has carried, or whose firmware window says something, is read and
   * backed up and not offered for writing.
   *
   * It is weak evidence and it is labeled as such. The same ident comes back
   * from a UV-82, a BF-A58S and a UV-9R, so it says which hardware generation
   * answered rather than which model. It is a floor under writing, never the
   * case for it.
   */
  readonly knownIdents: readonly Uint8Array[]
}

/**
 * `aa 30 79 04 00 05 20 dd`: what a 2017 UV-9R and a 2018 UV-9R Pro sent,
 * both in captures attached to CHIRP's tracker (issues 4511 and 9932).
 */
export const IDENT_UV9R = Uint8Array.from([0xaa, 0x30, 0x79, 0x04, 0x00, 0x05, 0x20, 0xdd])

const UV9R_MODEL: Wp970iFamilyModel = {
  id: 'uv9r',
  label: 'UV-9R',
  magics: [MAGIC_WP970I],
  schema: UV9R_SCHEMA,
  knownIdents: [IDENT_UV9R],
}

export function createUv9rDriver(options: Wp970iFamilyOptions = {}): RadioDriver {
  return createWp970iFamilyDriver(UV9R_MODEL, options)
}

/** The unit fingerprint: CHIRP's three per-radio aux spans, hashed together. */
export async function unitHashOf(mem: Uint8Array): Promise<string | null> {
  if (mem.length < MEM_SIZE) return null
  const parts = UNIT_AREAS.map(([s, e]) => mem.subarray(s, e))
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    joined.set(p, off)
    off += p.length
  }
  return sha256Hex(joined)
}

export function createWp970iFamilyDriver(model: Wp970iFamilyModel, options: Wp970iFamilyOptions = {}): RadioDriver {
  const schema: RadioSchema = options.enableWrite
    ? {
        ...model.schema,
        status: 'beta',
        capabilities: { ...model.schema.capabilities, write: true, writeScope: WP970I_WRITE_SCOPE },
      }
    : { ...model.schema, capabilities: { ...model.schema.capabilities, writeScope: WP970I_WRITE_SCOPE } }

  const driver: RadioDriver = {
    id: model.id,
    schema,
    serial: { ...UV9R_SERIAL, signals: { ...UV9R_SERIAL.signals } },
    // No exit command in this protocol: the radio leaves clone mode when the
    // port closes, as the UV-5R family does.
    abortPolicy: 'power-cycle',
    writeBlockBytes: WRITE_BLOCK_SIZE,

    /**
     * The three aux spans CHIRP compares before it will upload calibration.
     *
     * This family reads all 0x2000 bytes, so unlike the UV-5R family's driver
     * there is something per-unit to hash: CHIRP's own test of whether an
     * image belongs to the radio on the cable. Null only for an image too
     * short to hold them, and callers read null as "cannot tell".
     */
    async unitFingerprint(image: RadioImage): Promise<string | null> {
      const mem = locate(image, 0)?.region.data
      return mem ? unitHashOf(mem) : null
    },

    match(info) {
      return isKnownBridgeVendor(info.usbVendorId) ? 'possible' : 'no'
    },

    async identify(t: Transport, ctx: DriverCtx = {}): Promise<IdentifyResult> {
      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      ctx.progress?.({ phase: 'handshake', done: 0, total: 1, label: 'Saying hello' })
      const { ident } = await doIdentify(t, model.magics, opts)
      const fw = await readFirmware(t, opts)

      /*
       * Whether this looks like the radio the captures are of, by the two
       * things it says before any memory is read.
       *
       * The ident first: one no captured unit of this model has sent is a
       * different radio. Then the firmware window, which is empty or the
       * factory's question marks on every unit of this family anyone has
       * bytes from. A real version string there is what a radio from another
       * family looks like: uv5r.py sends this magic to the BF-F8HP, whose
       * firmware reports strings like `BFP3V3 F`, and the bench UV-82 sends
       * this family's ident byte for byte. That radio would round-trip - its
       * selectors are these, by index - and be written against a 5 W table on
       * an 8 W radio. So it is read, and not offered for writing.
       */
      const known = model.knownIdents.some((k) => equalBytes(k, ident))
      const reason = !known
        ? `The radio answered with ident ${hexDump(ident)}, which no captured ${model.label} has sent, ` +
          'so its memory cannot be assumed to be laid out as this build expects. ' +
          'The radio can still be read and backed up.'
        : fw.version !== ''
          ? `The radio reports firmware ${JSON.stringify(fw.version)} where no captured ${model.label} reports ` +
            'any. Another family answers the same magic - CHIRP sends it to the BF-F8HP - so the memory ' +
            'cannot be assumed to be laid out as this build expects. The radio can still be read and backed up.'
          : null

      ctx.log?.info(`${model.label} ident ${hexDump(ident)}, firmware window ${hexDump(fw.window)}`)
      ctx.progress?.({ phase: 'handshake', done: 1, total: 1, label: fw.version || model.label })

      return {
        radioId: model.id,
        variant: fw.version,
        layout: model.id,
        raw: ident,
        caps: {
          read: true,
          write: schema.capabilities.write && reason === null,
          ...(reason === null ? {} : { reason }),
        },
        // The ident and the firmware string together. Neither names the unit -
        // the UV-82 on the bench sends the UV-9R's ident byte for byte - which
        // is why a write also checks `unitFingerprint` against the radio.
        identHash: await sha256Hex(Uint8Array.from([...ident, ...new TextEncoder().encode(fw.version)])),
        meta: { droppedByte: fw.droppedByte, firmwareWindow: hexDump(fw.window) },
      }
    },

    async readImage(t: Transport, ident: IdentifyResult, ctx: DriverCtx = {}): Promise<RadioImage> {
      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      const image = new Uint8Array(IMAGE_SIZE)

      // `_download`: one sweep of the whole memory in 0x40 blocks, every block
      // after the firmware probe preceded by an acknowledgment. On a radio that
      // drops the byte at 0x1FCF the last 0x40 bytes come in sixteens instead,
      // exactly as CHIRP's second pass reads them.
      const droppedByte = ident.meta?.droppedByte === true
      const tailStart = droppedByte ? MEM_SIZE - BLOCK_SIZE : MEM_SIZE
      let done = 0
      const report = (addr: number, n: number) => {
        done += n
        ctx.progress?.({ phase: 'read', done, total: MEM_SIZE, label: `0x${addr.toString(16).padStart(4, '0')}` })
      }
      for (let addr = 0; addr < tailStart; addr += BLOCK_SIZE) {
        ctx.signal?.throwIfAborted()
        image.set(await readBlock(t, addr, BLOCK_SIZE, false, opts), addr)
        report(addr, BLOCK_SIZE)
      }
      for (let addr = tailStart; addr < MEM_SIZE; addr += WRITE_BLOCK_SIZE) {
        ctx.signal?.throwIfAborted()
        image.set(await readBlock(t, addr, WRITE_BLOCK_SIZE, false, opts), addr)
        report(addr, WRITE_BLOCK_SIZE)
      }
      // `data += ident`: the identification reply goes after the memory, where
      // CHIRP puts it, so the image is the 0x2008 bytes a CHIRP `.img` holds.
      image.set(ident.raw.subarray(0, IDENT_SIZE), IDENT_OFFSET)

      return {
        radioId: model.id,
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
      if (image.radioId !== model.id) throw new DriverError(`Not a ${model.label} image: ${image.radioId}`)
      if (!schema.capabilities.write && !ctx.dryRun) {
        throw new WriteBlockedError(`Writing the ${model.label} is not enabled in this build.`)
      }
      if (!ctx.dryRun && !ctx.backup) throw new BackupRequiredError(model.id)

      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      const next = locate(image, 0)?.region.data
      if (!next) throw new DriverError('This image has no memory region')
      if (next.length !== IMAGE_SIZE) {
        throw new DriverError(`A ${model.label} image is ${IMAGE_SIZE} bytes; this one is ${next.length}.`)
      }

      // The session's own identification when there is one. CHIRP never
      // handshakes twice in a session, and whether this radio would answer a
      // second one is not something anybody has seen.
      const ident = ctx.ident ?? (await driver.identify(t, ctx))
      if (ctx.backup && ctx.backup.identHash !== ident.identHash) throw new BackupRequiredError(model.id)
      if (!ctx.dryRun && !ident.caps.write) {
        throw new WriteBlockedError(ident.caps.reason ?? `This build does not write the ${model.label} on the cable.`)
      }

      /*
       * Which physical radio is on the cable, asked of the radio.
       *
       * `identHash` cannot answer it - a UV-82 and a UV-9R send the same ident
       * - so the three spans CHIRP compares before uploading calibration are
       * read now, off the radio, and the backup has to be of the same unit.
       * Read here rather than taken from the base image, because a base image
       * is what the caller believes the radio holds and this is the check of
       * that belief.
       */
      const liveUnit = new Uint8Array(MEM_SIZE)
      for (const at of unitWindows()) {
        ctx.signal?.throwIfAborted()
        liveUnit.set(await readBlock(t, at, BLOCK_SIZE, false, opts), at)
      }
      const unitNow = await unitHashOf(liveUnit)
      if (!ctx.dryRun && ctx.backup) {
        if (ctx.backup.unitHash == null) {
          throw new BackupRequiredError(
            model.id,
            `The stored backup carries no record of which ${model.label} it came from, so it cannot be shown ` +
              'to belong to this one. Read this radio again to take a fresh one.',
          )
        }
        if (ctx.backup.unitHash !== unitNow) {
          throw new BackupRequiredError(
            model.id,
            `The stored backup came from a different ${model.label}. Read this one before writing to it.`,
          )
        }
      }

      /*
       * And the image being written has to be this radio's too.
       *
       * The backup check above binds the way back to the radio; this binds the
       * image. A restore hands over a backup and nothing else, and the screen
       * that calls this passes that image's own fingerprint as the backup's -
       * but the driver is what enforces, so the image's three spans are held
       * to the radio's here rather than trusted to a caller.
       */
      if ((await unitHashOf(next)) !== unitNow) {
        throw new WriteBlockedError(
          `This image was read from a different ${model.label} than the one on the cable. Read this radio ` +
            'before writing to it.',
        )
      }

      /*
       * What to diff against.
       *
       * An ordinary write supplies the image the radio was read from, and it
       * has to be this radio's: the same three spans as the radio on the cable.
       * A restore supplies none, on purpose - it expects the radio to differ -
       * so the owned part of the radio is read first and used as the base,
       * which keeps a restore to what actually differs and keeps it inside the
       * ranges this driver understands.
       */
      const supplied = ctx.baseImage ? locate(ctx.baseImage, 0)?.region.data : undefined
      let base: Uint8Array
      if (supplied) {
        if (supplied.length !== next.length) {
          throw new DriverError('The edited image is a different size to the one that was read')
        }
        if ((await unitHashOf(supplied)) !== unitNow) {
          throw new WriteBlockedError(
            `The codeplug this edit was built on was read from a different ${model.label} than the one on ` +
              'the cable. Read this radio and make the edit again.',
          )
        }
        base = supplied

        /*
         * Prove this build understands the bytes the edit was built on.
         *
         * `encode(decode(img), img) === img` is the invariant the encoder rests
         * on, and it is asserted in tests against captured images. Here it is
         * asserted against the image this edit was made from - read from this
         * radio in this session, which the unit check above has just tied to
         * the radio on the cable - and what it catches is bytes this build
         * cannot represent: a record with no empty marker whose receive
         * frequency is not a frequency, or a transmit frequency that is
         * neither a frequency nor a receive-only filling. An edit built on
         * those would carry this build's misreading of them to the radio.
         *
         * It is not a model check, and nothing on the wire can be one. A
         * BF-A58S answers this magic with this ident, and its High and Low are
         * the UV-9R's selectors, so its bytes round-trip cleanly; a power
         * selector of 3 survives too, because the encoder keeps it. What says
         * the radio is a UV-9R is the connect screen's choice, as CHIRP's
         * model list says it for CHIRP.
         *
         * A restore skips this, deliberately. What it sends is the backup's
         * own bytes, not the encoder's output, so whether this build
         * round-trips what the radio holds now is beside the point - and
         * refusing on it would block exactly the recovery a restore is for,
         * after another program has left something odd on the radio.
         */
        const asImage: RadioImage = { ...image, regions: [{ start: 0, data: base, readOnly: false, label: 'image' }] }
        const roundTrip = locate(driver.encode(driver.decode(asImage), asImage), 0)?.region.data
        if (!roundTrip || !equalBytes(roundTrip, base)) {
          const at = roundTrip ? roundTrip.findIndex((x, i) => x !== base[i]) : -1
          throw new WriteBlockedError(
            `This build does not round-trip what was read from this radio: byte 0x${at.toString(16)} changes ` +
              `when it is decoded and re-encoded. That usually means the radio is not a ${model.label}. ` +
              'It can still be read and backed up.',
          )
        }
      } else {
        base = next.slice()
        const top = Math.max(...wp970iOwnedRanges().map(([, e]) => e))
        for (let addr = 0; addr < top; addr += BLOCK_SIZE) {
          ctx.signal?.throwIfAborted()
          base.set(await readBlock(t, addr, BLOCK_SIZE, false, opts), addr)
          ctx.progress?.({ phase: 'read', done: addr + BLOCK_SIZE, total: top, label: 'Reading what is on the radio now' })
        }
      }

      const owned = wp970iOwnedRanges()
      const inside = (ranges: readonly (readonly [number, number])[], from: number, to: number) =>
        ranges.some(([s, e]) => from >= s && to <= e)

      /*
       * The ownership check is about the encoder, so it runs where the encoder
       * produced the image: against a base the edit was built on. A change
       * outside the owned ranges there is a defect in boofwang wherever it
       * lands. A restore is not the encoder's output, and the radio is
       * expected to differ from it everywhere - VFOs, squelch tables - so
       * there only the owned ranges are compared, and only they are sent.
       */
      if (supplied) {
        for (let off = 0; off < MEM_SIZE; off += WRITE_BLOCK_SIZE) {
          const to = off + WRITE_BLOCK_SIZE
          if (inside(owned, off, to)) continue
          if (!equalBytes(base.subarray(off, to), next.subarray(off, to))) {
            throw new DriverError(
              `Refusing to write: byte 0x${off.toString(16)} changed but sits outside the ranges this ` +
                'driver claims to understand. That is a defect in boofwang, not in your codeplug.',
            )
          }
        }
      }

      /*
       * Send every owned block, or only the ones that changed.
       *
       * Which one is the member's `writesWholeImage`, and this family sets it:
       * every write is a contiguous sweep of the three owned ranges, in
       * address order, the way CHIRP's `_upload` sends `_ranges` and never a
       * diff. No write has been sent to one of these radios by boofwang, so
       * nothing here says a sparse write is safe, and CLAUDE.md names what
       * the reference sends as the best prior. The UV-5R is why that is not a
       * formality: a byte there programs once, a diff left the tail of a
       * shortened name behind, and only the sweep put it back.
       *
       * Nothing at all is sent when no owned block differs. A sweep exists to
       * make an edit land, and with no edit there is nothing for it to land -
       * rewriting 259 blocks with the bytes they already hold would only be
       * risk.
       */
      const sweep = schema.capabilities.writesWholeImage === true
      const changed = (off: number) => !equalBytes(base.subarray(off, off + WRITE_BLOCK_SIZE), next.subarray(off, off + WRITE_BLOCK_SIZE))
      const anyChanged = owned.some(([s, e]) => {
        for (let off = s; off < e; off += WRITE_BLOCK_SIZE) if (changed(off)) return true
        return false
      })
      const blocks: { addr: number; data: Uint8Array }[] = []
      for (const [s, e] of anyChanged ? owned : []) {
        for (let off = s; off < e; off += WRITE_BLOCK_SIZE) {
          const to = off + WRITE_BLOCK_SIZE
          // A ceiling, asserted in a test as well: nothing boofwang sends is
          // something CHIRP's own upload would not also send.
          if (!inside(CHIRP_UPLOAD_RANGES, off, to)) {
            throw new DriverError(`Refusing to write 0x${off.toString(16)}: CHIRP never uploads that address.`)
          }
          if (!sweep && !changed(off)) continue
          blocks.push({ addr: off, data: next.slice(off, to) })
        }
      }

      const operations: WriteOperation[] = blocks.map((b) => ({
        addr: b.addr,
        length: WRITE_BLOCK_SIZE,
        label: `0x${b.addr.toString(16).padStart(4, '0')}`,
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
      const withReport = (e: unknown) => {
        if (e instanceof Error) {
          ;(e as Error & { partial?: WriteReport }).partial = {
            blocksWritten: sent,
            bytesWritten: sent * WRITE_BLOCK_SIZE,
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
            done: sent * WRITE_BLOCK_SIZE,
            total: blocks.length * WRITE_BLOCK_SIZE,
            label: `0x${b.addr.toString(16).padStart(4, '0')}`,
          })
        }
      } catch (e) {
        throw withReport(e)
      }

      /*
       * Read every block back before calling the write done, at the size the
       * read path uses.
       *
       * An acknowledgment says a frame arrived, not that it landed. And a
       * sixteen-byte read is not a check here: the UV-5R answers one at an
       * address with another block's bytes while echoing the address it was
       * asked for, so each written block is compared against the 0x40 window
       * it falls in, read once.
       */
      const windows = new Map<number, Uint8Array>()
      try {
        for (const [i, b] of blocks.entries()) {
          ctx.signal?.throwIfAborted()
          const at = b.addr - (b.addr % BLOCK_SIZE)
          let window = windows.get(at)
          if (!window) {
            window = await readBlock(t, at, BLOCK_SIZE, false, opts)
            windows.set(at, window)
          }
          const from = b.addr - at
          const got = window.subarray(from, from + WRITE_BLOCK_SIZE)
          if (!equalBytes(got, b.data)) {
            const first = got.findIndex((x, j) => x !== b.data[j])
            throw new WriteVerifyError(
              b.addr,
              hexDump(b.data.subarray(first, first + 8), 8),
              hexDump(got.subarray(first, first + 8), 8),
              i,
              // Everything is sent, then everything is verified.
              true,
            )
          }
          ctx.progress?.({
            phase: 'verify',
            done: (i + 1) * WRITE_BLOCK_SIZE,
            total: blocks.length * WRITE_BLOCK_SIZE,
            label: `0x${b.addr.toString(16).padStart(4, '0')}`,
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
      if (image.radioId !== model.id) throw new DriverError(`Not a ${model.label} image: ${image.radioId}`)
      const found = locate(image, 0)
      if (!found || found.region.data.length < MEM_SIZE) throw new DriverError(`${model.label} image has no memory region`)
      const mem = found.region.data

      const cp = emptyCodeplug(model.id, image.createdAt)
      cp.meta.title = `${model.label} codeplug`
      cp.meta.variant = image.variant

      for (let i = 0; i < CHANNEL_COUNT; i++) {
        const ch = decodeChannel(mem, i, model.schema)
        if (ch) cp.channels.set(ch.index, ch)
      }
      cp.settings = decodeSettings(mem)
      return cp
    },

    encode(doc: Codeplug, base: RadioImage): RadioImage {
      if (doc.radio !== model.id) throw new DriverError(`Not a ${model.label} codeplug: ${doc.radio}`)
      if (base.radioId !== model.id) throw new DriverError(`Not a ${model.label} image: ${base.radioId}`)

      const found = locate(base, 0)
      if (!found || found.region.data.length < MEM_SIZE) throw new DriverError(`${model.label} image has no memory region`)

      // A copy of the bytes the radio gave, patched in place. There is no way
      // to build one from nothing, and the nine undecoded bytes after every
      // name, the calibration and every other span nobody has explained
      // survive only because they are carried through.
      const mem = found.region.data.slice()

      for (let i = 0; i < CHANNEL_COUNT; i++) {
        encodeChannel(mem, i, doc.channels.get(i + 1) ?? null, model.schema)
      }
      encodeSettings(mem, doc.settings)

      return {
        ...base,
        createdAt: new Date().toISOString(),
        regions: base.regions.map((r) => (r.start === found.region.start ? { ...r, data: mem } : r)),
      }
    },

    validate(doc: Codeplug): Diagnostic[] {
      return validateCodeplug(doc, model.schema)
    },

    ownedRanges: (regionStart: number) => (regionStart === 0 ? wp970iOwnedRanges() : []),

    // The sweep in `writeImage` walks the owned ranges and nothing else, so
    // they are also what a write sends. A test holds the two together.
    sweptRanges: (regionStart: number) => (regionStart === 0 ? wp970iOwnedRanges() : []),
  }

  return driver
}

/** The 0x40 windows that hold `UNIT_AREAS`: 0x1F00, 0x1F40 and 0x1F80. */
function unitWindows(): number[] {
  const out = new Set<number>()
  for (const [s, e] of UNIT_AREAS) {
    for (let a = s - (s % BLOCK_SIZE); a < e; a += BLOCK_SIZE) out.add(a)
  }
  return [...out].sort((a, b) => a - b)
}

// ------------------------------------------------------------------ channels --

/** The power level a raw `lowpower` value means, or High where the table has no entry. */
function levelForRaw(schema: RadioSchema, raw: number): PowerLevel {
  return schema.rf.powerLevels.find((l) => l.raw === raw) ?? schema.rf.powerLevels[0]!
}

/**
 * The level a channel asks for, in this radio's table.
 *
 * The exact level first - label and wattage both - because a channel decoded
 * from this radio, or edited against its schema, carries one. Then the same
 * wattage under another label. Then the highest level at or below what was
 * asked for, never silently more power, and the lowest level when every one
 * is above it. A label alone is not trusted: "High" is 4 W on a UV-82 and 5 W
 * here, and a channel copied across should not gain a watt by its name.
 */
function levelFor(schema: RadioSchema, power: Channel['power']): PowerLevel {
  const levels = schema.rf.powerLevels
  return (
    levels.find((l) => l.label === power.label && l.mW === power.mW) ??
    levels.find((l) => l.mW === power.mW) ??
    clampPower(schema, power.mW)
  )
}

/** Two tone specifications that mean the same thing on the air. */
function sameTone(a: ToneSpec | null, b: ToneSpec | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'ctcss' && b.kind === 'ctcss') return a.deciHz === b.deciHz
  if (a.kind === 'dtcs' && b.kind === 'dtcs') return a.code === b.code && a.polarity === b.polarity
  return false
}

/** Whether `freq` and `tx` fall in one of CHIRP's `VALID_BANDS` together. */
function sameBand(freq: number, tx: number): boolean {
  return VALID_BANDS.some(([lo, hi]) => freq >= lo && freq <= hi && tx >= lo && tx <= hi)
}

/** Decode one channel record, or null when the slot is empty. */
export function decodeChannel(mem: Uint8Array, i: number, schema: RadioSchema = UV9R_SCHEMA): Channel | null {
  const addr = channelAddr(i)

  /*
   * Empty is the first byte alone, which is CHIRP's test
   * (`_mem.get_raw()[:1] == b"\xff"`) and the factory's own: every unused
   * slot on the UV-9R captures reads `ff 00 57 15 00 00 57 15 ...`, a stale
   * 155.700 MHz record behind a single 0xFF. A whole-record check would read
   * a hundred of them as programmed channels.
   */
  if (mem[addr] === 0xff) return null

  const raw = WP970I_CHANNEL.read(mem, addr)
  if (!Number.isFinite(raw.rxFreq) || raw.rxFreq === 0) return null

  const rxFreq = hz(raw.rxFreq)

  /*
   * Receive-only is either filling, which is `_is_txinh` in baofeng_common.py:
   * `FF FF FF FF` or `00 00 00 00`. (uv5r.py took only the first until CHIRP
   * commit 52953a87c8, 2026-10-18, "Expand txinh to cover both observed
   * cases"; the two families now agree.) A transmit frequency that is neither
   * and is not valid BCD is read as receive-only too - CHIRP would compute a
   * nonsense frequency from it and call the channel transmit-capable, and
   * reading a channel as less capable than CHIRP does is the safe direction.
   */
  const txBytes = mem.subarray(addr + 0x04, addr + 0x08)
  let tx: TxSpec = { kind: 'simplex' }
  let txAllowed = true
  let txInhibitReason: string | undefined

  if (txBytes.every((b) => b === 0xff)) {
    txAllowed = false
    txInhibitReason = 'Transmit frequency is filled with 0xFF'
  } else if (txBytes.every((b) => b === 0x00)) {
    txAllowed = false
    txInhibitReason = 'Transmit frequency is zero'
  } else if (!Number.isFinite(raw.txFreq)) {
    txAllowed = false
    txInhibitReason = 'Transmit frequency is not a frequency'
  } else if (raw.txFreq !== raw.rxFreq) {
    // `get_memory`: a split when the two are in different `VALID_BANDS`, a
    // shift when they share one - asked of CHIRP's bands, not of a display
    // band plan, so a GMRS repeater pair reads as +5 MHz on every member.
    if (!sameBand(raw.rxFreq, raw.txFreq)) {
      tx = { kind: 'split', txFreq: hz(raw.txFreq) }
    } else {
      const delta = raw.txFreq - raw.rxFreq
      tx = { kind: 'offset', direction: delta > 0 ? 'plus' : 'minus', offset: hz(Math.abs(delta)) }
    }
  }

  const rx = decodeToneWord(raw.rxTone)
  const txTone = decodeToneWord(raw.txTone)
  const tone: TonePair = rx === null && txTone === null ? NO_TONE : { rx, tx: txTone, rxInverted: false }

  const level = levelForRaw(schema, raw.f0e.lowPower)

  return {
    index: i + 1,
    name: WP970I_NAME.read(mem, nameAddr(i)).name,
    rxFreq,
    tx,
    txAllowed,
    ...(txInhibitReason === undefined ? {} : { txInhibitReason }),
    tone,
    modulation: 'FM',
    // `wide` is 1 for wide, as in uv5r.py:
    // `mem.mode = _mem.wide and "FM" or "NFM"`.
    bandwidthHz: raw.f0f.wide ? BANDWIDTH_WIDE_HZ : BANDWIDTH_NARROW_HZ,
    power: { mW: level.mW, label: level.label },
    // No per-channel step is stored; the radio uses its global one.
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

/**
 * Write one channel back into the image, in place.
 *
 * The inverse of `decodeChannel`, and a partial patch for the same reason the
 * UV-82's is: every bit the decoder does not model keeps what the radio had.
 * Three fields go further than that and are left alone unless they actually
 * change - the power selector, so a value no table has survives a channel
 * whose power nobody touched; each tone word, so a spelling of "no tone" the
 * encoder would not choose survives; and the name, whose field is idempotent.
 */
export function encodeChannel(mem: Uint8Array, i: number, ch: Channel | null, schema: RadioSchema = UV9R_SCHEMA): void {
  const addr = channelAddr(i)

  if (ch === null) {
    /*
     * An empty slot is marked by its first byte, and the rest is left exactly
     * as found - which is how the factory itself leaves a hundred slots on
     * every UV-9R capture. CHIRP's `set_memory` fills both records with 0xFF
     * instead; the first byte is the part every reader agrees on, and the
     * rest would be bytes this build invented.
     */
    if (mem[addr] === 0xff) return
    mem[addr] = 0xff
    WP970I_NAME.write(mem, nameAddr(i), { name: '' })
    return
  }

  /*
   * A slot that was empty is programmed from zeros, the way `set_memory`
   * programs every record.
   *
   * Behind an empty marker is either erased flash - 0xFF throughout, where
   * every unknown bit, every icon flag and the power selector read as set -
   * or the factory's stale 155.700 MHz template. Patching either would carry
   * those bits into a live channel: on an erased slot the selector reads 3,
   * which decodes as High, so a new High channel kept the 3 that CHIRP cannot
   * even read, and the tone words kept 0xFFFF. An adversarial review found it,
   * on the first erased slot of every capture. A programmed record is still
   * patched, which is what keeps the bits nobody has explained.
   */
  if (mem[addr] === 0xff) mem.fill(0x00, addr, addr + WP970I_CHANNEL.size)

  // Captured before the struct write, so the receive-only rule below can tell
  // an edited record from a pure round trip.
  const before = mem.slice(addr, addr + WP970I_CHANNEL.size)
  const current = WP970I_CHANNEL.read(mem, addr)
  const target = levelFor(schema, ch.power)
  const lowPower = levelForRaw(schema, current.f0e.lowPower).id === target.id ? current.f0e.lowPower : target.raw

  const rxTone = sameTone(decodeToneWord(current.rxTone), ch.tone.rx)
    ? current.rxTone
    : encodeToneWord(ch.tone.rx, `Channel ${ch.index} receive tone`)
  const txTone = sameTone(decodeToneWord(current.txTone), ch.tone.tx)
    ? current.txTone
    : encodeToneWord(ch.tone.tx, `Channel ${ch.index} transmit tone`)

  WP970I_CHANNEL.write(mem, addr, {
    rxFreq: ch.rxFreq,
    ...(ch.txAllowed ? { txFreq: txFrequency(ch) ?? ch.rxFreq } : {}),
    rxTone,
    txTone,
    f0e: { lowPower },
    f0f: {
      wide: ch.bandwidthHz >= BANDWIDTH_WIDE_HZ ? 1 : 0,
      scan: ch.skip === 'skip' ? 0 : 1,
      bcl: Number(ch.extras.vendor?.busyChannelLockout ?? 0) ? 1 : 0,
      pttId: Number(ch.extras.vendor?.pttId ?? 0) & 0x03,
    },
    f0c: { scode: Number(ch.extras.vendor?.scode ?? 0) & 0x0f },
  })

  /*
   * Receive-only is written as `FF FF FF FF`, on every record that changed.
   *
   * `_is_txinh` in baofeng_common.py reads `00 00 00 00` as receive-only too,
   * so a zero filling decodes the same either way. Writing is another matter:
   * `set_memory` writes 0xFF for duplex "off", every time, and 0xFF is the only
   * filling anyone has sent to one of these radios and seen honored. Whether
   * the firmware treats a zero transmit frequency as no transmit at all is
   * not something CHIRP's parser can say. So a record that changed for any
   * reason gets the 0xFF filling - one write block either way, since the
   * record is exactly one - and only a record byte-identical to what was read
   * keeps a zero filling, which is what keeps `encode(decode(image), image)`
   * exact. boofwang never writes the zero spelling; it can only pass one on.
   *
   * Anything that is neither filling is a transmit frequency, and is replaced
   * whatever else changed: that is the channel that could transmit, marked
   * receive-only in the editor.
   */
  if (!ch.txAllowed) {
    const txBytes = mem.subarray(addr + 0x04, addr + 0x08)
    const marked = txBytes.every((b) => b === 0xff) || txBytes.every((b) => b === 0x00)
    const untouched = equalBytes(mem.subarray(addr, addr + WP970I_CHANNEL.size), before)
    if (!marked || !untouched) mem.fill(0xff, addr + 0x04, addr + 0x08)
  }

  WP970I_NAME.write(mem, nameAddr(i), { name: ch.name.slice(0, NAME_LENGTH) })
}

// ------------------------------------------------------------------ settings --

/**
 * The settings block, flattened the way the UV-82 driver flattens it.
 *
 * Same struct, same keys, at this family's address. Bit groups become dotted
 * keys - `f2a.fmradio` - and the unknown runs are decoded too, so a test can
 * compare every byte with CHIRP's parser rather than only the ones a form
 * offers.
 */
export function decodeSettings(mem: Uint8Array): Record<string, unknown> {
  if (mem.length < MEM_SIZE) return {}

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(WP970I_SETTINGS.read(mem, SETTINGS_BASE))) {
    if (value instanceof Uint8Array) continue
    if (typeof value === 'object' && value !== null) {
      for (const [bit, v] of Object.entries(value as Record<string, number>)) out[`${key}.${bit}`] = v
      continue
    }
    out[key] = value
  }

  for (const [key, value] of Object.entries(WP970I_POWERON_MSG.read(mem, POWERON_MSG_BASE))) {
    out[`poweronMsg.${key}`] = typeof value === 'string' ? value.trimEnd() : value
  }
  return out
}

/**
 * Patch the settings back, and only where they differ.
 *
 * The UV-82 driver's rule: values of the wrong type are dropped rather than
 * coerced, because a settings map can come from an imported file. The power-on
 * message is decoded and never written - CHIRP uploads it, at 0x1EE0, but it
 * is outside every range this driver claims, and a control whose change could
 * not reach the radio is worse than none.
 */
export function encodeSettings(mem: Uint8Array, settings: Codeplug['settings']): void {
  if (mem.length < MEM_SIZE) return

  const current = WP970I_SETTINGS.read(mem, SETTINGS_BASE) as Record<string, unknown>
  const patch: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(settings)) {
    if (typeof value !== 'number') continue
    const dot = key.indexOf('.')
    if (dot < 0) {
      if (!(key in current) || typeof current[key] !== 'number') continue
      if (current[key] === value) continue
      patch[key] = value
      continue
    }
    const group = key.slice(0, dot)
    const bit = key.slice(dot + 1)
    const held = current[group]
    if (typeof held !== 'object' || held === null || !(bit in held)) continue
    if ((held as Record<string, number>)[bit] === value) continue
    const merged = (patch[group] as Record<string, number> | undefined) ?? {}
    merged[bit] = value
    patch[group] = merged
  }

  if (Object.keys(patch).length > 0) WP970I_SETTINGS.write(mem, SETTINGS_BASE, patch)
}
