// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256Hex } from '../../codec/checksum.js'
import { emptyCodeplug, type Channel, type Codeplug, type TxSpec } from '../../model/index.js'
import { NO_TONE, type TonePair } from '../../model/tones.js'
import { hz, mW } from '../../model/units.js'
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
  BLOCK_SIZE,
  VARIANTS,
  handshake,
  imageSize,
  readBlock,
  type Uv5rVariant,
} from './protocol.js'
import {
  CHANNEL_BASE,
  CHANNEL_SIZE,
  UV5RM_CHANNEL,
  decodeName,
  decodeToneWord,
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

export function createUv5rMiniDriver(): RadioDriver {
  const driver: RadioDriver = {
    id: 'uv5rmini',
    schema: UV5RMINI_SCHEMA,
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
          // Writing is not implemented. Read, decode and a hardware fixture
          // come first, in the order every other radio here was brought up.
          write: false,
          reason: 'Writing to the UV-5R Mini is not implemented yet.',
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

    async writeImage(): Promise<WriteReport> {
      throw new WriteBlockedError('the UV-5R Mini')
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

    encode(): RadioImage {
      throw new WriteBlockedError('the UV-5R Mini')
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
     * Nothing is claimed yet, because nothing is written yet.
     *
     * An empty set means any byte the encoder changed would be flagged as a
     * defect - which is the correct answer while `encode` throws.
     */
    ownedRanges: () => [],
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
