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
import { blockData, blockIds, contactPages, contactsBase, logicalAddress } from './image.js'
import { cloneImage } from '../../radio/image.js'
import {
  ANALOG_BLOCK,
  ANALOG_CONTACT_BASE,
  ANALOG_CONTACT_COUNT_AT,
  ANALOG_CONTACT_SIZE,
  BDC_BASE,
  BDC_COUNT_AT,
  BDC_SIZE,
  CALL_TYPE_ALL,
  CALL_TYPE_GROUP,
  CALL_TYPE_PRIVATE,
  CHANNEL_BLOCK_FIRST,
  CHANNEL_BLOCK_LAST,
  CHANNEL_HEADER,
  CHANNEL_SIZE,
  CONTACTS_PER_PAGE,
  CONTACT_REGION_HEADER,
  CONTACT_SIZE,
  CONTACT_UNKNOWN_13,
  DM32_ANALOG_CONTACT,
  DM32_BDC_CONTACT,
  DM32_CHANNEL,
  DM32_CONTACT,
  DM32_EMERGENCY,
  DM32_KEY_SLOT,
  DM32_MESSAGE,
  DM32_RADIOID,
  DM32_ROAMCHANNEL,
  DM32_ROAMZONE,
  DM32_RXGROUP,
  DM32_SCANLIST,
  DM32_SETTINGS,
  DM32_TALKGROUP,
  DM32_ZONE,
  DTMF_CODE_SIZE,
  DTMF_CODE_SLOTS,
  DTMF_DIGITS,
  DTMF_SPECIAL_BASE,
  DTMF_SPECIAL_SLOTS,
  EMERGENCY_SIZE,
  EMERGENCY_SLOTS,
  ENCRYPTION_TYPES,
  KEY_AREA,
  KEY_BLOCK,
  KEY_SLOTS,
  MESSAGE_BLOCK,
  MESSAGE_MAX_CHARS,
  MESSAGE_SIZE,
  MESSAGE_SLOTS,
  RADIOID_BLOCK,
  RADIOID_HEADER,
  RADIOID_SIZE,
  RADIOID_SLOTS,
  ROAMCHANNEL_BLOCK,
  ROAMCHANNEL_COUNT_AT,
  ROAMCHANNEL_SIZE,
  ROAMCHANNEL_SLOTS,
  ROAMZONE_BLOCK,
  ROAMZONE_HEADER,
  ROAMZONE_SIZE,
  ROAMZONE_SLOTS,
  RXGROUP_BLOCK,
  RXGROUP_HEADER,
  RXGROUP_MAX_MEMBERS,
  RXGROUP_SIZE,
  RXGROUP_SLOTS,
  SCANLIST_BLOCK,
  SCANLIST_HEADER,
  SCANLIST_MAX_MEMBERS,
  SCANLIST_SIZE,
  SETTINGS_BLOCK,
  TALKGROUP_BLOCK_FIRST,
  TALKGROUP_BLOCK_LAST,
  TG_INDEX_BITMASK,
  TG_INDEX_BLOCK,
  TG_INDEX_SLOTS,
  TG_INDEX_TABLE_BY_NAME,
  TG_INDEX_TABLE_BY_NUMBER,
  TXCONTACT_BLOCK_HIGH,
  TXCONTACT_BLOCK_LOW,
  TXCONTACT_HIGH_LIMIT,
  VFO_A,
  VFO_B,
  VFO_BLOCK,
  ZONE_BLOCK_FIRST,
  ZONE_BLOCK_LAST,
  ZONE_HEADER,
  ZONE_MAX_CHANNELS,
  ZONE_SIZE,
  channelSlot,
  contactSlot,
  decodeDtmf,
  decodeToneWord,
  decodeTxContact,
  encodeToneWord,
  encodeTxContact,
  isKeySlotEmpty,
  keySlotOffset,
  messageOffset,
  talkgroupOffset,
  txContactSlot,
} from './layout.js'
import { isAllocated, scanPageMap } from './pagemap.js'
import {
  PAGE_SIZE,
  VFRAME_BUILD_DATE,
  VFRAME_CONFIG_RANGE,
  VFRAME_CONTACTS_RANGE,
  VFRAME_FIRMWARE,
  VFRAME_MAX_CONTACTS,
  enterProgrammingMode,
  handshake,
  parseLE,
  parseOptionalRange,
  parseRange,
  readMemory,
  readPage,
  readRawPage,
  vframe,
  writePage,
} from './protocol.js'
import { DM32UV_SCHEMA, DM32UV_SERIAL } from './schema.js'

/** Calibration. Factory-set per unit, never written, and the unit fingerprint. */
/**
 * What an unprogrammed channel record holds on this radio.
 *
 * Its own unused slots are 0xFF, and the reference calls an empty slot "all
 * 0xFF and/or all 0x00" - so this is what the radio itself writes, not a
 * convention invented here.
 */
const ERASED = 0xff

const CALIBRATION_BLOCK = 0x02

const dec = new TextDecoder()

export interface Dm32uvDriverOptions {
  /**
   * Allow this driver to write.
   *
   * A constructor option rather than a mutable flag, so the schema the UI
   * renders and the capability `writeImage` enforces cannot disagree. Even when
   * enabled the reach is scoped - see `capabilities.writeScope` and
   * `ownedRanges`.
   */
  enableWrite?: boolean
}

/** One 4 KiB page this driver is prepared to send, with the bytes it wants there. */
interface WriteTarget {
  /** The logical block id, or -1 for a raw region that has none. */
  blockId: number
  /** Set only for a raw region, whose address is fixed and needs no page map. */
  addr?: number
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

