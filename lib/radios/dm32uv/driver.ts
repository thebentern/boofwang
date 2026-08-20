// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump, sha256Hex } from '../../codec/checksum.js'
import { equalBytes } from '../../codec/struct.js'
import { emptyCodeplug, type Channel, type Codeplug, type TxSpec } from '../../model/index.js'
import { NO_TONE, type TonePair } from '../../model/tones.js'
import { hz } from '../../model/units.js'
import { txFrequency } from '../../model/channel.js'
import {
  DEFAULT_DRIVER_TIMEOUT_MS,
  BackupRequiredError,
  DriverError,
  ImageRadioMismatchError,
  WriteBlockedError,
  WriteVerifyError,
  type Diagnostic,
  type DriverCtx,
  type IdentifyResult,
  type RadioDriver,
  type WriteOperation,
  type WriteReport,
} from '../../radio/driver.js'
import type { RadioImage } from '../../radio/image.js'
import type { RadioSchema } from '../../radio/schema.js'
import type { Transport } from '../../transport/transport.js'
import { blockData, blockIds, logicalAddress } from './image.js'
import { cloneImage } from '../../radio/image.js'
import {
  CALL_TYPE_ALL,
  CALL_TYPE_GROUP,
  CALL_TYPE_PRIVATE,
  CHANNEL_BLOCK_FIRST,
  CHANNEL_BLOCK_LAST,
  CHANNEL_HEADER,
  CHANNEL_SIZE,
  DM32_CHANNEL,
  DM32_KEY_SLOT,
  DM32_TALKGROUP,
  DM32_ZONE,
  ENCRYPTION_TYPES,
  KEY_BLOCK,
  KEY_SLOTS,
  ZONE_BLOCK_FIRST,
  ZONE_BLOCK_LAST,
  decodeToneWord,
  encodeToneWord,
  KEY_AREA,
  ZONE_HEADER,
  ZONE_SIZE,
  isKeySlotEmpty,
  keySlotOffset,
  talkgroupOffset,
  TALKGROUP_BLOCK_FIRST,
  TALKGROUP_BLOCK_LAST,
} from './layout.js'
import { isAllocated, scanPageMap } from './pagemap.js'
import {
  PAGE_SIZE,
  VFRAME_BUILD_DATE,
  VFRAME_CONFIG_RANGE,
  VFRAME_FIRMWARE,
  enterProgrammingMode,
  handshake,
  parseRange,
  readPage,
  vframe,
  writePage,
} from './protocol.js'
import { DM32UV_SCHEMA, DM32UV_SERIAL } from './schema.js'

/** Calibration. Factory-set per unit, never written, and the unit fingerprint. */
const CALIBRATION_BLOCK = 0x02

const dec = new TextDecoder()

export interface Dm32uvDriverOptions {
  /**
   * Allow this driver to write encryption keys.
   *
   * A constructor option rather than a mutable flag, so the schema the UI
   * renders and the capability `writeImage` enforces cannot disagree. Even when
   * enabled, only the key slots are writable - see KEY_AREA.
   */
  enableWrite?: boolean
}

/** One 4 KiB page this driver is prepared to send, with the bytes it wants there. */
interface WriteTarget {
  blockId: number
  desired: { start: number; data: Uint8Array }
  label: string
}

/**
 * The blocks to write, in ascending order of what they can cost you.
 *
 * Talk group and zone records are names. A channel record decides where the
 * radio transmits. The key slots are secret material that cannot be read back
 * and checked by eye. If the fifth page fails, the four safer ones are already
 * on the radio, which is the right way round.
 *
 * A block absent from the image is skipped rather than fabricated - this radio
 * allocates only the pages it uses, and inventing one would write 4 KiB of
 * whatever we happened to have over a page the radio never asked for.
 */
function writeTargets(image: RadioImage): WriteTarget[] {
  const out: WriteTarget[] = []
  const add = (blockId: number, label: string) => {
    const region = image.regions.find((r) => r.start === logicalAddress(blockId))
    if (region) out.push({ blockId, desired: region, label })
  }

  for (let id = TALKGROUP_BLOCK_FIRST; id <= TALKGROUP_BLOCK_LAST; id++) {
    add(id, `block 0x${id.toString(16)} (talk groups)`)
  }
  for (let id = ZONE_BLOCK_FIRST; id <= ZONE_BLOCK_LAST; id++) {
    add(id, `block 0x${id.toString(16)} (zones)`)
  }
  for (let id = CHANNEL_BLOCK_FIRST; id <= CHANNEL_BLOCK_LAST; id++) {
    add(id, `block 0x${id.toString(16)} (channels)`)
  }
  add(KEY_BLOCK, `block 0x${KEY_BLOCK.toString(16)} (encryption keys)`)
  return out
}

/** Whether two pages agree across every range this driver claims to understand. */
function unchangedWithin(
  a: Uint8Array,
  b: Uint8Array,
  owned: ReadonlyArray<readonly [number, number]>,
): boolean {
  for (const [from, to] of owned) {
    for (let i = from; i < to; i++) {
      if (a[i] !== b[i]) return false
    }
  }
  return true
}

/**
 * Merge the bytes the user actually changed onto the page the radio holds now.
 *
 * `desired` is `encode(doc, base)`, so it differs from `base` exactly where the
 * user edited. Copying only those bytes means a change someone made on the
 * radio's own keypad since the image was read survives the write, instead of
 * being quietly reverted to whatever the codeplug was holding. With no base to
 * compare against, the whole owned range is written - that is the plain
 * "put this image on the radio" case.
 */
