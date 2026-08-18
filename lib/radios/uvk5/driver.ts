// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256Hex } from '../../codec/checksum.js'
import { emptyCodeplug, txFrequency, type Channel, type Codeplug, type TxSpec } from '../../model/index.js'
import { ctcss, dtcs, NO_TONE, type TonePair, type ToneSpec } from '../../model/tones.js'
import { hz, type Hz } from '../../model/units.js'
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
import { MEM_BLOCK, MEM_SIZE, readMem, resetRadio, sayHello } from './protocol.js'
import { UVK5_SCHEMA, UVK5_SERIAL } from './schema.js'
import { classifyFirmware } from './variants.js'
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

export function createUvk5Driver(): RadioDriver {
  const driver: RadioDriver = {
    id: 'uvk5',
    schema: UVK5_SCHEMA,
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
      const firmware = await sayHello(t, 5, { timeoutMs, signal: ctx.signal })
      const variant = classifyFirmware(firmware)
      ctx.log?.info(`UV-K5 firmware ${JSON.stringify(firmware)} → layout ${variant.layout}`)
      ctx.progress?.({ phase: 'handshake', done: 1, total: 1, label: firmware })

      const raw = new TextEncoder().encode(firmware)
      return {
        radioId: 'uvk5',
        variant: firmware,
        layout: variant.layout,
        raw,
        caps: {
          read: true,
          // Writing is additionally gated by the schema until the write path is
          // verified on hardware; this flag records only what the firmware allows.
          write: variant.canWrite,
          ...(variant.note === undefined ? {} : { reason: variant.note }),
        },
        identHash: await sha256Hex(new TextEncoder().encode(`uvk5|${firmware}`)),
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

    async writeImage(_t, _image, _ctx): Promise<WriteReport> {
      // Deliberately absent until v0.2. Read, decode and backup ship first so
      // the round-trip invariant has real fixtures behind it before anything
      // is sent back to a radio.
      throw new WriteBlockedError('the UV-K5')
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

    encode(_doc, _base): RadioImage {
      throw new WriteBlockedError('the UV-K5')
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
        const txHz = txFrequency(ch)
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
    skip: attr !== null && attr.isScanlist1 === 0 && attr.isScanlist2 === 0 ? 'skip' : 'none',
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