  add(RADIOID_BLOCK, `block 0x${RADIOID_BLOCK.toString(16)} (radio IDs)`)
  add(RXGROUP_BLOCK, `block 0x${RXGROUP_BLOCK.toString(16)} (RX groups)`)
  for (let id = TALKGROUP_BLOCK_FIRST; id <= TALKGROUP_BLOCK_LAST; id++) {
    add(id, `block 0x${id.toString(16)} (talk groups)`)
  }
  // Immediately after the bank it indexes: it is derived from those records,
  // and committing it against a bank that then fails to write would leave the
  // radio worse off than either change alone.
  add(TG_INDEX_BLOCK, `block 0x${TG_INDEX_BLOCK.toString(16)} (talk group ordering)`)
  for (let id = ZONE_BLOCK_FIRST; id <= ZONE_BLOCK_LAST; id++) {
    add(id, `block 0x${id.toString(16)} (zones)`)
  }
  add(SCANLIST_BLOCK, `block 0x${SCANLIST_BLOCK.toString(16)} (scan lists)`)
  add(MESSAGE_BLOCK, `block 0x${MESSAGE_BLOCK.toString(16)} (text messages)`)
  add(ROAMCHANNEL_BLOCK, `block 0x${ROAMCHANNEL_BLOCK.toString(16)} (roaming channels)`)
  add(ROAMZONE_BLOCK, `block 0x${ROAMZONE_BLOCK.toString(16)} (roaming zone names)`)
  add(ANALOG_BLOCK, `block 0x${ANALOG_BLOCK.toString(16)} (DTMF and analog contacts)`)
  add(TXCONTACT_BLOCK_LOW, `block 0x${TXCONTACT_BLOCK_LOW.toString(16)} (channel talk groups)`)
  add(TXCONTACT_BLOCK_HIGH, `block 0x${TXCONTACT_BLOCK_HIGH.toString(16)} (channel talk groups, high)`)
  // Settings decide how the radio behaves rather than what it can hear, so they
  // go after the lists but before anything that keys a transmitter.
  add(SETTINGS_BLOCK, `block 0x${SETTINGS_BLOCK.toString(16)} (settings)`)
  // The address book. Not a block: a real address, no translation layer, and no
  // logical id in the page. It goes before the channels because nothing in it
  // can make a radio transmit, and after the small lists because it is by far
  // the most bytes.
  for (const [i, page] of contactPages(image).entries()) {
    out.push({
      blockId: -1,
      addr: page.start,
      desired: page,
      label: `contacts page ${i + 1} @ 0x${page.start.toString(16)}`,
    })
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
           * Still a scope, just a much wider one. The write reaches channel
           * records, zones with their channel lists, talk groups, scan list
           * names, RX groups, radio settings, the DMR address book and key
           * slots. It does not reach scan list membership, the talk-group quick
           * index, or the twenty-odd blocks nothing has decoded - so a restore
           * is still not the full rollback the word promises, and this is the
           * field that says so.
           */
          writeScope:
            'channels and their talk groups, zones, talk groups, scan lists, RX groups, contacts, ' +
            'text messages, roaming, emergency system names, DTMF, radio settings and encryption keys',
          /*
           * Read by the restore screen and the write gate, and by nothing else.
           * The connect screen says "Read and write" and stops: this list grew
           * to thirteen clauses, pushed the radio's own name off the row, and
           * opened with "Read" on a driver that writes nearly all of it.
           */
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

      // The address book lives outside the configuration region and is
      // optional: a radio with the feature off answers with an empty range.
      // Asked here rather than at read time because identify is the only place
      // V-frames are safe to send.
      const contacts = parseOptionalRange(await vframe(t, VFRAME_CONTACTS_RANGE, 0x00, opts))
      const maxContacts = contacts ? parseLE(await vframe(t, VFRAME_MAX_CONTACTS, 0x00, opts)) : 0

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
        meta: {
          model,
          buildDate,
          configStart: config.start,
          configEnd: config.end,
          ...(contacts ? { contactsStart: contacts.start, contactsEnd: contacts.end, maxContacts } : {}),
        },
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

      // The address book, if this radio has one and anything is in it.
      //
      // Read count-first and only as far as the count reaches. The region is
      // 4.4 MiB - about seven minutes of serial time - and a radio with no
      // contacts, like the one this was developed against, costs one four-byte
      // read instead.
      const contactsStart = ident.meta?.contactsStart as number | undefined
      const contactsEnd = ident.meta?.contactsEnd as number | undefined
      if (typeof contactsStart === 'number' && typeof contactsEnd === 'number') {
        const head = await readMemory(t, contactsStart, 4, opts)
        const count = parseLE(head)
        const cap = Math.floor((contactsEnd - contactsStart + 1) / CONTACT_SIZE)

        if (count <= cap) {
          // Always at least one page, and always one more than the contacts
          // fill. A page is 4 KiB - a fraction of a second - and without the
          // spare there is nowhere to put a contact the user adds: the encoder
          // can only write pages the reader brought back. Without the floor of
          // one, a radio with an empty address book had no page at all and
          // every added contact was silently dropped.
          const used = count === 0 ? 0 : contactSlot(count - 1).page + 1
          const roomFor = Math.floor((contactsEnd - contactsStart + 1) / PAGE_SIZE)
          const pages = Math.min(Math.max(used + 1, 1), roomFor)
          for (let i = 0; i < pages; i++) {
            ctx.progress?.({ phase: 'read', done: i, total: pages, label: `contacts ${i + 1}/${pages}` })
            const addr = contactsStart + i * PAGE_SIZE
            // Not readPage: this region has no logical block id at 0xFFF, so
            // there is no tail byte to check and that byte is real data.
            const data = await readMemory(t, addr, PAGE_SIZE, opts)
            if (data.length !== PAGE_SIZE) {
              throw new DriverError(`Short contacts page at 0x${addr.toString(16)}`)
            }
            // Not readOnly. That flag means "never send this", which is right
            // for calibration and was right for this region until it became
            // writable - and `diffImages` honours it by routing every change
            // into `unowned`, so leaving it set made the write gate refuse
            // every contact edit as an encoder defect while reporting it as no
            // change at all.
            regions.push({ start: addr, data, label: `contacts page ${i + 1}` })
          }
        } else {
          ctx.log?.info(`The radio reports ${count} contacts but its region holds ${cap}; not reading them.`)
        }
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
          ...(typeof contactsStart === 'number' ? { contactsStart, contactsEnd } : {}),
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
        // A raw region has a fixed address and no entry in the page map: the
        // translation layer does not touch it, so there is nothing to look up
        // and nothing to follow if it moves, because it cannot.
        const raw = targets[n]!.addr !== undefined

        const physical = raw ? targets[n]!.addr! : physOf.get(blockId)
        if (physical === undefined) {
          throw withReport(
            new DriverError(
              `The radio has no page for ${label}. Read it again before writing.`,
            ),
          )
        }

        const regionStart = raw ? desired.start : logicalAddress(blockId)
        const base = ctx.baseImage?.regions.find((r) => r.start === regionStart)?.data
        const owned = driver.ownedRanges(regionStart, image)

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
        //
        // Not readPage for a raw region: that checks the last byte against the
        // logical id, and here that byte is data.
        const live = raw
          ? await readRawPage(t, physical, opts)
          : await readPage(t, physical, blockId, opts)

        // Byte by byte across everything this block owns, then the key slots
        // again a whole slot at a time.
        //
        // Both, not one or the other. Block 0x10 carries the key slots AND the
        // eight emergency system names, and merging only the slots meant an
        // emergency rename was encoded into the image and then quietly dropped
        // on the way to the radio - the third time this project has widened an
        // encoder without widening what carries it.
        const merged = mergeOwned(live, desired.data, base, owned)
        if (blockId === KEY_BLOCK) {
          const keys = mergeKeySlots(live, desired.data, base)
          merged.set(keys.subarray(KEY_AREA[0], KEY_AREA[1]), KEY_AREA[0])
        }
        // The tail byte is never ours to change. On a config page it must read
        // back as the block id; in the address book it is whatever was there.
        if (!raw) merged[PAGE_SIZE - 1] = blockId

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
          ctx.progress?.({ phase: 'verify', done: n, total: targets.length, label })

          // A raw region cannot relocate, so there is no map to rescan - which
          // matters: a rescan is 200 reads, and the address book can be dozens
          // of pages.
          let nowAt = physical
          if (!raw) {
            // The page may have been relocated by the write, so find it again
            // rather than assuming it stayed put.
            const after = await scanPageMap(t, start, end, opts)
            const found = after.physOf.get(blockId)
            if (found === undefined) {
              throw new WriteVerifyError(physical, `${label} present`, 'the block vanished from the map', blocksWritten)
            }
            // Keep the map current: a relocation moves other pages too, and the
            // next block in this loop must not be written to a stale address.
            physOf = after.physOf
            nowAt = found
          }
          const readBack = raw
            ? await readRawPage(t, nowAt, opts)
            : await readPage(t, nowAt, blockId, opts)
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

      const txContacts = decodeTxContacts(image)
      for (const ch of decodeChannels(image)) {
        const tx = txContacts.get(ch.index)
        cp.channels.set(
          ch.index,
          tx ? { ...ch, extras: { ...ch.extras, vendor: { ...ch.extras.vendor, txContact: String(tx.slot) } } } : ch,
        )
      }
      cp.zones = decodeZones(image)
      cp.talkGroups = decodeTalkGroups(image)
      cp.scanLists = decodeScanLists(image)
      cp.rxGroups = decodeRxGroups(image)
      cp.radioIds = decodeRadioIds(image)
      cp.encryptionKeys = decodeKeys(image)
      cp.contacts = decodeContacts(image)
      cp.messages = decodeMessages(image)
      cp.vfo = decodeVfos(image)
      cp.roamChannels = decodeRoamChannels(image)
      cp.roamZones = decodeRoamZones(image)
      cp.emergency = decodeEmergency(image)
      cp.analog = decodeAnalog(image)
      cp.settings = decodeSettings(image)
      return cp
    },

    /**
     * Serialise a codeplug onto a copy of the image it came from.
     *
     * Channel records, zone names, talk groups and key slots are written;
     * every other byte of every block comes through from the base untouched,
     * including the channel-count header and the 22 blocks nothing has
     * decoded. That is not a limitation of the encoder so much as the whole
     * safety argument for this radio - see `ownedRanges`.
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
        const highest = doc.channels.size === 0 ? 0 : Math.max(...doc.channels.keys())

        // Refuse a channel the radio has no page for, rather than putting it in
        // the next page that happens to exist. Block ids are absolute: this
        // radio has channel-bank blocks 0x12-0x14 and then 0x18, so channels
        // 255-509 have nowhere to live on it and saying so is the only honest
        // answer.
        for (const n of doc.channels.keys()) {
          const slot = channelSlot(n)
          if (!slot) {
            throw new DriverError(`Channel ${n} is past the end of this radio's channel bank.`)
          }
          if (!channelBlock(slot.blockId)) {
            throw new DriverError(
              `Channel ${n} needs memory block 0x${slot.blockId.toString(16)}, which this radio has not ` +
                'allocated. Programming it from the radio\'s own menu once will create the block.',
            )
          }
        }

        // Never shrink. Slots are positional on this radio - an empty one still
        // consumes a channel number - so deleting the last channel leaves a gap
        // rather than renumbering every zone and scan list entry that points
        // past it.
        const wanted = Math.max(total, highest)

        for (let n = 1; n <= wanted; n++) {
          const slot = channelSlot(n)
          if (!slot) break
          const data = channelBlock(slot.blockId)
          if (!data) continue
          const ch = doc.channels.get(n)
          if (ch) {
            encodeChannel(data, slot.offset, ch)
            continue
          }
          // No channel here in the document. Erase the slot if it holds one the
          // user deleted, or if the count is about to reach past it; otherwise
          // leave it alone, because a slot the decoder already ignored may hold
          // bytes nobody has explained.
          const held = decodeChannel(data, slot.offset, n) !== null
          if (n > total || held) data.fill(ERASED, slot.offset, slot.offset + CHANNEL_SIZE)
        }

        // The count is a 16-bit little-endian word at the top of the first
        // channel block (reference :37, attested both ways by the read and OEM
        // CPS write captures). Bytes 0x02-0x0F of that header are fill and are
        // not ours to touch.
        firstChannels[0] = wanted & 0xff
        firstChannels[1] = (wanted >> 8) & 0xff
      }

      // Every membership list may only point at a channel that is actually
      // there. Taken from the document rather than from the count, so a slot
      // inside the count that holds no channel is excluded too.
      const live: ReadonlySet<number> = new Set(doc.channels.keys())

      encodeZones(out, doc.zones, live)
      encodeTalkGroups(out, doc.talkGroups)
      encodeTalkGroupIndex(out, doc.talkGroups)
      encodeScanLists(out, doc.scanLists, live)
      encodeRxGroups(out, doc.rxGroups)
      encodeRadioIds(out, doc.radioIds)
      encodeSettings(out, doc.settings)
      encodeContacts(out, doc.contacts)
      encodeTxContacts(out, doc)
      encodeMessages(out, doc.messages)
      encodeVfos(out, doc.vfo)
      encodeRoamChannels(out, doc.roamChannels)
      encodeRoamZones(out, doc.roamZones)
      encodeEmergency(out, doc.emergency)
      encodeAnalog(out, doc.analog)

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
    ownedRanges: (regionStart: number, image?: RadioImage) => {
      // The key slots, and the eight emergency names that share the page.
      if (regionStart === logicalAddress(KEY_BLOCK)) return [...emergencyNameRanges(), KEY_AREA]

      const blockId = regionStart >>> 12
      if (blockId >= CHANNEL_BLOCK_FIRST && blockId <= CHANNEL_BLOCK_LAST) {
        if (blockId !== CHANNEL_BLOCK_FIRST) return [[0, PAGE_SIZE - 1] as const]
        // The first two bytes are the channel count, which has to move for a
        // channel to be added. Bytes 0x02-0x0F of that header are fill in both
        // hardware captures and are deliberately left out.
        return [
          [0, 2] as const,
          [CHANNEL_HEADER, PAGE_SIZE - 1] as const,
        ]
      }
      if (blockId >= ZONE_BLOCK_FIRST && blockId <= ZONE_BLOCK_LAST) {
        if (blockId !== ZONE_BLOCK_FIRST) return [[0, PAGE_SIZE - 1] as const]
        // The count, then the records. The fifteen bytes between them are live
        // radio state - one of them moved on its own between two captures of
        // this radio - and are never written.
        return [
          [0, 1] as const,
          [ZONE_HEADER, PAGE_SIZE - 1] as const,
        ]
      }
      if (blockId >= TALKGROUP_BLOCK_FIRST && blockId <= TALKGROUP_BLOCK_LAST) {
        return [[0, PAGE_SIZE - 1] as const]
      }
      // Every entry in the low TX-contact block is two bytes of the same kind,
      // so the whole page bar its id byte is understood. The high block is read
      // and never written - see encodeTxContacts.
      if (blockId === TXCONTACT_BLOCK_LOW) return [[0, PAGE_SIZE - 1] as const]
      // Not the same claim as 0x42, and deliberately not folded in with it. The
      // tail of 0x43 holds two stale zone records the flash layer left behind -
      // 208 bytes that are demonstrably not contact data - and claiming them
      // would disarm the check that stops a write when a byte moves outside
      // what this build models.
      if (blockId === TXCONTACT_BLOCK_HIGH) return [[0, TXCONTACT_HIGH_LIMIT] as const]
      if (blockId === MESSAGE_BLOCK) return [[0, PAGE_SIZE - 1] as const]
      if (blockId === TG_INDEX_BLOCK) {
        return image ? talkGroupIndexRanges(decodeTalkGroups(image).length) : []
      }
      // Names and codes only. The settings record between the DTMF lists and
      // the zone header beside the count are left to the radio.
      if (blockId === ANALOG_BLOCK) return image ? analogRanges(image) : []
      if (blockId === ROAMZONE_BLOCK) return image ? roamZoneNameRanges(image) : []
      // The records, then the count trailer. The fourteen bytes after it are
      // unexplained and the block id is never ours.
      if (blockId === ROAMCHANNEL_BLOCK) {
        return [
          [0, ROAMCHANNEL_SLOTS * ROAMCHANNEL_SIZE] as const,
          [ROAMCHANNEL_COUNT_AT, ROAMCHANNEL_COUNT_AT + 1] as const,
        ]
      }
      // The scan-list count is the whole page header, so the claim is the page.
      if (blockId === SCANLIST_BLOCK) return [[0, PAGE_SIZE - 1] as const]
      // The RX group occupancy bitmask, then the records. Bytes 0x04-0x10 are a
      // header tail that differs between every capture and stays untouched.
      if (blockId === RXGROUP_BLOCK) {
        return [
          [0, 4] as const,
          [RXGROUP_HEADER, PAGE_SIZE - 1] as const,
        ]
      }
      // The radio-ID count, then the records. Bytes 0x01-0x0F are unexplained.
      if (blockId === RADIOID_BLOCK) {
        return [
          [0, 1] as const,
          [RADIOID_HEADER, PAGE_SIZE - 1] as const,
        ]
      }
      // Settings are scattered through a 4 KiB page, most of which has no
      // established meaning. The claim is exactly the fields that are modelled,
      // taken from the struct rather than restated here.
      if (blockId === SETTINGS_BLOCK) return DM32_SETTINGS.ranges()

      // A contacts page. These are not blocks: the id space stops at 0xFF and
      // this region sits at a real physical address well above it.
      //
      // Which page it is decides what the first four bytes mean - the record
      // count on page 0, the start of a name on every other - and that can only
      // be told from where it sits relative to the rest of the region. Without
      // the image there is no way to know, and claiming nothing is the safe
      // answer: a byte changing outside a claimed range stops the write.
      if (blockId > 0xff) {
        const base = image ? contactsBase(image) : null
        if (base === null || regionStart < base || (regionStart - base) % PAGE_SIZE !== 0) return []
        return contactPageRanges((regionStart - base) / PAGE_SIZE)
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

  for (let n = 1; n <= total; n++) {
    const slot = channelSlot(n)
    if (!slot) break
    // A channel whose block the radio has not allocated simply is not there.
    // Its number still belongs to it, so the ones after it do not move up.
    const data = blockData(image, slot.blockId)
    if (!data) continue
    const ch = decodeChannel(data, slot.offset, n)
    if (ch) out.push(ch)
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
 * Write the zone names and their channel lists back.
 *
 * Membership was held back for a long time on the grounds that nobody had
 * established what the radio does when a zone points at an emptied slot. This
 * radio answered it: `Tactical` has been carrying stale pointers to channels
 * 43-48 past its count for as long as it has been a 14-channel zone, three of
 * those channels do not exist in a 45-channel bank, and the radio shows 14
 * channels. The count byte alone bounds the list.
 *
 * So the rules, each earned:
 *
 * - Entries are absolute 1-based channel numbers. Confirmed by resolving all 45
 *   of this radio's zone entries to named channels.
 * - The tail past the count is left exactly as found. That is what the radio's
 *   own firmware does, and it is the smallest possible diff.
 * - A zero is never written as a terminator. The reference records a hardware
 *   regression from doing so - the radio showed null slots and lost channels.
 * - Entries are written before the count, so an interrupted write leaves the
 *   old shorter count rather than one pointing at half-written slots.
 * - A member outside the channel bank is dropped rather than written, because
 *   the one case still unproven is an in-count entry pointing at a blank record
 *   and the writer can simply never create one.
 */
export function encodeZones(image: RadioImage, zones: Codeplug['zones'], live?: ReadonlySet<number>): void {
  const first = blockData(image, ZONE_BLOCK_FIRST)
  if (!first) return

  // Every zone record slot the image has a page for.
  const slots: { data: Uint8Array; offset: number; n: number }[] = []
  let n = 0
  for (let blockId = ZONE_BLOCK_FIRST; blockId <= ZONE_BLOCK_LAST; blockId++) {
    const data = blockData(image, blockId)
    if (!data) continue
    const base = blockId === ZONE_BLOCK_FIRST ? ZONE_HEADER : 0
    const capacity = Math.floor((PAGE_SIZE - base - 1) / ZONE_SIZE)
    for (let i = 0; i < capacity; i++, n++) slots.push({ data, offset: base + i * ZONE_SIZE, n: n + 1 })
  }
  if (slots.length === 0) return
  if (zones.length > slots.length) {
    throw new DriverError(`This radio holds ${slots.length} zones; the codeplug has ${zones.length}.`)
  }

  // By slot, from the id the decoder issued, so a zone that is removed does not
  // shuffle the ones after it onto different records.
  const taken = new Set<number>()
  const placed = new Map<number, Codeplug['zones'][number]>()
  const fresh: Codeplug['zones'] = []
  for (const zone of zones) {
    const match = /^zone-(\d+)$/.exec(zone.id)
    const at = match ? Number(match[1]) - 1 : -1
    if (at >= 0 && at < slots.length && !taken.has(at)) {
      taken.add(at)
      placed.set(at, zone)
    } else {
      fresh.push(zone)
    }
  }
  for (const zone of fresh) {
    let at = 0
    while (at < slots.length && taken.has(at)) at++
    if (at >= slots.length) throw new DriverError('Every zone slot on this radio is taken.')
    taken.add(at)
    placed.set(at, zone)
  }

  const was = first[0]!
  const highest = taken.size === 0 ? 0 : Math.max(...taken) + 1

  for (let i = 0; i < Math.max(was, highest); i++) {
    const slot = slots[i]
    if (!slot) break
    const zone = placed.get(i)
    if (!zone) {
      // Only clear a record that used to be inside the count.
      if (i < was) DM32_ZONE.write(slot.data, slot.offset, { name: '', channelCount: 0 })
      continue
    }

    const rec = DM32_ZONE.read(slot.data, slot.offset)
    if (!live) {
      DM32_ZONE.write(slot.data, slot.offset, { name: zone.name })
      continue
    }

    // Only channels that are actually there. The one case this radio could not
    // settle is an in-count entry pointing at a blank record, and the writer
    // can simply never create one.
    const members = zone.channels.filter((c) => live.has(c)).slice(0, ZONE_MAX_CHANNELS)
    const entries = rec.channels.slice()
    for (let m = 0; m < members.length; m++) {
      entries[m * 2] = members[m]! & 0xff
      entries[m * 2 + 1] = (members[m]! >> 8) & 0xff
    }
    DM32_ZONE.write(slot.data, slot.offset, { name: zone.name, channels: entries })
    // The count last, so a write interrupted midway leaves the old shorter one
    // rather than one reaching into half-written slots.
    DM32_ZONE.write(slot.data, slot.offset, { channelCount: members.length })
  }

  // The zone count. The fifteen bytes beside it carry live radio state - a
  // cursor this radio moved on its own between two sessions - and are not ours.
  first[0] = highest & 0xff
}

/**
 * Write the talk group records back, placing each at its own physical slot.
 *
 * By slot and not by array position, for the same reason the radio IDs are:
 * this radio's bank has gaps - slots 2, 5, 8 and 9 hold wiped records that keep
 * their call type - and a channel's TX contact points at a slot number. Packing
 * the bank would silently repoint every channel after a gap.
 *
 * There is no count anywhere for talk groups. Occupancy is by content, so
 * adding one is writing a record into a free slot and removing one is clearing
 * it. Block 0x0B, the radio's own index of which slots are live, is regenerated
 * separately and immediately after.
 */
export function encodeTalkGroups(image: RadioImage, groups: Codeplug['talkGroups']): void {
  const slots = talkGroupSlots(image)
  if (slots.length === 0) return
  if (groups.length > slots.length) {
    throw new DriverError(
      `This radio holds ${slots.length} talk groups; the codeplug has ${groups.length}.`,
    )
  }

  const taken = new Set<number>()
  const placed = new Map<number, Codeplug['talkGroups'][number]>()
  const fresh: Codeplug['talkGroups'] = []
  for (const group of groups) {
    const match = /^tg-[0-9a-fx]+-(\d+)$/.exec(group.id)
    const slot = match ? slots.findIndex((s) => s.n === Number(match[1])) : -1
    if (slot >= 0 && !taken.has(slot)) {
      taken.add(slot)
      placed.set(slot, group)
    } else {
      fresh.push(group)
    }
  }
  for (const group of fresh) {
    let at = 0
    while (at < slots.length && taken.has(at)) at++
    if (at >= slots.length) throw new DriverError('Every talk group slot on this radio is taken.')
    taken.add(at)
    placed.set(at, group)
  }

  for (let i = 0; i < slots.length; i++) {
    const { data, offset } = slots[i]!
    const group = placed.get(i)
    if (!group) {
      // Clear a slot the user emptied, and leave one that was never occupied:
      // a record the decoder already ignored may hold bytes nobody has
      // explained, and this radio's wiped slots keep a call type.
      const rec = DM32_TALKGROUP.read(data, offset)
      if (rec.name.trimEnd() || rec.number !== 0) {
        DM32_TALKGROUP.write(data, offset, { name: '', number: 0 })
      }
      continue
    }
    DM32_TALKGROUP.write(data, offset, {
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

/** Every talk group slot the image has a page for, in bank order. */
export function talkGroupSlots(image: RadioImage): { data: Uint8Array; offset: number; n: number }[] {
  const out: { data: Uint8Array; offset: number; n: number }[] = []
  for (let blockId = TALKGROUP_BLOCK_FIRST; blockId <= TALKGROUP_BLOCK_LAST; blockId++) {
    const data = blockData(image, blockId)
    if (!data) continue
    for (let n = 1; ; n++) {
      const offset = talkgroupOffset(n)
      if (offset + DM32_TALKGROUP.size > PAGE_SIZE - 1) break
      out.push({ data, offset, n })
    }
  }
  return out
}

/**
 * Regenerate block 0x0B, the radio's own index of the talk group bank.
 *
 * Five interdependent parts, and they are written together or not at all: two
 * counts, a byte counting the All Call entries, a 128-slot occupancy bitmask
 * where a *cleared* bit means the slot is in use, and two sorted index tables -
 * one in name order, one in DMR-number order.
 *
 * This was decoded and left alone for a long time because a bitmask that
 * disagrees with its tables is a state no observed radio has ever been in. It
 * is written now because talk groups can be added and removed, and a stale
 * index is worse than a regenerated one: the radio would list a talk group that
 * is gone and miss one that is there.
 *
 * Everything between the parts is preserved. The eleven bytes after the counts,
 * the gap before each table and the tail past them are 0xFF in every capture,
 * which is not the same as unused - this codebase learned that in block 0x10,
 * whose supposedly reserved tail turned out to hold pairs nobody can explain.
 */
export function encodeTalkGroupIndex(image: RadioImage, groups: Codeplug['talkGroups']): void {
  const data = blockData(image, TG_INDEX_BLOCK)
  if (!data) return
  if (groups.length > TG_INDEX_SLOTS) {
    throw new DriverError(
      `This build writes at most ${TG_INDEX_SLOTS} talk groups, because the index stores each slot in one byte.`,
    )
  }

  const slots = talkGroupSlots(image)
  // Where each group ended up, as the physical slot number the index stores.
  const live: { slot: number; name: string; number: number; callType: number }[] = []
  for (let i = 0; i < slots.length; i++) {
    const rec = DM32_TALKGROUP.read(slots[i]!.data, slots[i]!.offset)
    const name = rec.name.trimEnd()
    if (!name && rec.number === 0) continue
    live.push({ slot: slots[i]!.n, name, number: rec.number, callType: rec.callType })
  }

  const was = data[0]! | (data[1]! << 8)

  // Counts. The third is the All Call subset; the second is Group Call.
  data[0] = live.length & 0xff
  data[1] = (live.length >>> 8) & 0xff
  const groupCalls = live.filter((g) => g.callType === CALL_TYPE_GROUP).length
  data[2] = groupCalls & 0xff
  data[3] = (groupCalls >>> 8) & 0xff
  data[4] = live.filter((g) => g.callType === CALL_TYPE_ALL).length & 0xff

  // Occupancy bitmask: a CLEARED bit means the slot is in use, because an
  // erased page is all ones.
  const occupied = new Set(live.map((g) => g.slot))
  for (let i = 0; i < TG_INDEX_SLOTS; i++) {
    const at = TG_INDEX_BITMASK + (i >> 3)
    const bit = 1 << (i & 7)
    if (occupied.has(i + 1)) data[at] = data[at]! & ~bit
    else data[at] = data[at]! | bit
  }

  // The two tables. Name order is raw byte-wise and demonstrably not
  // case-insensitive; number order is plain ascending.
  const byName = [...live].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.slot - b.slot))
  const byNumber = [...live].sort((a, b) => a.number - b.number || a.slot - b.slot)

  const writeTable = (base: number, rows: typeof live) => {
    rows.forEach((g, i) => {
      data[base + i * 2] = g.slot & 0xff
      data[base + i * 2 + 1] = (g.callType << 4) & 0xff
    })
    // Terminate, and clear only as far as the table previously reached. Filling
    // to the table's DERIVED end would run into the gaps beyond it.
    for (let i = rows.length; i <= Math.max(was, rows.length); i++) {
      data[base + i * 2] = 0xff
      data[base + i * 2 + 1] = 0xff
    }
  }
  writeTable(TG_INDEX_TABLE_BY_NAME, byName)
  writeTable(TG_INDEX_TABLE_BY_NUMBER, byNumber)
}

/** The five parts of block 0x0B, and nothing between or after them. */
export function talkGroupIndexRanges(count: number): ReadonlyArray<readonly [number, number]> {
  const rows = Math.max(count, 1) + 1
  return [
    [0, 5],
    [TG_INDEX_BITMASK, TG_INDEX_BITMASK + TG_INDEX_SLOTS / 8],
    [TG_INDEX_TABLE_BY_NAME, TG_INDEX_TABLE_BY_NAME + rows * 2],
    [TG_INDEX_TABLE_BY_NUMBER, TG_INDEX_TABLE_BY_NUMBER + rows * 2],
  ]
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

/**
 * Scan lists, block 0x11.
 *
 * Bounded by the count byte rather than by scanning for an empty record. This
 * radio's records 3-7 are initialised blank templates - name of eleven 0xFF,
 * hang time 1 - so "stop at the first empty record" and "stop at the count"
 * happen to agree here, but only the count is correct in general.
 */
export function decodeScanLists(image: RadioImage): Codeplug['scanLists'] {
  const data = blockData(image, SCANLIST_BLOCK)
  if (!data) return []
  const total = data[0]!
  const out: Codeplug['scanLists'] = []

  for (let n = 0; n < total; n++) {
    const off = SCANLIST_HEADER + n * SCANLIST_SIZE
    if (off + SCANLIST_SIZE > PAGE_SIZE - 1) break
    const rec = DM32_SCANLIST.read(data, off)
    const count = Math.min(rec.memberCount, SCANLIST_MAX_MEMBERS)
    const channels: number[] = []
    for (let i = 0; i < count; i++) {
      const ch = rec.members[i]!
      // Slots past the end hold residue, not a terminator, so the count is the
      // only bound. A zero inside the count is still a real slot the radio
      // ignores; carrying it would show the user a channel 0.
      if (ch !== 0 && ch !== 0xffff) channels.push(ch)
    }
    out.push({
      id: `scan-${n + 1}`,
      name: rec.name.trimEnd(),
      channels,
      priority1: (rec.priorityTypes & 0x0f) === 0 ? null : rec.priorityChannel1,
      priority2: (rec.priorityTypes >> 4) === 0 ? null : rec.priorityChannel2,
    })
  }
  return out
}

/**
 * RX groups, block 0x0F.
 *
 * The first four bytes are a bitmask of which slots are in use, not a count.
 * Read as an integer it says 31 on this radio, which is five groups misreported
 * as thirty-one - the same class of mistake as reading the zone count as 16-bit.
 */
export function decodeRxGroups(image: RadioImage): Codeplug['rxGroups'] {
  const data = blockData(image, RXGROUP_BLOCK)
  if (!data) return []
  const mask = data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24)
  const out: Codeplug['rxGroups'] = []

  for (let n = 0; n < RXGROUP_SLOTS; n++) {
    if (!((mask >>> n) & 1)) continue
    const off = RXGROUP_HEADER + n * RXGROUP_SIZE
    if (off + RXGROUP_SIZE > PAGE_SIZE - 1) break
    const rec = DM32_RXGROUP.read(data, off)
    // These are raw DMR contact numbers, not talk-group indices - which is why
    // the model calls the field dmrIds.
    const dmrIds = rec.members.filter((v) => v !== 0 && v !== 0xffffff)
    out.push({ id: `rxg-${n + 1}`, name: rec.name.trimEnd(), dmrIds })
  }
  return out
}

/**
 * DMR radio IDs, block 0x67.
 *
 * The count byte is a lower bound, not the whole story: a slot can hold a name
 * with no number or a number with no name. Every slot is walked and anything
 * carrying either is kept, so an ID the count forgot is still shown.
 */
export function decodeRadioIds(image: RadioImage): Codeplug['radioIds'] {
  const data = blockData(image, RADIOID_BLOCK)
  if (!data) return []
  const out: Codeplug['radioIds'] = []

  for (let n = 0; n < RADIOID_SLOTS; n++) {
    const off = RADIOID_HEADER + n * RADIOID_SIZE
    if (off + RADIOID_SIZE > PAGE_SIZE - 1) break
    const rec = DM32_RADIOID.read(data, off)
    const name = rec.name.trimEnd()
    if (rec.dmrId === 0 && !name) continue
    out.push({ id: `rid-${n + 1}`, name, dmrId: rec.dmrId })
  }
  return out
}

/**
 * Radio settings, block 0x04.
 *
 * Flattened to the `Record<string, unknown>` the document carries, with the
 * bitfields spread into their named bits so the settings form can offer one
 * control per bit rather than a number nobody can interpret.
 */
export function decodeSettings(image: RadioImage): Record<string, unknown> {
  const data = blockData(image, SETTINGS_BLOCK)
  if (!data) return {}
  const raw = DM32_SETTINGS.read(data, 0)

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'object' && value !== null) {
      for (const [bit, v] of Object.entries(value as Record<string, number>)) {
        if (bit === 'reserved') continue
        out[`${key}.${bit}`] = v
      }
      continue
    }
    out[key] = typeof value === 'string' ? value.trimEnd() : value
  }
  return out
}

/**
 * Which talk-group slots block 0x0B says are live, in the order the radio lists
 * them by name.
 *
 * Read-only, and used only to check the talk-group bank against the radio's own
 * idea of it. Regenerating this index is a separate job with its own hazards -
 * five interdependent parts that no observed radio has ever had out of step.
 */
export function decodeTalkGroupIndex(image: RadioImage): { live: number[]; byName: number[] } | null {
  const data = blockData(image, TG_INDEX_BLOCK)
  if (!data) return null

  const live: number[] = []
  for (let i = 0; i < TG_INDEX_SLOTS; i++) {
    // A cleared bit means the slot is in use. The radio stores it that way
    // because an erased page is all ones.
    if (!((data[TG_INDEX_BITMASK + (i >> 3)]! >> (i & 7)) & 1)) live.push(i + 1)
  }

  const byName: number[] = []
  for (let off = TG_INDEX_TABLE_BY_NAME; off + 2 <= TG_INDEX_TABLE_BY_NUMBER; off += 2) {
    if (data[off] === 0xff && data[off + 1] === 0xff) break
    byName.push(data[off]!)
  }
  return { live, byName }
}

/**
 * Write the scan lists back.
 *
 * The count byte is the only header, so adding and removing lists is just a
 * matter of writing it - unlike the zone and channel banks, whose headers carry
 * fifteen bytes nobody has explained.
 *
 * Members are written before the count for the same reason a filesystem writes
 * data before metadata: a write interrupted midway then leaves the old, shorter,
 * still-valid count rather than one pointing into half-written slots.
 */
export function encodeScanLists(image: RadioImage, lists: Codeplug['scanLists'], live: ReadonlySet<number>): void {
  const data = blockData(image, SCANLIST_BLOCK)
  if (!data) return
  const was = data[0]!
  const capacity = Math.floor((PAGE_SIZE - 1 - SCANLIST_HEADER) / SCANLIST_SIZE)
  if (lists.length > capacity) {
    throw new DriverError(`This radio holds ${capacity} scan lists; the codeplug has ${lists.length}.`)
  }

  for (let n = 0; n < Math.max(was, lists.length); n++) {
    const off = SCANLIST_HEADER + n * SCANLIST_SIZE
    if (off + SCANLIST_SIZE > PAGE_SIZE - 1) break
    const list = lists[n]
    if (!list) {
      // Past the new count. Erase the record so a later list cannot inherit
      // half of a deleted one's channels.
      if (n < was) data.fill(ERASED, off, off + SCANLIST_SIZE)
      continue
    }

    // Members begin at +0x18, sixteen of them, and the count at +0x0B bounds
    // them. That was disputed: the reference reads the list from +0x1A with
    // fifteen slots and says +0x18-0x19 is an opaque word to preserve, on the
    // evidence that its OEM CPS capture stores 0x0000 there on all nine of its
    // lists.
    //
    // This radio settles it, and not by a preference. Its first list has a
    // count of 16, and fifteen slots cannot hold sixteen members - the reading
    // is arithmetically impossible here, whatever the capture shows. Both lists
    // are then exactly consistent with +0x18: counts of 16 and 9 against
    // sixteen and nine non-zero words from there, where reading from +0x1A
    // gives fifteen and eight. Two independent records, both off by exactly one
    // under the other reading.
    //
    // What the OEM capture means is still unexplained - a different firmware,
    // or lists that were empty with residue further in - so this is recorded as
    // true of this firmware rather than of the radio in general.
    const members = list.channels.filter((c) => live.has(c)).slice(0, SCANLIST_MAX_MEMBERS)
    const padded = [...members, ...new Array<number>(SCANLIST_MAX_MEMBERS - members.length).fill(0)]

    // Entries before the count, so a write interrupted midway leaves the old
    // shorter count rather than one reaching into half-written slots.
    DM32_SCANLIST.write(data, off, { name: list.name, members: padded })
    DM32_SCANLIST.write(data, off, { memberCount: members.length })
  }
  data[0] = lists.length & 0xff
}

/**
 * Write the RX groups back.
 *
 * The first four bytes are the occupancy bitmask and it is the record of truth:
 * a group is present because its bit is set, not because its record has a name.
 * Bit and record are written together or not at all.
 */
export function encodeRxGroups(image: RadioImage, groups: Codeplug['rxGroups']): void {
  const data = blockData(image, RXGROUP_BLOCK)
  if (!data) return
  if (groups.length > RXGROUP_SLOTS) {
    throw new DriverError(`This radio holds ${RXGROUP_SLOTS} RX groups; the codeplug has ${groups.length}.`)
  }

  let mask = 0
  for (let n = 0; n < RXGROUP_SLOTS; n++) {
    const off = RXGROUP_HEADER + n * RXGROUP_SIZE
    if (off + RXGROUP_SIZE > PAGE_SIZE - 1) break
    const group = groups[n]
    if (!group) {
      data.fill(0x00, off, off + RXGROUP_SIZE)
      continue
    }
    mask |= 1 << n

    const ids = group.dmrIds.filter((v) => v > 0 && v <= 0xff_ffff).slice(0, RXGROUP_MAX_MEMBERS)
    const padded = [...ids, ...new Array<number>(RXGROUP_MAX_MEMBERS - ids.length).fill(0)]
    DM32_RXGROUP.write(data, off, { name: group.name, members: padded })
  }

  data[0] = mask & 0xff
  data[1] = (mask >>> 8) & 0xff
  data[2] = (mask >>> 16) & 0xff
  data[3] = (mask >>> 24) & 0xff
}

/**
 * Write the DMR radio IDs back.
 *
 * By physical slot, not by array position. A radio ID's index *is* its slot
 * number, and channel byte 0x2B points at it - so packing the bank densely
 * would silently repoint every channel that referenced a slot after a gap.
 * `decodeRadioIds` deliberately keeps gaps visible; this mirrors it, the way
 * `encodeZones` and `encodeTalkGroups` mirror theirs.
 *
 * An entry with neither a name nor a number is not written and does not count.
 * Otherwise the "Add" button would raise the count byte with no record behind
 * it, and this driver's own decoder would refuse to read back what it wrote.
 */
export function encodeRadioIds(image: RadioImage, ids: Codeplug['radioIds']): void {
  const data = blockData(image, RADIOID_BLOCK)
  if (!data) return
  const was = data[0]!

  const live = ids.filter((e) => e.dmrId !== 0 || e.name.trimEnd() !== '')
  for (const entry of live) {
    if (entry.dmrId < 0 || entry.dmrId > 0xff_ffff) {
      throw new DriverError(`DMR ID ${entry.dmrId} does not fit in the 24 bits this radio stores.`)
    }
  }

  // Where each entry goes: the slot it came from, or the lowest free one for
  // an entry the user has just added.
  const taken = new Set<number>()
  const placed = new Map<number, Codeplug['radioIds'][number]>()
  const fresh: Codeplug['radioIds'] = []
  for (const entry of live) {
    const match = /^rid-(\d+)$/.exec(entry.id)
    const slot = match ? Number(match[1]) - 1 : -1
    if (slot >= 0 && slot < RADIOID_SLOTS && !taken.has(slot)) {
      taken.add(slot)
      placed.set(slot, entry)
    } else {
      fresh.push(entry)
    }
  }
  for (const entry of fresh) {
    let slot = 0
    while (slot < RADIOID_SLOTS && taken.has(slot)) slot++
    if (slot >= RADIOID_SLOTS) {
      throw new DriverError(`This radio holds ${RADIOID_SLOTS} radio IDs and every slot is taken.`)
    }
    taken.add(slot)
    placed.set(slot, entry)
  }

  // The count has to cover the highest occupied slot, not how many there are:
  // a gap still consumes its index.
  const highest = taken.size === 0 ? 0 : Math.max(...taken) + 1

  for (let n = 0; n < Math.max(was, highest); n++) {
    const off = RADIOID_HEADER + n * RADIOID_SIZE
    if (off + RADIOID_SIZE > PAGE_SIZE - 1) break
    const entry = placed.get(n)
    if (entry) {
      DM32_RADIOID.write(data, off, { dmrId: entry.dmrId, name: entry.name })
      continue
    }
    // Only clear a slot that used to be inside the count. Slots beyond it have
    // never been ours and may hold bytes nobody has explained.
    if (n < was) DM32_RADIOID.write(data, off, { dmrId: 0, name: '' })
  }
  data[0] = highest & 0xff
}

/**
 * Write the radio settings back.
 *
 * A partial patch of a partial model: only keys the document actually carries
 * are written, and only fields this build models exist to be written. The ~3.8
 * KiB of block 0x04 that nobody has named is never assigned, so it comes
 * through untouched.
 */
export function encodeSettings(image: RadioImage, settings: Record<string, unknown>): void {
  const data = blockData(image, SETTINGS_BLOCK)
  if (!data) return

  const current = DM32_SETTINGS.read(data, 0) as Record<string, unknown>
  const patch: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || value === null) continue
    const dot = key.indexOf('.')
    if (dot < 0) {
      if (!(key in current)) continue
      patch[key] = typeof current[key] === 'string' ? String(value) : Number(value)
      continue
    }
    // A bitfield member: merge it into whatever the record already holds so the
    // bits this build does not name keep their values.
    const owner = key.slice(0, dot)
    const bit = key.slice(dot + 1)
    const group = current[owner]
    if (typeof group !== 'object' || group === null || !(bit in group)) continue
    const merged = (patch[owner] as Record<string, number>) ?? {}
    merged[bit] = Number(value)
    patch[owner] = merged
  }