function mergeOwned(
  live: Uint8Array,
  desired: Uint8Array,
  base: Uint8Array | undefined,
  owned: ReadonlyArray<readonly [number, number]>,
): Uint8Array {
  const merged = live.slice()
  for (const [from, to] of owned) {
    for (let i = from; i < to; i++) {
      if (base && desired[i] === base[i]) continue
      merged[i] = desired[i]!
    }
  }
  return merged
}

/**
 * Merge the key area a whole slot at a time.
 *
 * Byte granularity is wrong here in a way it is not elsewhere: half of an old
 * key and half of a new one is a key that decrypts nothing, and unlike a
 * channel you cannot look at the radio and see that it is wrong.
 *
 * Copying the whole key area from our image would silently revert the other
 * slots to whatever they held when it was read. That is a real sequence: read
 * on Monday, change a key on the radio itself, then open Monday's backup, edit
 * one slot and write - and the untouched keys quietly go back in time.
 */
function mergeKeySlots(live: Uint8Array, desired: Uint8Array, base: Uint8Array | undefined): Uint8Array {
  const merged = live.slice()
  for (let slot = 1; slot <= KEY_SLOTS; slot++) {
    const off = keySlotOffset(slot)
    const next = desired.subarray(off, off + DM32_KEY_SLOT.size)
    // Without a base to compare against, fall back to the live page: a slot
    // that already matches needs no write either way.
    const previous = base?.subarray(off, off + DM32_KEY_SLOT.size) ?? live.subarray(off, off + DM32_KEY_SLOT.size)
    if (equalBytes(next, previous)) continue
    merged.set(next, off)
  }
  return merged
}

