// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump, sha256Hex } from '../../codec/checksum.js'
import { diffRanges, equalBytes } from '../../codec/struct.js'
import { emptyCodeplug, type Channel, type Codeplug, type TxSpec } from '../../model/index.js'
import { NO_TONE, type TonePair } from '../../model/tones.js'
import { hz, type Hz } from '../../model/units.js'
import {
  BackupRequiredError,
  DEFAULT_DRIVER_TIMEOUT_MS,
  DriverError,
  ImageRadioMismatchError,
  RadioChangedError,
  UnsupportedFirmwareError,
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
import { cloneImage, locate } from '../../radio/image.js'
import type { Transport } from '../../transport/transport.js'
import {
  attrAddr,
  BANDWIDTH_NARROW_HZ,
  BANDWIDTH_WIDE_HZ,
  CHANNEL_BASE,
  CHANNEL_COUNT,
  channelAddr,
  EMPTY_FREQ,
  NAMED_CHANNEL_COUNT,
  nameAddr,
  ownedRangesProgrammable,
  POWER_HIGH,
  POWER_MEDIUM,
  regionsFor,
  SHIFT_MINUS,
  SHIFT_PLUS,
  TUNING_STEPS_HZ,
  UVK5_ATTRIBUTES,
  UVK5_CHANNEL,
  UVK5_NAME,
  VFO_CHANNEL_NAMES,
} from './layout.js'
import { MEM_BLOCK, MEM_SIZE, readMem, resetRadio, sayHello, writeMem } from './protocol.js'
import { validateCodeplug } from '../../validate/rules.js'
import { decodeStockSettings, decodeTone, encodeInto } from './encode.js'
import {
  EGZUMER_BANDS_STANDARD_HZ,
  EGZUMER_BANDS_WIDE_HZ,
  egzumerOwnedRanges,
  EGZUMER_STEPS_HZ,
} from './egzumer-layout.js'
import {
  decodeEgzumerChannel,
  decodeEgzumerSettings,
  encodeEgzumerInto,
  readBuildOptions,
  DEFAULT_BUILD_OPTIONS,
  type BuildOptions,
} from './egzumer.js'
import { EGZUMER_LAYOUT, UVK5_FM_RANGE, UVK5_SCHEMA, UVK5_SERIAL } from './schema.js'
import { classifyFirmware, variantForLayout, variantsCompatible } from './variants.js'

const PROGRAMMABLE_START = 0x0000

/**
 * How much of the EEPROM this firmware lets a programmer write.
 *
 * Everything above it is calibration. Stock stops at 0x1D00 and egzumer at
 * 0x1E00, so the number has to come from the image rather than from a constant
 * - the alternative is a write that stops 256 bytes short of what the radio
 * actually programs, or one that treats calibration as fair game.
 */
const progSizeOf = (layout: string) => variantForLayout(layout).calStart

const isEgzumer = (layout: string) => layout === EGZUMER_LAYOUT

/** The build flags of an egzumer image, read from its calibration region. */
function buildOptionsOf(image: RadioImage): BuildOptions {
  const cal = image.regions.find((r) => r.readOnly === true)
  return cal ? readBuildOptions(cal.data, cal.start) : DEFAULT_BUILD_OPTIONS
}

/**
 * The bands to hold a codeplug to.
 *
 * The schema's table is the stock radio's, which is what most UV-K5s are. An
 * egzumer build compiled with wide receive reaches from 18 MHz to 1.3 GHz, and
 * holding one of those to stock's limits would put an error on every channel
 * the radio is perfectly happy with. Which table applies is recorded during
 * decode, because it comes from a build flag in the calibration region that the
 * codeplug alone does not carry.
 *
 * Widening what a radio can *hear* is the firmware author's decision. Widening
 * what this app will let someone transmit on is not, so the extra reach at the
 * bottom is split rather than inherited wholesale: the broadcast FM band the
 * radio's own receiver covers - `FMMIN` to `FMMAX`, 76 to 108 MHz - is marked
 * receive-only for the same reason the air band above it is. Stock's band 0
 * stops at 76 MHz precisely because of what is above it, and that fact does not
 * change when the receiver is widened.
 */
function bandsFor(doc: Codeplug): RadioSchema['rf']['bands'] {
  // `buildWideRx` is only ever set by the egzumer decoder, so its presence is
  // what says this codeplug came off that firmware. A codeplug built from a CSV
  // has no settings at all and gets the stock table, which is the conservative
  // answer.
  const wideRx = doc.settings.buildWideRx
  if (wideRx === undefined) return UVK5_SCHEMA.rf.bands

  const table = wideRx === 0 ? EGZUMER_BANDS_STANDARD_HZ : EGZUMER_BANDS_WIDE_HZ
  const band = (lo: number, hi: number, txAllowed: boolean) => ({
    loHz: hz(lo),
    hiHz: hz(hi),
    label: `${Math.round(lo / 1e6)}-${Math.round(hi / 1e6)} MHz`,
    txAllowed,
  })

  return table.flatMap(([lo, hi], i) => {
    const txAllowed = UVK5_SCHEMA.rf.bands[i]?.txAllowed ?? false
    if (i !== 0 || hi <= UVK5_FM_RANGE.min) return [band(lo, hi, txAllowed)]
    return [band(lo, UVK5_FM_RANGE.min, txAllowed), band(UVK5_FM_RANGE.min, hi, false)]
  })
}

/** The same image with its programmable region replaced by `mem`. */
function imageOfRegion(image: RadioImage, mem: Uint8Array): RadioImage {
  return {
    ...image,
    regions: image.regions.map((r) => (r.start === PROGRAMMABLE_START ? { ...r, data: mem } : r)),
  }
}

export interface Uvk5DriverOptions {
  /**
   * Allow this driver to write to a radio.
   *
   * Off by default: the schema is the build's own statement about whether the
   * write path has been proven, and `writeImage` refuses when it is off. It is
   * a constructor option rather than a mutable flag so that the schema the UI
   * renders and the capability the driver enforces can never disagree - the
   * first version of this check read the schema from a closure, so overriding
   * the schema left the check reading the old value.
   *
   * Turned on by the test suite and by the hardware bring-up harness, and in
   * production only once a write has been verified against a real radio.
   */
  enableWrite?: boolean
}

export function createUvk5Driver(options: Uvk5DriverOptions = {}): RadioDriver {
  const schema: RadioSchema = options.enableWrite
    ? { ...UVK5_SCHEMA, status: 'beta', capabilities: { ...UVK5_SCHEMA.capabilities, write: true } }
    : UVK5_SCHEMA

  const driver: RadioDriver = {
    id: 'uvk5',
    schema,
    serial: { ...UVK5_SERIAL, signals: { ...UVK5_SERIAL.signals } },
    // The UV-K5 has a reset command, so an aborted transfer can be tidied up
    // rather than leaving the radio stuck in programming mode.
    abortPolicy: 'reset-command',
    writeBlockBytes: MEM_BLOCK,

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
      // UV-K5 programming cables ship with several different USB-serial chips:
      // QinHeng CH340 (1a86), Prolific PL2303 (067b), Silicon Labs CP210x
      // (10c4) and FTDI (0403) are all common. Every one of them is also in
      // countless unrelated devices, so this only orders the port picker; the
      // handshake is what actually identifies a radio.
      const KNOWN_BRIDGES = [0x1a86, 0x067b, 0x10c4, 0x0403]
      return info.usbVendorId !== undefined && KNOWN_BRIDGES.includes(info.usbVendorId) ? 'possible' : 'no'
    },

    async identify(t: Transport, ctx: DriverCtx = {}): Promise<IdentifyResult> {
      ctx.progress?.({ phase: 'handshake', done: 0, total: 1, label: 'Saying hello' })
      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const firmware = await sayHello(t, 5, { timeoutMs, signal: ctx.signal, adapter: ctx.adapter })
      const variant = classifyFirmware(firmware)
      ctx.log?.info(`UV-K5 firmware ${JSON.stringify(firmware)} → layout ${variant.layout}`)

      // A fingerprint of the individual radio, not just its firmware.
      //
      // The hello reply carries nothing unit-specific - CHIRP's `_sayhello`
      // returns the version string and nothing else - so hashing that alone
      // would give every UV-K5 on a given firmware the same identity. That
      // matters because the backup gate is supposed to mean "a backup of *this*
      // radio": with a firmware-only hash, a backup of one radio would unlock
      // writing to another, and the second radio's codeplug would be
      // overwritten with nothing to restore it from.
      //
      // Calibration is factory-set per unit, so it is the natural fingerprint.
      // Where it starts is the firmware's business - 768 bytes on stock, 512 on
      // egzumer - so the variant decides, and both are a handful of extra reads.
      const calStart = variant.calStart
      const cal = new Uint8Array(MEM_SIZE - calStart)
      for (let off = 0; off < cal.length; off += MEM_BLOCK) {
        ctx.signal?.throwIfAborted()
        cal.set(await readMem(t, calStart + off, MEM_BLOCK, { timeoutMs, signal: ctx.signal, adapter: ctx.adapter }), off)
      }
      const calHash = await sha256Hex(cal)

      ctx.progress?.({ phase: 'handshake', done: 1, total: 1, label: firmware })

      return {
        radioId: 'uvk5',
        variant: firmware,
        layout: variant.layout,
        raw: new TextEncoder().encode(firmware),
        caps: {
          read: true,
          // Whether the *firmware* permits writing. The schema gates the driver
          // as a whole separately.
          write: variant.canWrite,
          ...(variant.note === undefined ? {} : { reason: variant.note }),
        },
        identHash: await sha256Hex(new TextEncoder().encode(`uvk5|${firmware}|${calHash}`)),
      }
    },

    async readImage(t: Transport, ident: IdentifyResult, ctx: DriverCtx = {}): Promise<RadioImage> {
      const buf = new Uint8Array(MEM_SIZE)
      const blocks = MEM_SIZE / MEM_BLOCK
      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS

      for (let i = 0; i < blocks; i++) {
        ctx.signal?.throwIfAborted()
        const addr = i * MEM_BLOCK
        const block = await readMem(t, addr, MEM_BLOCK, { timeoutMs, signal: ctx.signal })
        buf.set(block, addr)
        ctx.progress?.({
          phase: 'read',
          done: addr + MEM_BLOCK,
          total: MEM_SIZE,
          label: `0x${addr.toString(16).padStart(4, '0')}`,
        })
      }

      // The whole EEPROM is captured, calibration included. A backup that
      // cannot restore calibration is not a backup. Where the two regions meet
      // comes from the firmware that answered the handshake, not from a
      // constant - see `regionsFor`.
      const regions = regionsFor(progSizeOf(ident.layout)).map((r) => ({
        start: r.start,
        data: buf.slice(r.start, r.start + r.length),
        readOnly: r.readOnly,
        label: r.label,
      }))

      return {
        radioId: 'uvk5',
        variant: ident.variant,
        layout: ident.layout,
        createdAt: new Date().toISOString(),
        regions,
        meta: { firmware: ident.variant },
        sha256: await sha256Hex(buf),
      }
    },

    /**
     * Send an image back to the radio.
     *
     * The ordering here is the whole safety argument, and every step exists
     * because skipping it produces a specific, reachable failure:
     *
     * 1. Refuse unless the driver itself is allowed to write and the codeplug
     *    validates. Not delegated to the UI - a script, a bring-up harness or a
     *    future caller must hit the same wall.
     * 2. Re-identify. The fingerprint covers the radio's calibration data, so
     *    it distinguishes two units running identical firmware.
     * 3. Re-read the programmable region and compare it against what the caller
     *    believed the radio held. If the radio has changed since it was read -
     *    a keypad edit, a different radio, a stale file - stop. Deciding what to
     *    write from an unverified base is how a radio ends up holding a mixture
     *    of two codeplugs while the app reports success.
     * 4. Write each differing block and read it back **immediately**. Failing
     *    on the first bad block leaves as much of the radio intact as possible.
     * 5. Whatever happens, try to leave programming mode, resynchronising the
     *    line first if an abort poisoned it.
     *
     * Any failure after the first byte carries the partial report, because a
     * half-programmed radio the user is not told about is worse than a failure.
     */
    async writeImage(t: Transport, image: RadioImage, ctx: DriverCtx = {}): Promise<WriteReport> {
      if (image.radioId !== 'uvk5') throw new DriverError(`Not a UV-K5 image: ${image.radioId}`)

      if (!schema.capabilities.write && !ctx.dryRun) {
        throw new WriteBlockedError(
          `Writing the ${schema.model} is not enabled in this build: the write path has not been ` +
            'verified against hardware.',
        )
      }
      if (!ctx.dryRun && !ctx.backup) throw new BackupRequiredError('uvk5')

      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal, adapter: ctx.adapter }

      // How far the programmable region reaches is a property of the firmware
      // the image was read from, so it is taken from the image's own layout
      // rather than assumed. Getting this wrong on an egzumer radio would mean
      // stopping 256 bytes short of what that firmware actually programs.
      const progSize = progSizeOf(image.layout)
      const source = image.regions.find((r) => r.start === PROGRAMMABLE_START && !r.readOnly)
      if (!source) throw new DriverError('This image has no writable region')
      if (source.data.length !== progSize) {
        // A short region would make `subarray` yield empty blocks and send
        // zero-length write commands to live EEPROM addresses; a long one would
        // be silently truncated. Neither should ever reach a radio.
        throw new DriverError(
          `This image's programmable region is ${source.data.length} bytes; the UV-K5 expects exactly ${progSize}.`,
        )
      }
      const payload = source.data

      const ident = ctx.ident ?? (await driver.identify(t, ctx))
      if (ctx.backup && ctx.backup.identHash !== ident.identHash) {
        throw new BackupRequiredError('uvk5')
      }
      if (!variantsCompatible(image.variant, ident.variant)) {
        throw new ImageRadioMismatchError(ident.variant, image.variant)
      }
      if (!classifyFirmware(ident.variant).canWrite) {
        throw new UnsupportedFirmwareError(ident.variant)
      }

      const operations: WriteOperation[] = []
      let blocksWritten = 0
      let bytesWritten = 0
      const report = (): WriteReport => ({
        blocksWritten,
        bytesWritten,
        verified: bytesWritten > 0,
        dryRun: ctx.dryRun === true,
        operations,
      })

      try {
        // Step 3. What the radio holds right now, read fresh. This is the only
        // trustworthy basis for deciding which blocks may be left alone;
        // `ctx.baseImage` is what the *caller* believes, which is a different
        // thing and is exactly what goes stale.
        const live = new Uint8Array(progSize)
        for (let addr = 0; addr < progSize; addr += MEM_BLOCK) {
          ctx.signal?.throwIfAborted()
          live.set(await readMem(t, addr, MEM_BLOCK, opts), addr)
          ctx.progress?.({ phase: 'read', done: addr + MEM_BLOCK, total: progSize, label: 'checking the radio' })
        }

        const expected = ctx.baseImage?.regions.find((r) => r.start === PROGRAMMABLE_START)?.data
        if (expected && expected.length === progSize && !equalBytes(live, expected)) {
          const [first] = diffRanges(expected, live)
          throw new RadioChangedError(first ? first[0] : 0)
        }

        // Validate what this write *changes*, not the whole codeplug.
        //
        // A radio ships with settings its own validator objects to - this one's
        // factory VFO presets sit in the 108-137 MHz air band with transmit
        // enabled. Refusing to write because of state the user did not create
        // and is not altering would make it impossible to program a
        // factory-fresh radio, while telling them about a problem they cannot
        // act on. What they are responsible for is the delta, and a channel
        // they do edit into an illegal state is still caught, because editing
        // it makes it part of the delta.
        if (!ctx.dryRun) {
          const before = driver.decode(imageOfRegion(image, live)).channels
          const after = driver.decode(image).channels
          const changed = new Set<number>()
          for (const idx of new Set([...before.keys(), ...after.keys()])) {
            if (JSON.stringify(before.get(idx)) !== JSON.stringify(after.get(idx))) changed.add(idx)
          }
          const errors = driver
            .validate(driver.decode(image))
            .filter((d) => d.severity === 'error' && d.channel !== undefined && changed.has(d.channel))
          if (errors.length > 0) {
            throw new DriverError(
              `Refusing to write: ${errors.length} channel(s) you have changed would be programmed incorrectly. ` +
                errors
                  .slice(0, 3)
                  .map((d) => `Channel ${d.channel}: ${d.message}`)
                  .join(' '),
            )
          }
        }

        // Step 4. Write and verify one block at a time.
        for (let addr = 0; addr < progSize; addr += MEM_BLOCK) {
          ctx.signal?.throwIfAborted()
          const block = payload.subarray(addr, addr + MEM_BLOCK)
          const label = `0x${addr.toString(16).padStart(4, '0')}`

          if (equalBytes(block, live.subarray(addr, addr + MEM_BLOCK))) {
            operations.push({ addr, length: MEM_BLOCK, label, skipped: 'unchanged' })
            ctx.progress?.({ phase: 'write', done: addr + MEM_BLOCK, total: progSize, label })
            continue
          }

          if (!ctx.dryRun) {
            await writeMem(t, addr, block, opts)
            const got = await readMem(t, addr, MEM_BLOCK, opts)
            if (!equalBytes(got, block)) {
              throw new WriteVerifyError(addr, hexDump(block, 16), hexDump(got, 16), blocksWritten)
            }
          }

          operations.push({ addr, length: MEM_BLOCK, label })
          blocksWritten++
          bytesWritten += MEM_BLOCK
          ctx.progress?.({ phase: 'write', done: addr + MEM_BLOCK, total: progSize, label })
        }

        return report()
      } catch (e) {
        // A half-programmed radio the user is not told about is worse than a
        // failure. Carry what was committed out with the error.
        if (e instanceof DriverError || e instanceof Error) {
          ;(e as Error & { partial?: WriteReport }).partial = report()
        }
        throw e
      } finally {
        // Step 5. Leave programming mode whatever happened. An abort or timeout
        // poisons the transport, and `write` refuses while it is poisoned - so
        // without the resync the reset silently never reaches the radio, which
        // is precisely the case `abortPolicy: 'reset-command'` promises to
        // handle.
        if (!ctx.dryRun) {
          try {
            if (t.state === 'desynced') await t.resync(150, { timeoutMs: 1000 })
            if (t.state === 'open') await resetRadio(t)
          } catch {
            // Best effort. The radio reboots rather than replying, so a failure
            // here says nothing about whether the write succeeded.
          }
        }
      }
    },

    decode(image: RadioImage): Codeplug {
      if (image.radioId !== 'uvk5') throw new DriverError(`Not a UV-K5 image: ${image.radioId}`)
      const found = locate(image, CHANNEL_BASE)
      if (!found) throw new DriverError('UV-K5 image has no programmable region')
      const mem = found.region.data

      const cp = emptyCodeplug('uvk5', image.createdAt)
      cp.meta.title = 'UV-K5 codeplug'
      cp.meta.variant = image.variant

      // Which decoder applies is decided by the layout stamped on the image at
      // read, not by re-reading the firmware string here. That is the same fact
      // a `.bwp` carries and the same one `writeImage` checks against the radio
      // on the cable, so all three can never disagree.
      if (isEgzumer(image.layout)) {
        const build = buildOptionsOf(image)
        for (let i = 0; i < CHANNEL_COUNT; i++) {
          const ch = decodeEgzumerChannel(mem, i, build)
          if (ch) cp.channels.set(ch.index, ch)
        }
        cp.settings = decodeEgzumerSettings(mem, build)
        return cp
      }

      for (let i = 0; i < CHANNEL_COUNT; i++) {
        const ch = decodeChannel(mem, i)
        if (ch) cp.channels.set(ch.index, ch)
      }
      cp.settings = decodeStockSettings(mem)

      return cp
    },

    /**
     * Serialise a codeplug onto a copy of the image it came from.
     *
     * There is deliberately no `encode(doc)`. Starting from the bytes the radio
     * gave us is what guarantees that everything this driver does not model -
     * settings, DTMF contacts, the boot logo, calibration, and every reserved
     * bit - survives a read/edit/write cycle untouched. The invariant
     * `encode(decode(img), img) === img` is asserted against a real radio's
     * EEPROM in the test suite.
     */
    encode(doc: Codeplug, base: RadioImage): RadioImage {
      if (base.radioId !== 'uvk5') throw new DriverError(`Not a UV-K5 image: ${base.radioId}`)
      if (doc.radio !== null && doc.radio !== 'uvk5') {
        throw new DriverError(`This codeplug is for the ${doc.radio}, not the UV-K5`)
      }
      const out = cloneImage(base)
      const region = out.regions.find((r) => r.start === PROGRAMMABLE_START)
      if (!region) throw new DriverError('UV-K5 image has no programmable region')
      if (isEgzumer(base.layout)) encodeEgzumerInto(region.data, doc)
      else encodeInto(region.data, doc)
      // The hash describes bytes that have changed, so it is recomputed when
      // the image is persisted rather than carried over from the base.
      return { ...out, sha256: '' }
    },

    /**
     * Bands, modulations and steps as the firmware on this image has them.
     *
     * `bandsFor` already existed for validation. The editor needs the same
     * answer, plus the two lists that also differ: egzumer decodes single
     * sideband and twenty-four steps, and offering stock's six against a
     * channel that holds one of the other eighteen leaves the control with no
     * matching option.
     */
    rfFor(doc: Codeplug): RadioSchema['rf'] {
      const bands = bandsFor(doc)
      if (doc.settings.buildWideRx === undefined) return { ...UVK5_SCHEMA.rf, bands }
      return {
        ...UVK5_SCHEMA.rf,
        bands,
        modulations: ['FM', 'AM', 'USB'],
        tuningSteps: EGZUMER_STEPS_HZ.map((step: number) => hz(step)),
      }
    },

    validate(doc: Codeplug): Diagnostic[] {
      // The shared rules, with this radio's bands rather than the schema's: an
      // egzumer build compiled with wide receive legitimately reaches
      // frequencies the stock table does not list. Nothing here is
      // UV-K5-specific any more, including the VFO exemption - the schema lists
      // those slots in `memory.specialChannels` and the rules skip them.
      return validateCodeplug(doc, UVK5_SCHEMA, { bands: bandsFor(doc) })
    },

    ownedRanges(regionStart: number, image?: RadioImage) {
      // The calibration region is claimed by nobody, which is what makes it
      // impossible to write.
      if (regionStart !== PROGRAMMABLE_START) return []
      // Egzumer claims more of the programmable region than stock does, because
      // this build decodes its settings window and its FM presets and stock's
      // it does not. Claiming those on a stock image would be the dangerous
      // direction of the same mistake: `ownedRanges` is what the write gate
      // uses to decide a changed byte was changed on purpose.
      return image !== undefined && isEgzumer(image.layout) ? egzumerOwnedRanges() : ownedRangesProgrammable()
    },
  }

  return driver
}