  if (Object.keys(patch).length > 0) DM32_SETTINGS.write(data, 0, patch as never)
}

/**
 * The DMR address book, if the image carries one.
 *
 * The region has no logical block id and no flash translation layer: real
 * physical addresses that stay put. The walk past the first page came from the
 * reference implementation alone until this radio turned out to hold 147
 * contacts across four pages, which exercises every boundary.
 */
export function decodeContacts(image: RadioImage): Codeplug['contacts'] {
  const start = contactsBase(image)
  if (start === null) return []

  const pageAt = (n: number) => image.regions.find((r) => r.start === start + n * PAGE_SIZE)?.data
  const first = pageAt(0)
  if (!first) return []

  const count = first[0]! | (first[1]! << 8) | (first[2]! << 16) | first[3]! * 0x100_0000
  const out: Codeplug['contacts'] = []

  for (let n = 0; n < count; n++) {
    const slot = contactSlot(n)
    const data = pageAt(slot.page)
    if (!data) break
    const rec = DM32_CONTACT.read(data, slot.offset)
    out.push({
      id: `contact-${n + 1}`,
      name: rec.name.trimEnd(),
      dmrId: rec.dmrId,
      callsign: rec.callsign.trimEnd(),
      city: rec.city.trimEnd(),
      province: rec.province.trimEnd(),
      country: rec.country.trimEnd(),
      remark: rec.remark.trimEnd(),
    })
  }
  return out
}