export function createDm32uvDriver(options: Dm32uvDriverOptions = {}): RadioDriver {
  const schema: RadioSchema = options.enableWrite
    ? {
        ...DM32UV_SCHEMA,
        status: 'beta',
        capabilities: {
          ...DM32UV_SCHEMA.capabilities,
          write: true,
          /*
           * Still a scope, just a wider one. The write now reaches channel
           * records, zone names, talk groups and key slots - but not the
           * channel-count header, so channels cannot be added or removed, and
           * not settings, contacts, scan lists or RX groups, which this build
           * has never decoded. Saying "read and write" without qualification
           * would present a restore of four block ranges as a full rollback of
           * a 59-block radio.
           */
          writeScope: 'channels, zone names, talk groups and encryption keys',
        },
      }
    : DM32UV_SCHEMA

  const driver: RadioDriver = {
    id: 'dm32uv',
    schema,
    serial: { ...DM32UV_SERIAL, signals: { ...DM32UV_SERIAL.signals } },
    /**
     * There is no command to leave programming mode: the radio exits when the
     * port closes. An interrupted session therefore needs a power cycle, and
     * the UI has to say so rather than pretending it can tidy up.
     */
    abortPolicy: 'power-cycle',
    writeBlockBytes: PAGE_SIZE,

    /**
     * The calibration block, which is factory-set per unit.
     *
     * This is the only per-unit data this radio exposes: no documented V-frame
     * carries a serial number, and every field in `identHash` describes the
     * firmware rather than the radio.
     */
    async unitFingerprint(image: RadioImage): Promise<string | null> {
      const cal = image.regions.find((r) => r.start === logicalAddress(CALIBRATION_BLOCK))
      return cal ? await sha256Hex(cal.data) : null
    },

    match(info) {
      const KNOWN_BRIDGES = [0x1a86, 0x067b, 0x10c4, 0x0403]
      return info.usbVendorId !== undefined && KNOWN_BRIDGES.includes(info.usbVendorId) ? 'possible' : 'no'
    },

    async identify(t: Transport, ctx: DriverCtx = {}): Promise<IdentifyResult> {
      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      ctx.progress?.({ phase: 'handshake', done: 0, total: 1, label: 'Saying hello' })
      const { model } = await handshake(t, opts)

      const firmware = dec.decode(await vframe(t, VFRAME_FIRMWARE, 0x00, opts)).replace(/\0/g, '').trim()
      const buildDate = dec.decode(await vframe(t, VFRAME_BUILD_DATE, 0x00, opts)).replace(/\0/g, '').trim()
      // The configuration region's extent is queried, never assumed: it differs
      // between units, and everything else is addressed relative to it.
      const config = parseRange(await vframe(t, VFRAME_CONFIG_RANGE, 0x00, opts))

      ctx.log?.info(`DM-32UV ${model} firmware ${firmware} (${buildDate}), config region 0x${config.start.toString(16)}-0x${config.end.toString(16)}`)
      ctx.progress?.({ phase: 'handshake', done: 1, total: 1, label: firmware })

      return {
        radioId: 'dm32uv',
        variant: firmware,
        layout: model,
        raw: new TextEncoder().encode(`${model}|${firmware}|${buildDate}`),
        caps: {
          read: true,
          // Report what this build can actually do. Hardcoding `false` here
          // outlived the write path: the gate raised "this firmware cannot be
          // written" the instant a radio connected, while the write it was
          // describing went ahead - because nothing on the write path consulted
          // caps at all. Both halves of that are fixed; this is the half that
          // makes the answer true.
          write: schema.capabilities.write,
        },
        identHash: await sha256Hex(new TextEncoder().encode(`dm32uv|${model}|${firmware}|${buildDate}`)),
        meta: { model, buildDate, configStart: config.start, configEnd: config.end },
      }
    },

    async readImage(t: Transport, ident: IdentifyResult, ctx: DriverCtx = {}): Promise<RadioImage> {
      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      const start = ident.meta?.configStart as number
      const end = ident.meta?.configEnd as number
      if (typeof start !== 'number' || typeof end !== 'number') {
        throw new DriverError('The radio did not report where its configuration region lives')
      }

      await enterProgrammingMode(t, opts)

      const totalPages = Math.floor((end - start + 1) / PAGE_SIZE)
      ctx.progress?.({ phase: 'scan', done: 0, total: totalPages, label: 'Finding the memory map' })
      const map = await scanPageMap(t, start, end, {
        ...opts,
        progress: (done, total) => ctx.progress?.({ phase: 'scan', done, total, label: 'Finding the memory map' }),
      })

      // Every allocated page is captured, including the 22 of 59 whose meaning
      // is undocumented. A backup that holds only what we understand is not a
      // backup, and round-trip fidelity depends on carrying the rest verbatim.
      const allocated = [...map.physOf.entries()].sort((a, b) => a[0] - b[0])
      const regions = []
      const placements: { blockId: number; physical: number }[] = []

      let done = 0
      for (const [blockId, physical] of allocated) {
        ctx.signal?.throwIfAborted()
        const data = await readPage(t, physical, blockId, opts)
        regions.push({
          start: logicalAddress(blockId),
          data,
          readOnly: blockId === 0x02,
          label: `block 0x${blockId.toString(16).padStart(2, '0')}`,
        })
        placements.push({ blockId, physical })
        done++
        ctx.progress?.({
          phase: 'read',
          done,
          total: allocated.length,
          label: `block 0x${blockId.toString(16).padStart(2, '0')}`,
        })
      }

      const flat = new Uint8Array(regions.length * PAGE_SIZE)
      regions.forEach((r, i) => flat.set(r.data, i * PAGE_SIZE))

      return {
        radioId: 'dm32uv',
        variant: ident.variant,
        layout: ident.layout,
        createdAt: new Date().toISOString(),
        regions,
        meta: {
          model: ident.meta?.model,
          buildDate: ident.meta?.buildDate,
          configStart: start,
          configEnd: end,
          placements,
          freePages: map.free.length,
          supersededPages: map.superseded.length,
        },
        sha256: await sha256Hex(flat),
      }
    },

    /**
     * Send the changed pages back to the radio, one 4 KiB page at a time.
     *
     * The order matters and every step earns its place on this radio:
     *
     * 1. A verified backup of *this* radio is required, and the driver refuses
     *    without it. There is no way back from a bad write otherwise.
     * 2. The page map is rediscovered. Physical addresses are assigned by a
     *    translation layer and move between sessions, so the address a block
     *    lived at when it was read may belong to something else now.
     * 3. Each live page is re-read and its tail byte checked. If it no longer
     *    identifies as the block we meant, the map moved underneath us and the
     *    write stops rather than guessing.
     * 4. Only {@link RadioDriver.ownedRanges} is merged onto those live bytes,
     *    and within that only the bytes the user actually changed. Everything
     *    this build does not understand - the ~3 KB after the key slots, the
     *    channel-count header, the tail byte itself - comes from the radio, not
     *    from our image, so a stale image cannot damage what it cannot read.
     * 5. Each page is read back and compared. Because the translation layer may
     *    relocate a page on write, the map is rescanned before verifying, and
     *    the rescan is kept for the pages still to come.
     *
     * Pages go out least dangerous first - talk groups, zone names, channels,
     * then key slots - so that a failure part way through has committed the
     * cheapest changes rather than the most expensive.
     */
    async writeImage(t: Transport, image: RadioImage, ctx: DriverCtx = {}): Promise<WriteReport> {
      if (image.radioId !== 'dm32uv') throw new DriverError(`Not a DM-32UV image: ${image.radioId}`)
      if (!schema.capabilities.write && !ctx.dryRun) {
        throw new WriteBlockedError(`the ${schema.model}. Writing is not enabled in this build`)
      }
      if (!ctx.dryRun && !ctx.backup) throw new BackupRequiredError('dm32uv')

      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal }

      // Every block this build claims to understand, in ascending risk order:
      // talk groups and zone names are names, channel records key a
      // transmitter, and the key slots are secret material. If a later block
      // fails, the earlier and safer ones are already committed.
      const targets = writeTargets(image)
      if (targets.length === 0) {
        throw new DriverError(
          'This image has none of the blocks boofwang can write, so there is nothing to send. ' +
            'Read the radio again before writing.',
        )
      }

      // Reuse the session's identification rather than repeating the
      // handshake. This radio's is stateful - a second PSEARCH on an
      // already-handshaken port is answered with silence.
      const ident = ctx.ident ?? (await driver.identify(t, ctx))

      // Honour the per-firmware refusal channel. `caps.write` is how a driver
      // says "this particular firmware must not be written" - the UV-K5 uses it
      // for layouts it does not understand - and it was inert here because
      // nothing below the UI read it. A future DM-32UV firmware marked
      // unwritable would otherwise have been written anyway.
      if (!ctx.dryRun && !ident.caps.write) {
        throw new WriteBlockedError(
          ident.caps.reason ?? `firmware ${ident.variant}, which this build cannot write`,
        )
      }
      if (ctx.backup && ctx.backup.identHash !== ident.identHash) throw new BackupRequiredError('dm32uv')

      const start = ident.meta?.configStart as number
      const end = ident.meta?.configEnd as number
      await enterProgrammingMode(t, opts)

      ctx.progress?.({ phase: 'scan', done: 0, total: 1, label: 'Finding the memory map' })
      const map = await scanPageMap(t, start, end, {
        ...opts,
        progress: (done, total) => ctx.progress?.({ phase: 'scan', done, total, label: 'Finding the memory map' }),
      })

      // Confirm this is the radio the image came from.
      //
      // identHash covers model, firmware and build date - all properties of the
      // firmware, not of the unit - so on its own it would let a backup of one
      // DM-32UV unlock writing to another. There is no serial number in any
      // documented V-frame, but calibration is factory-set per unit and the
      // image already contains it, so comparing that settles it. Skipped only
      // when the image predates the check and has no calibration block.
      const calWanted = image.regions.find((r) => r.start === logicalAddress(CALIBRATION_BLOCK))
      const calPhysical = map.physOf.get(CALIBRATION_BLOCK)
      if (calPhysical === undefined) {
        throw new DriverError(
          'The radio did not report a calibration block, so there is no way to tell which unit this is. ' +
            'Read the radio again before writing.',
        )
      }
      if (!calWanted) {
        // Refuse rather than skip. This is the only per-unit check there is, and
        // an image without calibration used to slip past it silently - which is
        // exactly the case where confirming the unit matters most.
        throw new DriverError(
          'This codeplug carries no calibration block, so it cannot be matched to a particular radio. ' +
            'Read this radio again and edit that codeplug instead.',
        )
      }
      const calLive = await readPage(t, calPhysical, CALIBRATION_BLOCK, opts)
      if (!equalBytes(calLive, calWanted.data)) {
        throw new ImageRadioMismatchError(
          'a DM-32UV whose calibration differs',
          `the one this codeplug was read from`,
        )
      }

      // And the backup has to be of *this* unit too.
      //
      // The check above binds the codeplug to the radio; this one binds the way
      // back to it. `identHash` cannot do this - it is a hash of model,
      // firmware and build date, so two DM-32UVs on the same firmware are
      // indistinguishable by it - which meant a user with two identical radios
      // could write one while the only stored backup belonged to the other.
      if (!ctx.dryRun && ctx.backup) {
        const backupUnit = ctx.backup.unitHash
        if (backupUnit == null) {
          throw new BackupRequiredError(
            'dm32uv: the stored backup predates per-unit checking, so it cannot be shown to belong to ' +
              'this radio. Read this radio again to take a fresh one.',
          )
        }
        if (backupUnit !== (await sha256Hex(calLive))) {
          throw new BackupRequiredError(
            'dm32uv: the stored backup came from a different DM-32UV. Read this one before writing to it.',
          )
        }
      }

      let blocksWritten = 0
      let bytesWritten = 0
      let verified = true
      const operations: WriteOperation[] = []
      // The page map is re-read after every write, because a write can relocate
      // pages. `physOf` is the current one.
      let physOf = map.physOf

      // Everything already sent, so an error below can say so rather than
      // letting the caller believe nothing was changed.
      const withReport = (e: unknown) => {
        if (e instanceof Error) {
          ;(e as Error & { partial?: WriteReport }).partial = {
            blocksWritten,
            bytesWritten,
            verified: false,
            dryRun: ctx.dryRun === true,
            operations: [...operations],
          }
        }
        return e
      }

      for (let n = 0; n < targets.length; n++) {
        const { blockId, desired, label } = targets[n]!

        const physical = physOf.get(blockId)
        if (physical === undefined) {
          throw withReport(
            new DriverError(
              `The radio has no page for ${label}. Read it again before writing.`,
            ),
          )
        }

        const base = ctx.baseImage?.regions.find((r) => r.start === logicalAddress(blockId))?.data
        const owned = driver.ownedRanges(logicalAddress(blockId))

        // If the user changed nothing in this block, do not even read it. The
        // merge below would produce the live page unchanged and skip it anyway,
        // so this is the same outcome without ~60 page reads to rename one
        // channel. Only safe because `desired` is `encode(doc, base)`: it
        // differs from `base` exactly where the user edited.
        if (base && unchangedWithin(desired.data, base, owned)) {
          operations.push({ addr: physical, length: PAGE_SIZE, label, skipped: 'unchanged' })
          continue
        }

        // The live bytes are the base for the merge, never our stored image.
        const live = await readPage(t, physical, blockId, opts)

        const merged =
          blockId === KEY_BLOCK
            ? mergeKeySlots(live, desired.data, base)
            : mergeOwned(live, desired.data, base, owned)
        merged[PAGE_SIZE - 1] = blockId // the tail byte is never ours to change

        // Belt and braces: nothing outside the ranges this driver claims may
        // differ from the live page. If it does, the merge is wrong and the
        // write must not happen.
        for (let i = 0; i < PAGE_SIZE; i++) {
          if (merged[i] === live[i]) continue
          if (owned.some(([from, to]) => i >= from && i < to)) continue
          throw withReport(
            new DriverError(
              `Refusing to write: the merge would change byte 0x${i.toString(16)} of ${label}, which is ` +
                'outside the range boofwang understands. That is a defect in boofwang, not in your codeplug.',
            ),
          )
        }

        const operation: WriteOperation = { addr: physical, length: PAGE_SIZE, label }

        if (equalBytes(merged, live)) {
          operations.push({ ...operation, skipped: 'unchanged' })
          continue
        }

        if (ctx.dryRun) {
          blocksWritten++
          bytesWritten += PAGE_SIZE
          verified = false
          operations.push(operation)
          continue
        }

        ctx.progress?.({ phase: 'write', done: n, total: targets.length, label })
        await writePage(t, physical, merged, opts)
        blocksWritten++
        bytesWritten += PAGE_SIZE
        operations.push(operation)

        try {
          // Verify. The page may have been relocated by the write, so find it
          // again rather than assuming it stayed put.
          ctx.progress?.({ phase: 'verify', done: n, total: targets.length, label })
          const after = await scanPageMap(t, start, end, opts)
          const nowAt = after.physOf.get(blockId)
          if (nowAt === undefined) {
            throw new WriteVerifyError(physical, `${label} present`, 'the block vanished from the map', blocksWritten)
          }
          // Keep the map current: a relocation moves other pages too, and the
          // next block in this loop must not be written to a stale address.
          physOf = after.physOf
          const readBack = await readPage(t, nowAt, blockId, opts)
          // Compare the whole page. All 4096 bytes were sent, so verifying only
          // the ones we meant to change would call a page verified while the
          // rest went unchecked.
          if (!equalBytes(readBack, merged)) {
            const at = readBack.findIndex((b, i) => b !== merged[i])
            throw new WriteVerifyError(
              nowAt,
              hexDump(merged.subarray(at, at + 16), 16),
              hexDump(readBack.subarray(at, at + 16), 16),
              blocksWritten,
            )
          }
        } catch (e) {
          throw withReport(e)
        }
      }

      ctx.progress?.({ phase: 'verify', done: targets.length, total: targets.length, label: 'Done' })
      return { blocksWritten, bytesWritten, verified, dryRun: ctx.dryRun === true, operations }
    },

    decode(image: RadioImage): Codeplug {
      if (image.radioId !== 'dm32uv') throw new DriverError(`Not a DM-32UV image: ${image.radioId}`)

      const cp = emptyCodeplug('dm32uv', image.createdAt)
      cp.meta.title = 'DM-32UV codeplug'
      cp.meta.variant = image.variant

      for (const ch of decodeChannels(image)) cp.channels.set(ch.index, ch)
      cp.zones = decodeZones(image)
      cp.talkGroups = decodeTalkGroups(image)
      cp.encryptionKeys = decodeKeys(image)
      return cp
    },

    /**
     * Serialise a codeplug onto a copy of the image it came from.
     *
     * Only the encryption key slots are written; every other byte of every
     * block comes through from the base untouched. That is not a limitation of
     * the encoder so much as the whole safety argument for this radio - see
     * KEY_AREA in layout.ts.
     */
    encode(doc: Codeplug, base: RadioImage): RadioImage {
      if (base.radioId !== 'dm32uv') throw new DriverError(`Not a DM-32UV image: ${base.radioId}`)
      if (doc.radio !== null && doc.radio !== 'dm32uv') {
        throw new DriverError(`This codeplug is for the ${doc.radio}, not the DM-32UV`)
      }
      const out = cloneImage(base)
      const block = out.regions.find((r) => r.start === logicalAddress(KEY_BLOCK))
      if (!block) throw new DriverError('This image has no block 0x10, so it holds no encryption keys')

      encodeKeys(block.data, doc.encryptionKeys)

      /*
       * Channels, zone names and talk groups, each patched in place.
       *
       * Every one of these writes only the fields the decoder reads. The bytes
       * nobody has modelled - and on this radio that is most of them, 22 of 59
       * allocated blocks having no documented meaning - survive because they
       * are never assigned, not because they are copied somewhere safe.
       */
      const channelBlock = (id: number) => out.regions.find((r) => r.start === logicalAddress(id))?.data
      const firstChannels = channelBlock(CHANNEL_BLOCK_FIRST)
      if (firstChannels) {
        const total = firstChannels[0]! | (firstChannels[1]! << 8)
        let index = 0
        for (let id = CHANNEL_BLOCK_FIRST; id <= CHANNEL_BLOCK_LAST && index < total; id++) {
          const data = channelBlock(id)
          if (!data) continue
          const base2 = id === CHANNEL_BLOCK_FIRST ? CHANNEL_HEADER : 0
          const capacity = Math.floor((PAGE_SIZE - base2 - 1) / CHANNEL_SIZE)
          for (let i = 0; i < capacity && index < total; i++, index++) {
            const ch = doc.channels.get(index + 1)
            if (ch) encodeChannel(data, base2 + i * CHANNEL_SIZE, ch)
          }
        }
      }

      encodeZones(out, doc.zones)
      encodeTalkGroups(out, doc.talkGroups)

      return { ...out, sha256: '' }
    },

    validate(doc: Codeplug): Diagnostic[] {
      const out: Diagnostic[] = []
      const keySlots = new Set(doc.encryptionKeys.map((k) => k.slot))
      for (const ch of doc.channels.values()) {
        const band = DM32UV_SCHEMA.rf.bands.find((b) => ch.rxFreq >= b.loHz && ch.rxFreq <= b.hiHz)
        if (!band) {
          out.push({
            severity: 'error',
            ruleId: 'radio.band.rx-out-of-range',
            channel: ch.index,
            field: 'rxFreq',
            message: `${(ch.rxFreq / 1e6).toFixed(5)} MHz is outside both bands this radio covers.`,
          })
        }
        const keyId = ch.extras.vendor?.encryptionKeyId
        if (keyId !== undefined && keyId !== '0' && !keySlots.has(Number(keyId))) {
          out.push({
            severity: 'error',
            ruleId: 'dmr.encryption.key-missing',
            channel: ch.index,
            field: 'encryptionKeyId',
            message: `This channel uses encryption key ${keyId}, but that slot is empty.`,
          })
        }
      }
      return out
    },

    /**
     * The key slots in block 0x10, and nothing else anywhere.
     *
     * Everything outside this is read and preserved but never written, which is
     * what makes a stale or partly-understood image harmless.
     */
    /**
     * The bytes this driver claims to understand, per block.
     *
     * Deliberately per-block rather than one range: a DM-32UV image is 59
     * pages, most of them undocumented, and claiming a span that crosses one
     * would assert understanding of pages nobody has read. A change outside
     * these is a defect in the encoder, and on this radio that is the only
     * thing standing between a bug and 22 blocks of unrecoverable memory.
     */
    ownedRanges: (regionStart: number) => {
      if (regionStart === logicalAddress(KEY_BLOCK)) return [KEY_AREA]

      const blockId = regionStart >>> 12
      if (blockId >= CHANNEL_BLOCK_FIRST && blockId <= CHANNEL_BLOCK_LAST) {
        const base = blockId === CHANNEL_BLOCK_FIRST ? CHANNEL_HEADER : 0
        return [[base, PAGE_SIZE - 1] as const]
      }
      if (blockId >= ZONE_BLOCK_FIRST && blockId <= ZONE_BLOCK_LAST) {
        const base = blockId === ZONE_BLOCK_FIRST ? ZONE_HEADER : 0
        return [[base, PAGE_SIZE - 1] as const]
      }
      if (blockId >= TALKGROUP_BLOCK_FIRST && blockId <= TALKGROUP_BLOCK_LAST) {
        return [[0, PAGE_SIZE - 1] as const]
      }
      return []
    },
  }

  return driver
}

