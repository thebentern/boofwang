// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256Hex } from '../../codec/checksum.js'
import { emptyCodeplug, type Channel, type Codeplug, type TxSpec } from '../../model/index.js'
import { ctcss, NO_TONE, type TonePair } from '../../model/tones.js'
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
import type { Transport } from '../../transport/transport.js'
import { blockData, blockIds, logicalAddress } from './image.js'
import {
  CALL_TYPE_ALL,
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
} from './protocol.js'
import { DM32UV_SCHEMA, DM32UV_SERIAL } from './schema.js'

const dec = new TextDecoder()

export function createDm32uvDriver(): RadioDriver {
  const driver: RadioDriver = {
    id: 'dm32uv',
    schema: DM32UV_SCHEMA,
    serial: { ...DM32UV_SERIAL, signals: { ...DM32UV_SERIAL.signals } },
    /**
     * There is no command to leave programming mode: the radio exits when the
     * port closes. An interrupted session therefore needs a power cycle, and
     * the UI has to say so rather than pretending it can tidy up.
     */
    abortPolicy: 'power-cycle',

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
          // Writing is not implemented. See writeImage.
          write: false,
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

    async writeImage(): Promise<WriteReport> {
      // Staged deliberately. The translation layer means a write has to
      // re-discover the map, read-modify-write whole pages and follow
      // relocation, and 22 of this radio's 59 allocated blocks have no
      // documented meaning at all. Read, decode and backup ship first.
      throw new WriteBlockedError('the DM-32UV')
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

    encode(): RadioImage {
      throw new WriteBlockedError('the DM-32UV')
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

    ownedRanges: () => [],
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
  const tone: TonePair =
    !digital && raw.rxTone !== 0 && raw.rxTone !== 0xffff
      ? { rx: ctcss(raw.rxTone & 0x3fff), tx: null, rxInverted: false }
      : NO_TONE

  const level = raw.mode.power ? DM32UV_SCHEMA.rf.powerLevels[1]! : DM32UV_SCHEMA.rf.powerLevels[0]!

  return {
    index,
    name: raw.name.trimEnd(),
    rxFreq,
    tx,
    txAllowed,
    ...(txAllowed ? {} : { txInhibitReason: 'Transmit forbidden on this channel' }),
    tone,
    modulation: digital ? 'DMR' : 'FM',
    bandwidthHz: raw.bandwidth & 0x01 ? 25_000 : 12_500,
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
      },
    },
  }
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
