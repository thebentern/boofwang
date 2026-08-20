// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256Hex } from '../../codec/checksum.js'
import { emptyCodeplug, type Channel, type Codeplug, type TxSpec } from '../../model/index.js'
import { CTCSS_DECIHZ, ctcss, dtcs, NO_TONE, type TonePair, type ToneSpec } from '../../model/tones.js'
import { hz } from '../../model/units.js'
import {
  DEFAULT_DRIVER_TIMEOUT_MS,
  DriverError,
  WriteBlockedError,
  type Diagnostic,
  type DriverCtx,
  type IdentifyResult,
  type RadioDriver,
  type WriteReport,
} from '../../radio/driver.js'
import type { RadioImage } from '../../radio/image.js'
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
  identify as doIdentify,
  readBlock,
  readFirmware,
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

export function createUv82Driver(): RadioDriver {
  const driver: RadioDriver = {
    id: 'uv82',
    schema: UV82_SCHEMA,
    serial: { ...UV82_SERIAL, signals: { ...UV82_SERIAL.signals } },
    // No reset command exists in this protocol; the radio leaves clone mode
    // when the port closes, and the UI says so.
    abortPolicy: 'power-cycle',

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
          // Writing is not implemented yet; see writeImage.
          write: false,
          ...(basetype === null
            ? {
                reason:
                  `Firmware ${JSON.stringify(fw.version)} is not one this build recognises, so its memory ` +
                  'layout cannot be assumed. The radio can still be read and backed up.',
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

    async writeImage(): Promise<WriteReport> {
      // Read, decode and backup first, exactly as the UV-K5 was brought up:
      // the round-trip invariant needs real fixtures behind it before anything
      // is sent to a radio.
      throw new WriteBlockedError('the UV-82')
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

    encode(): RadioImage {
      throw new WriteBlockedError('the UV-82')
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