// ------------------------------------------------------------------ decode --

export function decodeChannels(image: RadioImage): Channel[] {
  const first = blockData(image, CHANNEL_BLOCK_FIRST)
  if (!first) return []

  // The first channel block's header carries the total count as a 16-bit word.
  const total = first[0]! | (first[1]! << 8)
  const out: Channel[] = []

  let index = 0
  for (let blockId = CHANNEL_BLOCK_FIRST; blockId <= CHANNEL_BLOCK_LAST && index < total; blockId++) {
    const data = blockData(image, blockId)
    if (!data) continue
    // Only the first block is offset by a header.
    const base = blockId === CHANNEL_BLOCK_FIRST ? CHANNEL_HEADER : 0
    const capacity = Math.floor((PAGE_SIZE - base - 1) / CHANNEL_SIZE)

    for (let i = 0; i < capacity && index < total; i++, index++) {
      const ch = decodeChannel(data, base + i * CHANNEL_SIZE, index + 1)
      if (ch) out.push(ch)
    }
  }
  return out
}

export function decodeChannel(data: Uint8Array, offset: number, index: number): Channel | null {
  const raw = DM32_CHANNEL.read(data, offset)
  if (!Number.isFinite(raw.rxFreq) || raw.rxFreq === 0) return null

  const rxFreq = hz(raw.rxFreq)
  const txAllowed = raw.mode.txForbid === 0

  let tx: TxSpec = { kind: 'simplex' }
  if (Number.isFinite(raw.txFreq) && raw.txFreq !== 0 && raw.txFreq !== raw.rxFreq) {
    const delta = raw.txFreq - raw.rxFreq
    tx = { kind: 'offset', direction: delta > 0 ? 'plus' : 'minus', offset: hz(Math.abs(delta)) }
  }

  // Channel mode lives in the high nibble: 0/2 analog, 1/3 digital.
  const digital = raw.mode.channelMode === 1 || raw.mode.channelMode === 3
  // Both directions. The transmit word was parsed by the layout and then never
  // read, so every analog channel exported as receive-tone-only - which for a
  // repeater channel means it will not key the repeater, and nothing says so.
  const rxTone = digital ? null : decodeToneWord(raw.rxTone)
  const txTone = digital ? null : decodeToneWord(raw.txTone)
  const tone: TonePair =
    rxTone || txTone ? { rx: rxTone, tx: txTone, rxInverted: false } : NO_TONE

  // Bits 2-1 hold 0=Low, 1=Medium, 2=High. 3 is undefined by the reference;
  // clamp rather than index off the end of the table.
  const levels = DM32UV_SCHEMA.rf.powerLevels
  const level = levels[Math.min(raw.mode.power, levels.length - 1)]!

  return {
    index,
    name: raw.name.trimEnd(),
    rxFreq,
    tx,
    txAllowed,
    ...(txAllowed ? {} : { txInhibitReason: 'Transmit forbidden on this channel' }),
    tone,
    modulation: digital ? 'DMR' : 'FM',
    bandwidthHz: raw.scan.bandwidth ? 25_000 : 12_500,
    power: { mW: level.mW, label: level.label },
    tuningStep: hz(12_500),
    skip: 'none',
    comment: '',
    extras: {
      vendor: {
        colorCode: String(raw.digital.colorCode),
        timeSlot: String(raw.digital.timeSlot + 1),
        encryptionKeyId: String(raw.encryptionKeyId),
        encryptEnabled: String(raw.digital.encryptEnable),
        radioIdIndex: String(raw.radioIdIndex),
        loneWorker: String(raw.mode.loneWorker),
        scanAdd: String(raw.scan.scanAdd),
        scanList: String(raw.scan.scanList),
      },
    },
  }
}