/**
 * Write the DMR address book back.
 *
 * The region is raw: real physical addresses, no logical block id, no
 * translation layer. Four things are preserved because nobody has explained
 * them, and one because the reference says the radio's own software does:
 *
 * - bytes 0x004-0x00F of the first page, twelve bytes that are 0xFF in every
 *   capture. The reference implementation zero-fills them and diverges from the
 *   OEM CPS in doing so.
 * - byte 0x13 of each record, which reads 0xF0 on all 147 entries of this radio
 *   and in the reference's own sample, and is demonstrably not the top of a
 *   24-bit DMR ID.
 * - the tail of each page past the last entry.
 * - byte 0xFFF, which here is data rather than a block id.
 *
 * Entries do not straddle a page: 44 x 92 = 4048 of 4096. Getting that wrong is
 * the difference between reading this radio's contact 44 as "Matthew D." and
 * reading it as the middle of "Stuart".
 */
export function encodeContacts(image: RadioImage, contacts: Codeplug['contacts']): void {
  const pages = contactPages(image)
  if (pages.length === 0) return

  const capacity = pages.length * CONTACTS_PER_PAGE
  if (contacts.length > capacity) {
    throw new DriverError(
      `This image carries ${pages.length} contact page(s), which hold ${capacity} contacts; ` +
        `the codeplug has ${contacts.length}. Read the radio again to grow the region.`,
    )
  }

  const first = pages[0]!.data
  const was = first[0]! | (first[1]! << 8) | (first[2]! << 16) | first[3]! * 0x100_0000

  for (let n = 0; n < Math.max(was, contacts.length); n++) {
    const slot = contactSlot(n)
    const page = pages[slot.page]?.data
    if (!page) break
    const contact = contacts[n]
    if (!contact) {
      // Past the new count. Erase so a shrunken book cannot show half of a
      // contact that used to be there.
      if (n < was) page.fill(ERASED, slot.offset, slot.offset + CONTACT_SIZE)
      continue
    }
    if (contact.dmrId < 0 || contact.dmrId > 0xff_ffff) {
      throw new DriverError(`DMR ID ${contact.dmrId} does not fit in the 24 bits this radio stores.`)
    }
    // A record that was erased has 0xFF where every real one has 0xF0. Nothing
    // explains the byte, so an existing record keeps its own; only a slot that
    // held nothing gets the value the rest of the radio uses.
    const current = DM32_CONTACT.read(page, slot.offset)
    const blank = page
      .subarray(slot.offset, slot.offset + CONTACT_SIZE)
      .every((b) => b === 0xff || b === 0x00)

    DM32_CONTACT.write(page, slot.offset, {
      name: contact.name,
      dmrId: contact.dmrId,
      unknown13: blank ? CONTACT_UNKNOWN_13 : current.unknown13,
      callsign: contact.callsign,
      city: contact.city,
      province: contact.province,
      country: contact.country,
      remark: contact.remark,
    })
  }

  // The count last, so a write interrupted midway leaves the old, shorter,
  // still-valid one rather than a count reaching into half-written records.
  const total = contacts.length
  first[0] = total & 0xff
  first[1] = (total >>> 8) & 0xff
  first[2] = (total >>> 16) & 0xff
  first[3] = (total >>> 24) & 0xff
}

