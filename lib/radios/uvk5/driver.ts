// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump, sha256Hex } from '../../codec/checksum.js'
import { diffRanges, equalBytes } from '../../codec/struct.js'
import { emptyCodeplug, txFrequency, type Channel, type Codeplug, type TxSpec } from '../../model/index.js'
import { ctcss, dtcs, NO_TONE, type TonePair, type ToneSpec } from '../../model/tones.js'
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
  REGIONS,
  SHIFT_MINUS,
  SHIFT_PLUS,
  TONE_CTCSS,
  TONE_DTCS_N,
  TONE_DTCS_R,
  TUNING_STEPS_HZ,
  UVK5_ATTRIBUTES,
  UVK5_CHANNEL,
  UVK5_NAME,
  VFO_CHANNEL_NAMES,
} from './layout.js'
import { MEM_BLOCK, MEM_SIZE, PROG_SIZE, readMem, resetRadio, sayHello, writeMem } from './protocol.js'
import { encodeInto } from './encode.js'
import { UVK5_SCHEMA, UVK5_SERIAL } from './schema.js'
import { classifyFirmware, variantsCompatible } from './variants.js'
import { CTCSS_DECIHZ, DTCS_CODES } from '../../model/tones.js'

const PROGRAMMABLE_START = REGIONS[0].start