/**
 * Write one channel record back, in place.
 *
 * The exact inverse of {@link decodeChannel}, and a partial patch: the four
 * unknown bits in the mode byte, the three in the digital byte, the contact
 * index, the scan-list membership and everything else this build does not model
 * keep whatever the radio had. That is what makes `encode(decode(image), image)`
 * byte-identical, and it is the only honest way to write to a radio where 22 of
 * 59 allocated blocks have no documented meaning.
 */
export function encodeChannel(data: Uint8Array, offset: number, ch: Channel): void {
  const digital = ch.modulation === 'DMR'
  const current = DM32_CHANNEL.read(data, offset)

  // Preserve whichever analog/digital spelling the radio already used: the mode
  // nibble has two values for each, and normalising them would rewrite bytes to
  // say what they already said.
  const wasDigital = current.mode.channelMode === 1 || current.mode.channelMode === 3
  const channelMode = wasDigital === digital ? current.mode.channelMode : digital ? 1 : 0

  const vendor = ch.extras.vendor ?? {}
  const num = (key: string, fallback: number) => {
    const v = Number(vendor[key])
    return Number.isFinite(v) ? v : fallback
  }

  // Where the radio should transmit, independent of whether it may. A
  // receive-only channel keeps whatever pair the radio had stored.
  const txSplit = ch.txAllowed ? (txFrequency(ch) ?? ch.rxFreq) : null

  // The highest level the radio offers that does not exceed what was asked
  // for. Comparing against one threshold picked the wrong level as soon as
  // there were three of them.
  const levels = DM32UV_SCHEMA.rf.powerLevels
  let power = 0
  for (let i = 0; i < levels.length; i++) {
    if (ch.power.mW >= levels[i]!.mW) power = i
  }

  DM32_CHANNEL.write(data, offset, {
    name: ch.name,
    rxFreq: ch.rxFreq,
    // `txFrequency` answers "where would this radio transmit", and returns null
    // for a receive-only channel before it ever looks at the offset. Falling
    // back to the receive frequency therefore overwrote the stored transmit
    // frequency of every receive-only channel with its own receive frequency -
    // so clearing the receive-only flag later would key up on the wrong pair.
    // The transmit gate is byte 0x18 bit 3; the transmit frequency is not it.
    ...(txSplit === null ? {} : { txFreq: txSplit }),
    mode: {
      channelMode,
      txForbid: ch.txAllowed ? 0 : 1,
      power,
      loneWorker: num('loneWorker', current.mode.loneWorker) & 0x01,
    },
    scan: {
      bandwidth: ch.bandwidthHz >= 25_000 ? 1 : 0,
      scanAdd: num('scanAdd', current.scan.scanAdd) & 0x01,
      scanList: num('scanList', current.scan.scanList) & 0x0f,
    },
    digital: {
      encryptEnable: num('encryptEnabled', current.digital.encryptEnable) ? 1 : 0,
      timeSlot: Math.max(0, num('timeSlot', current.digital.timeSlot + 1) - 1) & 0x01,
      colorCode: num('colorCode', current.digital.colorCode) & 0x0f,
    },
    // A digital channel has no analog tones; leaving the words alone keeps a
    // channel that was switched to DMR from losing what it had if it is
    // switched back.
    ...(digital ? {} : { rxTone: encodeToneWord(ch.tone.rx), txTone: encodeToneWord(ch.tone.tx) }),
    encryptionKeyId: num('encryptionKeyId', current.encryptionKeyId) & 0xff,
    radioIdIndex: num('radioIdIndex', current.radioIdIndex) & 0xff,
  })
}