/** What a contacts page owns: the count on page 0, then whole records. */
export function contactPageRanges(pageIndex: number): ReadonlyArray<readonly [number, number]> {
  const entries = [
    (pageIndex === 0 ? CONTACT_REGION_HEADER : 0),
    (pageIndex === 0 ? CONTACT_REGION_HEADER : 0) + CONTACTS_PER_PAGE * CONTACT_SIZE,
  ] as const
  // The twelve bytes between the count and the first entry are not ours, and
  // neither is the tail past the last one - including 0xFFF, which in this
  // region is data rather than a block id.
  return pageIndex === 0 ? [[0, 4] as const, entries] : [entries]
}

/**
 * Which talk group each channel transmits to.
 *
 * Returned as a map rather than folded into the channel records, because the
 * radio keeps it that way and because a channel's entry survives the channel
 * being emptied - this radio has entries for channels 46-49, which do not exist.
 */
export function decodeTxContacts(image: RadioImage): Map<number, { slot: number; digital: boolean }> {
  const out = new Map<number, { slot: number; digital: boolean }>()
  const pages = new Map<number, Uint8Array>()
  for (const id of [TXCONTACT_BLOCK_LOW, TXCONTACT_BLOCK_HIGH]) {
    const data = blockData(image, id)
    if (data) pages.set(id, data)
  }
  if (pages.size === 0) return out

  for (const index of decodeChannels(image).map((c) => c.index)) {
    const at = txContactSlot(index)
    if (!at) continue
    const data = pages.get(at.blockId)
    if (!data) continue
    const entry = decodeTxContact(data[at.offset]!, data[at.offset + 1]!)
    if (entry.slot === 0 && !entry.digital) continue
    out.set(index, entry)
  }
  return out
}