/**
 * Decode one channel record, or null when the slot is empty.
 *
 * CHIRP treats a frequency of 0 or all-ones as empty, and so do we: an
 * unprogrammed slot on this radio is 0xFF filled.
 */
export function decodeChannel(mem: Uint8Array, i: number): Channel | null {
  const raw = UVK5_CHANNEL.read(mem, channelAddr(i))
  if (raw.freq === EMPTY_FREQ || raw.freq === 0) return null

  const rxFreq = hz(raw.freq)
  const offset = hz(raw.offset)

  // The UV-K5 has no TX-inhibit bit. CHIRP encodes "transmit disabled" as a
  // minus shift whose offset equals the receive frequency, which puts the
  // computed transmit frequency at 0 MHz. Detecting that here is what stops a
  // receive-only channel from silently becoming transmit-capable on import.
  let tx: TxSpec = { kind: 'simplex' }
  let txAllowed = true
  let txInhibitReason: string | undefined

  if (offset !== 0) {
    if (raw.flags1.shift === SHIFT_MINUS) {
      if (raw.offset === raw.freq) {
        txAllowed = false
        txInhibitReason = 'Transmit frequency parked at 0 MHz'
      } else {
        tx = { kind: 'offset', direction: 'minus', offset }
      }
    } else if (raw.flags1.shift === SHIFT_PLUS) {
      tx = { kind: 'offset', direction: 'plus', offset }
    }
  }

  const rx = decodeTone(raw.codeFlags.rxCodeFlag, raw.rxCode)
  const txTone = decodeTone(raw.codeFlags.txCodeFlag, raw.txCode)
  const tone: TonePair = rx === null && txTone === null ? NO_TONE : { rx, tx: txTone, rxInverted: false }

  const isNarrow = raw.flags2.bandwidth > 0
  const modulation = raw.flags1.enableAm > 0 ? 'AM' : 'FM'
  const powerLevel =
    raw.flags2.txPower === POWER_HIGH
      ? UVK5_SCHEMA.rf.powerLevels[2]!
      : raw.flags2.txPower === POWER_MEDIUM
        ? UVK5_SCHEMA.rf.powerLevels[1]!
        : UVK5_SCHEMA.rf.powerLevels[0]!

  // Slots past 199 are the VFO pseudo-channels: no name storage, and no
  // attribute byte either.
  const isSpecial = i >= NAMED_CHANNEL_COUNT
  const name = isSpecial
    ? (VFO_CHANNEL_NAMES[i - NAMED_CHANNEL_COUNT] ?? '')
    : UVK5_NAME.read(mem, nameAddr(i)).name.trimEnd()

  const attr = isSpecial ? null : UVK5_ATTRIBUTES.read(mem, attrAddr(i)).attr

  const stepHz = TUNING_STEPS_HZ[raw.step] ?? TUNING_STEPS_HZ[0]!

  return {
    index: i + 1,
    name,
    rxFreq,
    tx,
    txAllowed,
    ...(txInhibitReason === undefined ? {} : { txInhibitReason }),
    tone,
    modulation,
    bandwidthHz: isNarrow ? BANDWIDTH_NARROW_HZ : BANDWIDTH_WIDE_HZ,
    power: { mW: powerLevel.mW, label: powerLevel.label },
    tuningStep: hz(stepHz) as Hz,
    // CHIRP declares `rf.valid_skips = []` for this radio: it has no skip flag.
    // Scan behaviour is expressed purely by scanlist membership, which lives in
    // `extras.uvk5`. Deriving a skip from "in neither scanlist" would invent a
    // field the radio does not have and, worse, stamp `S` on every exported CSV
    // row - marking every channel scan-skipped on whatever radio imported it.
    skip: 'none',
    comment: '',
    extras: {
      uvk5: {
        scanList1: (attr?.isScanlist1 ?? 0) > 0,
        scanList2: (attr?.isScanlist2 ?? 0) > 0,
        compander: attr?.compander ?? 0,
        scrambler: raw.scrambler,
        busyChannelLockout: raw.flags2.bclo > 0,
        freqReverse: raw.flags2.freqReverse > 0,
        dtmfDecode: raw.dtmfFlags.dtmfDecode > 0,
        dtmfPttId: raw.dtmfFlags.dtmfPttId,
        band: attr?.band ?? 0,
        stepIndex: raw.step,
      },
    },
  }
}

/** Best-effort tidy-up after an aborted transfer: reboot out of programming mode. */
export async function leaveProgrammingMode(t: Transport): Promise<void> {
  await resetRadio(t).catch(() => {})
}