/** Decode one code field into a ToneSpec, or null when the index is out of range. */
function decodeTone(flag: number, code: number): ToneSpec | null {
  if (flag === TONE_CTCSS) {
    const t = CTCSS_DECIHZ[code]
    return t === undefined ? null : ctcss(t)
  }
  if (flag === TONE_DTCS_N || flag === TONE_DTCS_R) {
    const c = DTCS_CODES[code]
    return c === undefined ? null : dtcs(c, flag === TONE_DTCS_R ? 'R' : 'N')
  }
  return null
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
      // Calibration is factory-set per unit, so it is the natural fingerprint,
      // and it is 768 bytes - six extra reads, well under a second.
      const cal = new Uint8Array(MEM_SIZE - PROG_SIZE)
      for (let off = 0; off < cal.length; off += MEM_BLOCK) {
        ctx.signal?.throwIfAborted()
        cal.set(await readMem(t, PROG_SIZE + off, MEM_BLOCK, { timeoutMs, signal: ctx.signal, adapter: ctx.adapter }), off)
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
      // cannot restore calibration is not a backup.
      const regions = REGIONS.map((r) => ({
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
          `the ${schema.model}. The write path has not been verified against hardware in this build`,
        )
      }
      if (!ctx.dryRun && !ctx.backup) throw new BackupRequiredError('uvk5')

      const timeoutMs = ctx.readTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS
      const opts = { timeoutMs, signal: ctx.signal, adapter: ctx.adapter }

      const source = image.regions.find((r) => r.start === PROGRAMMABLE_START && !r.readOnly)
      if (!source) throw new DriverError('This image has no writable region')
      if (source.data.length !== PROG_SIZE) {
        // A short region would make `subarray` yield empty blocks and send
        // zero-length write commands to live EEPROM addresses; a long one would
        // be silently truncated. Neither should ever reach a radio.
        throw new DriverError(
          `This image's programmable region is ${source.data.length} bytes; the UV-K5 expects exactly ${PROG_SIZE}.`,
        )
      }
      const payload = source.data

      const ident = await driver.identify(t, ctx)
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
        const live = new Uint8Array(PROG_SIZE)
        for (let addr = 0; addr < PROG_SIZE; addr += MEM_BLOCK) {
          ctx.signal?.throwIfAborted()
          live.set(await readMem(t, addr, MEM_BLOCK, opts), addr)
          ctx.progress?.({ phase: 'read', done: addr + MEM_BLOCK, total: PROG_SIZE, label: 'checking the radio' })
        }

        const expected = ctx.baseImage?.regions.find((r) => r.start === PROGRAMMABLE_START)?.data
        if (expected && expected.length === PROG_SIZE && !equalBytes(live, expected)) {
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
        for (let addr = 0; addr < PROG_SIZE; addr += MEM_BLOCK) {
          ctx.signal?.throwIfAborted()
          const block = payload.subarray(addr, addr + MEM_BLOCK)
          const label = `0x${addr.toString(16).padStart(4, '0')}`

          if (equalBytes(block, live.subarray(addr, addr + MEM_BLOCK))) {
            operations.push({ addr, length: MEM_BLOCK, label, skipped: 'unchanged' })
            ctx.progress?.({ phase: 'write', done: addr + MEM_BLOCK, total: PROG_SIZE, label })
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
          ctx.progress?.({ phase: 'write', done: addr + MEM_BLOCK, total: PROG_SIZE, label })
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

      for (let i = 0; i < CHANNEL_COUNT; i++) {
        const ch = decodeChannel(mem, i)
        if (ch) cp.channels.set(ch.index, ch)
      }

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
      encodeInto(region.data, doc)
      // The hash describes bytes that have changed, so it is recomputed when
      // the image is persisted rather than carried over from the base.
      return { ...out, sha256: '' }
    },

    validate(doc: Codeplug): Diagnostic[] {
      const out: Diagnostic[] = []
      for (const ch of doc.channels.values()) {
        const band = UVK5_SCHEMA.rf.bands.find((b) => ch.rxFreq >= b.loHz && ch.rxFreq <= b.hiHz)
        if (!band) {
          out.push({
            severity: 'error',
            ruleId: 'radio.band.rx-out-of-range',
            channel: ch.index,
            field: 'rxFreq',
            message: `${(ch.rxFreq / 1e6).toFixed(5)} MHz is outside every band this radio covers.`,
          })
        }

        // The transmit frequency, not the receive one: a repeater shift can
        // move transmit into a band where transmitting is not allowed even
        // though the channel is perfectly legal to listen on.
        //
        // Slots past the memory range are the radio's own VFO band presets, not
        // user channels, and they are exempt. Every stock UV-K5 ships with its
        // F2 preset parked on 108.250 MHz in the air band, so applying the rule
        // there gives every radio two permanent errors about data the user did
        // not create. Worse, the only remedy on offer - "mark the channel
        // receive-only" - has no meaning for a VFO, and acting on it would
        // stamp a minus shift and an offset into the radio's factory band
        // preset. CHIRP has no equivalent rule at all.
        const txHz = ch.index > NAMED_CHANNEL_COUNT ? null : txFrequency(ch)
        if (txHz !== null) {
          const txBand = UVK5_SCHEMA.rf.bands.find((b) => txHz >= b.loHz && txHz <= b.hiHz)
          if (!txBand) {
            out.push({
              severity: 'error',
              ruleId: 'radio.band.tx-out-of-range',
              channel: ch.index,
              field: 'tx',
              message: `This channel transmits on ${(txHz / 1e6).toFixed(5)} MHz, which is outside every band this radio covers.`,
            })
          } else if (!txBand.txAllowed) {
            // The air band is the case that matters here: AM aviation spectrum,
            // which no amateur licence authorises transmitting on. The schema
            // marks it receive-only; this is what makes that marking do
            // something rather than merely document an intention.
            out.push({
              severity: 'error',
              ruleId: 'regulatory.band.tx-not-permitted',
              channel: ch.index,
              field: 'tx',
              message:
                `This channel can transmit on ${(txHz / 1e6).toFixed(5)} MHz, in the ${txBand.label} band, ` +
                'which is receive-only. Mark the channel receive-only before writing it to a radio.',
            })
          }
        }
        // The VFO pseudo-channels have no name storage; their names are the
        // radio's own fixed labels ("F3(136M-174M)B"), which are longer than
        // the user-name limit by design. Complaining about them would be
        // complaining about the radio.
        const isSpecial = ch.index > NAMED_CHANNEL_COUNT
        if (!isSpecial && ch.name.length > UVK5_SCHEMA.memory.nameLength) {
          out.push({
            severity: 'warning',
            ruleId: 'radio.name.too-long',
            channel: ch.index,
            field: 'name',
            message: `Name is ${ch.name.length} characters; the radio shows ${UVK5_SCHEMA.memory.nameLength}.`,
          })
        }
      }
      return out
    },

    ownedRanges(regionStart: number) {
      // The calibration region is claimed by nobody, which is what makes it
      // impossible to write.
      return regionStart === PROGRAMMABLE_START ? ownedRangesProgrammable() : []
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