/**
 * Write the per-channel TX contact back.
 *
 * Only block 0x42, which covers channels 1-2047 - every channel any observed
 * radio has. Block 0x43 is decoded and never written: on the development radio
 * its tail holds two "Zone 1" strings rather than contact data, and writing a
 * page whose contents contradict its documented purpose is not a guess worth
 * making for channel numbers nobody has.
 */
export function encodeTxContacts(image: RadioImage, doc: Codeplug): void {
  for (const channel of doc.channels.values()) {
    const raw = channel.extras.vendor?.txContact
    if (raw === undefined) continue
    const slot = Number(raw)
    if (!Number.isInteger(slot) || slot < 0 || slot > 0xfff) {
      throw new DriverError(`Talk group slot ${raw} is outside the 12 bits this radio stores.`)
    }

    const at = txContactSlot(channel.index)
    if (!at) continue
    // Block-scoped, deliberately. The same offset means different channels in
    // the two blocks, so a bare offset test would start refusing channels
    // 1916-2047 in 0x42 - 132 channels this build writes today.
    if (at.blockId === TXCONTACT_BLOCK_HIGH && at.offset >= TXCONTACT_HIGH_LIMIT) {
      throw new DriverError(
        `Channel ${channel.index} keeps its talk group in the tail of memory block 0x43, which holds ` +
          'firmware residue rather than contact data on every radio this has been read from.',
      )
    }
    if (at.offset + 2 > PAGE_SIZE - 1) continue

    const data = blockData(image, at.blockId)
    if (!data) continue
    const [b0, b1] = encodeTxContact(slot, channel.modulation === 'DMR', data[at.offset]!)
    data[at.offset] = b0
    data[at.offset + 1] = b1
  }
}