export function decodeZones(image: RadioImage): Codeplug['zones'] {
  const first = blockData(image, ZONE_BLOCK_FIRST)
  if (!first) return []

  // Corrected against hardware: the count is a single byte. Reading a 16-bit
  // word here reports 1796 for what are plainly four zones.
  const total = first[0]!
  const out: Codeplug['zones'] = []

  let index = 0
  for (let blockId = ZONE_BLOCK_FIRST; blockId <= ZONE_BLOCK_LAST && index < total; blockId++) {
    const data = blockData(image, blockId)
    if (!data) continue
    const base = blockId === ZONE_BLOCK_FIRST ? ZONE_HEADER : 0
    const capacity = Math.floor((PAGE_SIZE - base - 1) / ZONE_SIZE)

    for (let i = 0; i < capacity && index < total; i++, index++) {
      const rec = DM32_ZONE.read(data, base + i * ZONE_SIZE)
      const name = rec.name.trimEnd()
      const count = Math.min(rec.channelCount, 64)
      const channels: number[] = []
      for (let c = 0; c < count; c++) {
        channels.push(rec.channels[c * 2]! | (rec.channels[c * 2 + 1]! << 8))
      }
      if (name || channels.length) out.push({ id: `zone-${index + 1}`, name, channels })
    }
  }
  return out
}