/** Canned text messages, block 0x0A. */
export function decodeMessages(image: RadioImage): string[] {
  const data = blockData(image, MESSAGE_BLOCK)
  if (!data) return []
  const total = Math.min(data[0]!, MESSAGE_SLOTS)
  const out: string[] = []
  for (let n = 0; n < total; n++) {
    const off = messageOffset(n)
    if (off + MESSAGE_SIZE > PAGE_SIZE - 1) break
    const rec = DM32_MESSAGE.read(data, off)
    // The length byte is the truth; the text field is padded past it.
    out.push(rec.text.slice(0, Math.min(rec.textLength, MESSAGE_MAX_CHARS)))
  }
  return out
}

/**
 * Write the canned messages back.
 *
 * Length byte then text, and the record is cleared first: a shorter message
 * written over a longer one would otherwise leave the old tail readable, and
 * unlike a name the length byte is what the radio trusts.
 */
export function encodeMessages(image: RadioImage, messages: readonly string[]): void {
  const data = blockData(image, MESSAGE_BLOCK)
  if (!data) return
  if (messages.length > MESSAGE_SLOTS) {
    throw new DriverError(`This radio holds ${MESSAGE_SLOTS} messages; the codeplug has ${messages.length}.`)
  }
  const was = Math.min(data[0]!, MESSAGE_SLOTS)

  for (let n = 0; n < Math.max(was, messages.length); n++) {
    const off = messageOffset(n)
    if (off + MESSAGE_SIZE > PAGE_SIZE - 1) break
    const text = messages[n]
    if (text === undefined) {
      if (n < was) data.fill(0x00, off, off + MESSAGE_SIZE)
      continue
    }
    const clipped = text.slice(0, MESSAGE_MAX_CHARS)
    data.fill(0x00, off, off + MESSAGE_SIZE)
    DM32_MESSAGE.write(data, off, { textLength: clipped.length, text: clipped })
  }
  data[0] = messages.length & 0xff
}

/** Roaming channels, block 0x66. The count is a trailer, not a header. */
export function decodeRoamChannels(image: RadioImage): Codeplug['roamChannels'] {
  const data = blockData(image, ROAMCHANNEL_BLOCK)
  if (!data) return []
  const total = Math.min(data[ROAMCHANNEL_COUNT_AT]!, ROAMCHANNEL_SLOTS)
  const out: Codeplug['roamChannels'] = []
  for (let n = 0; n < total; n++) {
    const off = n * ROAMCHANNEL_SIZE
    if (off + ROAMCHANNEL_SIZE > ROAMCHANNEL_COUNT_AT) break
    const rec = DM32_ROAMCHANNEL.read(data, off)
    const name = rec.name.trimEnd()
    if (!name && rec.rxFreq === 0) continue
    out.push({
      id: `roamch-${n + 1}`,
      name,
      rxFreq: hz(rec.rxFreq),
      txFreq: hz(rec.txFreq),
      colorCode: rec.colour.colorCode,
      timeSlot: rec.slot.timeSlot === 1 ? 2 : 1,
    })
  }
  return out
}

/** Write the roaming channels back, count trailer included. */
export function encodeRoamChannels(image: RadioImage, channels: Codeplug['roamChannels']): void {
  const data = blockData(image, ROAMCHANNEL_BLOCK)
  if (!data) return
  if (channels.length > ROAMCHANNEL_SLOTS) {
    throw new DriverError(`This radio holds ${ROAMCHANNEL_SLOTS} roaming channels; the codeplug has ${channels.length}.`)
  }
  const was = Math.min(data[ROAMCHANNEL_COUNT_AT]!, ROAMCHANNEL_SLOTS)

  for (let n = 0; n < Math.max(was, channels.length); n++) {
    const off = n * ROAMCHANNEL_SIZE
    if (off + ROAMCHANNEL_SIZE > ROAMCHANNEL_COUNT_AT) break
    const entry = channels[n]
    if (!entry) {
      if (n < was) data.fill(0x00, off, off + ROAMCHANNEL_SIZE)
      continue
    }
    DM32_ROAMCHANNEL.write(data, off, {
      name: entry.name,
      rxFreq: entry.rxFreq,
      txFreq: entry.txFreq,
      // Only the bits that are understood; the rest of each byte survives.
      colour: { colorCode: entry.colorCode & 0x0f },
      slot: { timeSlot: entry.timeSlot === 2 ? 1 : 0 },
    })
  }
  data[ROAMCHANNEL_COUNT_AT] = channels.length & 0xff
}

/** Roaming zones, block 0x65. Name and member count only - see the layout. */
export function decodeRoamZones(image: RadioImage): Codeplug['roamZones'] {
  const data = blockData(image, ROAMZONE_BLOCK)
  if (!data) return []
  const total = Math.min(data[0]!, ROAMZONE_SLOTS)
  const out: Codeplug['roamZones'] = []
  for (let n = 0; n < total; n++) {
    const off = ROAMZONE_HEADER + n * ROAMZONE_SIZE
    if (off + ROAMZONE_SIZE > PAGE_SIZE - 1) break
    const rec = DM32_ROAMZONE.read(data, off)
    const name = rec.name.trimEnd()
    if (!name) continue
    out.push({ id: `roamzone-${n + 1}`, name, memberCount: rec.memberCount })
  }
  return out
}

/** The eight digital emergency systems, block 0x10 at 0x000. Read only. */
export function decodeEmergency(image: RadioImage): Codeplug['emergency'] {
  const data = blockData(image, KEY_BLOCK)
  if (!data) return []
  const out: Codeplug['emergency'] = []
  for (let n = 0; n < EMERGENCY_SLOTS; n++) {
    const off = n * EMERGENCY_SIZE
    const slot = data.subarray(off, off + EMERGENCY_SIZE)
    if (slot.every((b) => b === 0x00 || b === 0xff)) continue
    const rec = DM32_EMERGENCY.read(data, off)
    out.push({
      id: `demer-${n + 1}`,
      slot: n + 1,
      name: rec.name.trimEnd(),
      alarmType: rec.alarmType,
      alarmMode: rec.alarmMode,
      revertChannel: rec.revertChannel,
    })
  }
  return out
}