export function decodeTalkGroups(image: RadioImage): Codeplug['talkGroups'] {
  const out: Codeplug['talkGroups'] = []
  for (let blockId = TALKGROUP_BLOCK_FIRST; blockId <= TALKGROUP_BLOCK_LAST; blockId++) {
    const data = blockData(image, blockId)
    if (!data) continue
    for (let n = 1; ; n++) {
      const off = talkgroupOffset(n)
      if (off + DM32_TALKGROUP.size > PAGE_SIZE - 1) break
      const rec = DM32_TALKGROUP.read(data, off)
      const name = rec.name.trimEnd()
      if (!name && rec.number === 0) continue
      out.push({
        id: `tg-${blockId}-${n}`,
        name,
        number: rec.number,
        callType: rec.callType === CALL_TYPE_ALL ? 'allCall' : rec.callType === CALL_TYPE_PRIVATE ? 'private' : 'group',
      })
    }
  }
  return out
}

/**
 * Write key slots into a copy of block 0x10.
 *
 * A slot absent from the codeplug is cleared to the erased pattern the radio
 * itself uses - id byte, then 0xFF - rather than zeroed, so a cleared slot
 * looks to the radio exactly like one that was never programmed.
 */
/**
 * Whether `decodeKeys` would turn the record at `off` into a key.
 *
 * Shared so that the encoder's idea of "this slot is in the document" cannot
 * drift from the decoder's. Any record the decoder skips must be preserved
 * verbatim rather than erased.
 */
function decodesToKey(block: Uint8Array, off: number): boolean {
  if (isKeySlotEmpty(block.subarray(off, off + DM32_KEY_SLOT.size))) return false
  const rec = DM32_KEY_SLOT.read(block, off)
  return (ENCRYPTION_TYPES[rec.type] ?? 'none') !== 'none'
}


/**
 * Write the zone names back.
 *
 * Only the name is written. A zone's channel list is a set of indices into the
 * channel array, and rewriting it means understanding what the radio does when
 * a zone points at a slot that has since been emptied - which nothing here has
 * established. The name is unambiguous and the membership is left exactly as
 * the radio had it.
 */
export function encodeZones(image: RadioImage, zones: Codeplug['zones']): void {
  const first = blockData(image, ZONE_BLOCK_FIRST)
  if (!first) return
  const total = first[0]!

  let index = 0
  let docIndex = 0
  for (let blockId = ZONE_BLOCK_FIRST; blockId <= ZONE_BLOCK_LAST && index < total; blockId++) {
    const data = blockData(image, blockId)
    if (!data) continue
    const base = blockId === ZONE_BLOCK_FIRST ? ZONE_HEADER : 0
    const capacity = Math.floor((PAGE_SIZE - base - 1) / ZONE_SIZE)

    for (let i = 0; i < capacity && index < total; i++, index++) {
      // Mirror the decoder's skip. `decodeZones` walks every record up to the
      // count but pushes only those with a name or channels, so the nth record
      // is not the nth zone in the document. Advancing both counters together
      // wrote zone 2's name onto record 3 the moment any record was empty.
      const off = base + i * ZONE_SIZE
      const rec = DM32_ZONE.read(data, off)
      if (!rec.name.trimEnd() && Math.min(rec.channelCount, 64) === 0) continue

      const zone = zones[docIndex]
      docIndex++
      if (!zone) continue
      DM32_ZONE.write(data, off, { name: zone.name })
    }
  }
}

/**
 * Write the talk group records back.
 *
 * Name, number and call type - the three fields the decoder reads. Everything
 * else in the 24-byte record is left alone. The traversal mirrors the decoder's
 * exactly, including its skip of empty slots, so the nth talk group in the
 * document lands on the nth record the decoder produced.
 */
export function encodeTalkGroups(image: RadioImage, groups: Codeplug['talkGroups']): void {
  let index = 0
  for (let blockId = TALKGROUP_BLOCK_FIRST; blockId <= TALKGROUP_BLOCK_LAST; blockId++) {
    const data = blockData(image, blockId)
    if (!data) continue
    for (let n = 1; ; n++) {
      const off = talkgroupOffset(n)
      if (off + DM32_TALKGROUP.size > PAGE_SIZE - 1) break
      const rec = DM32_TALKGROUP.read(data, off)
      if (!rec.name.trimEnd() && rec.number === 0) continue

      const group = groups[index]
      index++
      if (!group) continue

      DM32_TALKGROUP.write(data, off, {
        name: group.name,
        number: group.number,
        callType:
          group.callType === 'allCall'
            ? CALL_TYPE_ALL
            : group.callType === 'private'
              ? CALL_TYPE_PRIVATE
              : CALL_TYPE_GROUP,
      })
    }
  }
}

export function encodeKeys(block: Uint8Array, keys: Codeplug['encryptionKeys']): void {
  const bySlot = new Map(keys.map((k) => [k.slot, k]))
  const typeOf = (name: string) =>
    Number(Object.entries(ENCRYPTION_TYPES).find(([, v]) => v === name)?.[0] ?? 0)

  for (let slot = 1; slot <= KEY_SLOTS; slot++) {
    const off = keySlotOffset(slot)
    const key = bySlot.get(slot)

    if (!key || key.type === 'none' || key.keyHex.length === 0) {
      // A slot that is already empty is left exactly as it is.
      //
      // Writing an erase pattern over it would fabricate bytes, which is the
      // one thing this encoder must never do: `decode` skips empty slots, so
      // every untouched empty slot would come back as a difference and break
      // `encode(decode(image), image) === image`. It would also send hundreds
      // of bytes of "change" to a radio whose key table is mostly unused.
      if (isKeySlotEmpty(block.subarray(off, off + DM32_KEY_SLOT.size))) continue

      // A slot the decoder could not interpret is left alone too.
      //
      // `decodeKeys` skips a record whose type byte is not one it recognises,
      // so such a slot never reaches the document - and "absent from the
      // document" is indistinguishable here from "deleted by the user". Erasing
      // on that basis would destroy a working key on any radio or firmware that
      // uses a type this build has not seen, which is the same class of mistake
      // as assuming there were eight key slots. Preserving it costs nothing:
      // the user cannot have edited what was never shown to them.
      if (!decodesToKey(block, off)) continue

      // A slot that had content, decodes cleanly, and is no longer in the
      // document was cleared deliberately. Erase it the way the radio does:
      // every unused record in the key table of a real DM-32UV is 44 zero
      // bytes, not the 0x00-then-0xFF filler the specification suggests.
      block.fill(0x00, off, off + DM32_KEY_SLOT.size)
      continue
    }

    const material = new Uint8Array(32)
    for (let i = 0; i < 32 && i * 2 + 1 < key.keyHex.length; i++) {
      material[i] = Number.parseInt(key.keyHex.slice(i * 2, i * 2 + 2), 16)
    }

    DM32_KEY_SLOT.write(block, off, {
      id: slot,
      name: key.name.slice(0, 10),
      type: typeOf(key.type),
      keyField: material,
    })
  }
}

export function decodeKeys(image: RadioImage): Codeplug['encryptionKeys'] {
  const data = blockData(image, KEY_BLOCK)
  if (!data) return []
  const out: Codeplug['encryptionKeys'] = []

  for (let slot = 1; slot <= KEY_SLOTS; slot++) {
    const off = keySlotOffset(slot)
    const rec = DM32_KEY_SLOT.read(data, off)
    if (isKeySlotEmpty(data.subarray(off, off + DM32_KEY_SLOT.size))) continue

    const type = ENCRYPTION_TYPES[rec.type] ?? 'none'
    if (type === 'none') continue

    // Carried verbatim. The specification's alignment rule is derived from two
    // samples of a short key; a real AES-256 key fills the whole field.
    let keyHex = ''
    for (const b of rec.keyField) keyHex += b.toString(16).padStart(2, '0').toUpperCase()

    out.push({
      id: `key-${slot}`,
      slot,
      name: rec.name.trimEnd(),
      type: type as Codeplug['encryptionKeys'][number]['type'],
      keyHex,
    })
  }
  return out
}

export { blockIds, isAllocated }