/** DTMF signalling and the analog contact lists, block 0x06. Read only. */
export function decodeAnalog(image: RadioImage): Codeplug['analog'] {
  const data = blockData(image, ANALOG_BLOCK)
  if (!data) return null

  const codes: string[] = []
  for (let n = 0; n < DTMF_CODE_SLOTS; n++) {
    const code = decodeDtmf(data.subarray(n * DTMF_CODE_SIZE, (n + 1) * DTMF_CODE_SIZE))
    if (code) codes.push(code)
  }
  const special: string[] = []
  for (let n = 0; n < DTMF_SPECIAL_SLOTS; n++) {
    const at = DTMF_SPECIAL_BASE + n * DTMF_CODE_SIZE
    const code = decodeDtmf(data.subarray(at, at + DTMF_CODE_SIZE))
    if (code) special.push(code)
  }

  const contacts: string[] = []
  const contactCount = data[ANALOG_CONTACT_COUNT_AT]!
  for (let n = 0; n < contactCount; n++) {
    const at = ANALOG_CONTACT_BASE + n * ANALOG_CONTACT_SIZE
    if (at + ANALOG_CONTACT_SIZE > PAGE_SIZE - 1) break
    const name = DM32_ANALOG_CONTACT.read(data, at).name.trimEnd()
    if (name) contacts.push(name)
  }

  const bdcContacts: { name: string; number: number }[] = []
  const bdcCount = data[BDC_COUNT_AT]!
  for (let n = 0; n < bdcCount; n++) {
    const at = BDC_BASE + n * BDC_SIZE
    if (at + BDC_SIZE > PAGE_SIZE - 1) break
    const rec = DM32_BDC_CONTACT.read(data, at)
    const name = rec.name.trimEnd()
    if (name) bdcContacts.push({ name, number: rec.number })
  }

  return { dtmfCodes: codes, dtmfSpecialCodes: special, contacts, bdcContacts }
}

/**
 * Write the roaming zone names back.
 *
 * The name and nothing else. A zone's member list needs an entry width nobody
 * has established, and all three zones on the radio this was written against
 * hold zero members, so its own bytes cannot settle it either. The count byte
 * and the fifteen header bytes beside it stay as the radio has them, which is
 * why zones cannot be added or removed here.
 */
export function encodeRoamZones(image: RadioImage, zones: Codeplug['roamZones']): void {
  const data = blockData(image, ROAMZONE_BLOCK)
  if (!data) return
  const total = Math.min(data[0]!, ROAMZONE_SLOTS)

  let docIndex = 0
  for (let n = 0; n < total; n++) {
    const off = ROAMZONE_HEADER + n * ROAMZONE_SIZE
    if (off + ROAMZONE_SIZE > PAGE_SIZE - 1) break
    // Mirror the decoder's skip of unnamed records, so the nth zone in the
    // document lands on the nth record the decoder produced.
    if (!DM32_ROAMZONE.read(data, off).name.trimEnd()) continue
    const zone = zones[docIndex]
    docIndex++
    if (!zone) continue
    DM32_ROAMZONE.write(data, off, { name: zone.name })
  }
}

/**
 * Write the emergency system names back.
 *
 * Names only, and the reason is written down rather than assumed: every field
 * past the name is marked DERIVED by the reference, and all eight records on
 * the radio this was written against hold factory defaults byte-identical to a
 * capture of a different unit - so nothing here has ever been seen to vary, and
 * a value that has never varied is a value whose meaning is untested.
 */
export function encodeEmergency(image: RadioImage, systems: Codeplug['emergency']): void {
  const data = blockData(image, KEY_BLOCK)
  if (!data) return
  for (const system of systems) {
    const n = system.slot - 1
    if (n < 0 || n >= EMERGENCY_SLOTS) continue
    DM32_EMERGENCY.write(data, n * EMERGENCY_SIZE, { name: system.name })
  }
}

/**
 * Write the DTMF codes and the two analog contact lists back.
 *
 * The settings record between the code lists is left alone: of its sixteen
 * bytes the reference names four, disagrees with the hardware on one of them,
 * and marks the rest unknown.
 */
export function encodeAnalog(image: RadioImage, analog: Codeplug['analog']): void {
  const data = blockData(image, ANALOG_BLOCK)
  if (!data || !analog) return

  const writeCode = (at: number, code: string) => {
    for (let i = 0; i < DTMF_CODE_SIZE; i++) {
      const digit = i < code.length ? DTMF_DIGITS.indexOf(code[i]!.toUpperCase()) : -1
      // 0xFF ends a code and marks the rest of the slot unused, which is what
      // the radio itself stores.
      data[at + i] = digit < 0 ? 0xff : digit
    }
  }

  analog.dtmfCodes.forEach((code, n) => {
    if (n < DTMF_CODE_SLOTS) writeCode(n * DTMF_CODE_SIZE, code)
  })
  analog.dtmfSpecialCodes.forEach((code, n) => {
    if (n < DTMF_SPECIAL_SLOTS) writeCode(DTMF_SPECIAL_BASE + n * DTMF_CODE_SIZE, code)
  })

  const contactCount = data[ANALOG_CONTACT_COUNT_AT]!
  analog.contacts.forEach((name, n) => {
    if (n >= contactCount) return
    const at = ANALOG_CONTACT_BASE + n * ANALOG_CONTACT_SIZE
    if (at + ANALOG_CONTACT_SIZE <= PAGE_SIZE - 1) DM32_ANALOG_CONTACT.write(data, at, { name })
  })

  const bdcCount = data[BDC_COUNT_AT]!
  analog.bdcContacts.forEach((contact, n) => {
    if (n >= bdcCount) return
    const at = BDC_BASE + n * BDC_SIZE
    if (at + BDC_SIZE > PAGE_SIZE - 1) return
    if (contact.number < 0 || contact.number > 99) {
      throw new DriverError(`MDC1200 number ${contact.number} does not fit the two BCD digits stored.`)
    }
    DM32_BDC_CONTACT.write(data, at, { name: contact.name, number: contact.number })
  })
}

/** The name field of every emergency record, and nothing else in the page. */
export function emergencyNameRanges(): ReadonlyArray<readonly [number, number]> {
  return Array.from({ length: EMERGENCY_SLOTS }, (_, n) => [n * EMERGENCY_SIZE, n * EMERGENCY_SIZE + 8] as const)
}

/** The DTMF code slots and the two contact lists, field by field. */
export function analogRanges(image: RadioImage): ReadonlyArray<readonly [number, number]> {
  const data = blockData(image, ANALOG_BLOCK)
  const out: (readonly [number, number])[] = [[0, DTMF_CODE_SLOTS * DTMF_CODE_SIZE]]
  out.push([DTMF_SPECIAL_BASE, DTMF_SPECIAL_BASE + DTMF_SPECIAL_SLOTS * DTMF_CODE_SIZE])

  // Only the records the block says exist. A slot past the count has never been
  // ours and may hold bytes nobody has explained.
  const contacts = data ? data[ANALOG_CONTACT_COUNT_AT]! : 0
  for (let n = 0; n < contacts; n++) {
    const at = ANALOG_CONTACT_BASE + n * ANALOG_CONTACT_SIZE
    if (at + 16 <= PAGE_SIZE - 1) out.push([at, at + 16])
  }
  const bdc = data ? data[BDC_COUNT_AT]! : 0
  for (let n = 0; n < bdc; n++) {
    const at = BDC_BASE + n * BDC_SIZE
    if (at + 17 <= PAGE_SIZE - 1) out.push([at, at + 17])
  }
  return out
}

/** The name field of every roaming zone record the block says exists. */
export function roamZoneNameRanges(image: RadioImage): ReadonlyArray<readonly [number, number]> {
  const data = blockData(image, ROAMZONE_BLOCK)
  if (!data) return []
  const total = Math.min(data[0]!, ROAMZONE_SLOTS)
  const out: (readonly [number, number])[] = []
  for (let n = 0; n < total; n++) {
    const off = ROAMZONE_HEADER + n * ROAMZONE_SIZE
    if (off + 16 <= PAGE_SIZE - 1) out.push([off, off + 16])
  }
  return out
}

/** VFO A and VFO B, decoded as the channel records they are. */
export function decodeVfos(image: RadioImage): Codeplug['vfo'] {
  const data = blockData(image, VFO_BLOCK)
  if (!data) return { a: null, b: null }
  return {
    a: decodeChannel(data, VFO_A, 4001),
    b: decodeChannel(data, VFO_B, 4002),
  }
}

/**
 * Write the two VFOs back.
 *
 * The same partial patch as any other channel, at fixed offsets. Their TX
 * contacts live in block 0x43 at 0x0FFA and 0x0FFC and are left alone: they
 * read 0xFF on this radio, the reference's own implementation refuses to write
 * them, and a talk group for a VFO is not something this build offers.
 */
export function encodeVfos(image: RadioImage, vfo: Codeplug['vfo']): void {
  const data = blockData(image, VFO_BLOCK)
  if (!data) return
  if (vfo.a) encodeChannel(data, VFO_A, vfo.a)
  if (vfo.b) encodeChannel(data, VFO_B, vfo.b)
}
