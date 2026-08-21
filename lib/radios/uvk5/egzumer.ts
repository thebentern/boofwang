// SPDX-License-Identifier: GPL-3.0-or-later
import { u16le } from '../../codec/fields.js'
import type { Channel, Modulation, TxSpec } from '../../model/channel.js'
import type { Codeplug } from '../../model/codeplug.js'
import { NO_TONE, type TonePair } from '../../model/tones.js'
import { hz, type Hz } from '../../model/units.js'
import { DriverError } from '../../radio/driver.js'
import {
  attrAddr,
  BANDWIDTH_NARROW_HZ,
  BANDWIDTH_WIDE_HZ,
  CHANNEL_COUNT,
  channelAddr,
  EMPTY_FREQ,
  NAMED_CHANNEL_COUNT,
  NAME_SIZE,
  nameAddr,
  POWER_HIGH,
  POWER_MEDIUM,
  SHIFT_MINUS,
  SHIFT_PLUS,
  UVK5_ATTRIBUTES,
  UVK5_NAME,
} from './layout.js'
import {
  BUILD_OPTIONS_ADDR,
  EGZUMER_BUILD_OPTIONS,
  EGZUMER_CHANNEL,
  EGZUMER_SETTINGS,
  EGZUMER_SETTINGS_BASE,
  EGZUMER_STEPS_HZ,
  egzumerBandForFreq,
  egzumerVfoChannelNames,
  fmPresetAddr,
  FM_PRESET_COUNT,
  MODULATION_AM,
  MODULATION_FM,
  MODULATION_USB,
} from './egzumer-layout.js'
import { decodeTone, encodePowerRaw, encodeShift, encodeToneField, isErasedRecord } from './encode.js'
import { UVK5_SCHEMA } from './schema.js'

/**
 * Decoding and encoding the egzumer layout.
 *
 * Deliberately a separate module from the stock codec rather than a set of
 * branches inside it. The two layouts agree about most of the radio, but where
 * they disagree they disagree about the meaning of individual bits, and a
 * shared function threaded with `if (egzumer)` is how the wrong branch ends up
 * writing the right-looking byte. The cost is a little repetition; what it buys
 * is that neither firmware can be broken by a change made for the other.
 *
 * Nothing here writes to a radio. `canWrite` is false for this firmware, and
 * `writeImage` refuses on the variant before it reaches any of this - the
 * encoders exist so that a codeplug can be edited, saved and round-tripped, and
 * so that the round-trip invariant can be asserted at all.
 */

const ERASE_FILL = 0xff

/** How CHIRP marks an attribute slot unused: `is_free = 1`, `band = 7`. */
const FREE_ATTR = { isScanlist1: 0, isScanlist2: 0, compander: 0, isFree: 1, band: 0x7 } as const

// ----------------------------------------------------------- build options --

export interface BuildOptions {
  readonly dtmfCalling: boolean
  readonly pwronPassword: boolean
  readonly tx1750: boolean
  readonly alarm: boolean
  readonly vox: boolean
  readonly voice: boolean
  readonly noaa: boolean
  readonly fmRadio: boolean
  readonly spectrum: boolean
  readonly amFix: boolean
  readonly blminTmpOff: boolean
  readonly rawDemodulators: boolean
  readonly wideRx: boolean
  readonly flashlight: boolean
}

/**
 * What this firmware was compiled with, read from the calibration region.
 *
 * Wide receive is the one that changes how the rest of the image decodes: it
 * swaps the band plan and, with it, the names the radio gives its fourteen VFO
 * presets. Assuming it when the flags cannot be read matches CHIRP, whose
 * `_get_bands` returns the wide table whenever it has no memory object to
 * consult - and the wide table is the superset, so assuming it never rejects a
 * frequency the radio would have accepted.
 */
export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  dtmfCalling: false,
  pwronPassword: false,
  tx1750: false,
  alarm: false,
  vox: false,
  voice: false,
  noaa: false,
  fmRadio: false,
  spectrum: false,
  amFix: false,
  blminTmpOff: false,
  rawDemodulators: false,
  wideRx: true,
  flashlight: false,
}

/** Read the build flags out of a calibration region that begins at `regionStart`. */
export function readBuildOptions(calibration: Uint8Array, regionStart: number): BuildOptions {
  const off = BUILD_OPTIONS_ADDR - regionStart
  if (off < 0 || off + EGZUMER_BUILD_OPTIONS.size > calibration.length) return DEFAULT_BUILD_OPTIONS
  const raw = EGZUMER_BUILD_OPTIONS.read(calibration, off)
  const on = (v: number) => v > 0
  return {
    dtmfCalling: on(raw.first.enableDtmfCalling),
    pwronPassword: on(raw.first.enablePwronPassword),
    tx1750: on(raw.first.enableTx1750),
    alarm: on(raw.first.enableAlarm),
    vox: on(raw.first.enableVox),
    voice: on(raw.first.enableVoice),
    noaa: on(raw.first.enableNoaa),
    fmRadio: on(raw.first.enableFmRadio),
    spectrum: on(raw.second.enableSpectrum),
    amFix: on(raw.second.enableAmFix),
    blminTmpOff: on(raw.second.enableBlminTmpOff),
    rawDemodulators: on(raw.second.enableRawDemodulators),
    wideRx: on(raw.second.enableWideRx),
    flashlight: on(raw.second.enableFlashlight),
  }
}

// ---------------------------------------------------------------- channels --

/** The step this index means, following CHIRP's fallback for one out of range. */
const stepHzAt = (index: number) => EGZUMER_STEPS_HZ[index] ?? EGZUMER_STEPS_HZ[0]

/** Nearest supported tuning step, preferring the index the channel arrived with. */
export function encodeEgzumerStepIndex(ch: Channel): number {
  // The index the record was found with wins whenever it still means the step
  // the channel carries. That is not the same as looking the step up: an index
  // past the end of the table decodes to the table's first entry, so looking it
  // up would rewrite it as index 0 - a byte the user never touched, changed on
  // a record this build admits it does not understand.
  const stored = ch.extras.uvk5?.stepIndex
  if (stored !== undefined && stored >= 0 && stored <= 0xff && stepHzAt(stored) === ch.tuningStep) return stored

  const exact = EGZUMER_STEPS_HZ.indexOf(ch.tuningStep as (typeof EGZUMER_STEPS_HZ)[number])
  if (exact >= 0) return exact
  if (stored !== undefined && stored >= 0 && stored < EGZUMER_STEPS_HZ.length) return stored
  let best = 0
  let bestDelta = Number.POSITIVE_INFINITY
  for (let i = 0; i < EGZUMER_STEPS_HZ.length; i++) {
    const d = Math.abs(EGZUMER_STEPS_HZ[i]! - ch.tuningStep)
    if (d < bestDelta) {
      best = i
      bestDelta = d
    }
  }
  return best
}

/**
 * Decode one channel record, or null when the slot is empty.
 *
 * The empty test, the transmit-inhibit trick and the tone handling are stock's,
 * because egzumer inherits all three from CHIRP's base UV-K5 driver unchanged.
 */
export function decodeEgzumerChannel(mem: Uint8Array, i: number, build: BuildOptions): Channel | null {
  const raw = EGZUMER_CHANNEL.read(mem, channelAddr(i))
  if (raw.freq === EMPTY_FREQ || raw.freq === 0) return null

  const rxFreq = hz(raw.freq)
  const offset = hz(raw.offset)

  // As on stock: this radio has no transmit-inhibit bit, and CHIRP expresses
  // "receive only" as a minus shift whose offset equals the receive frequency,
  // putting the transmit frequency at 0 MHz.
  let tx: TxSpec = { kind: 'simplex' }
  let txAllowed = true
  let txInhibitReason: string | undefined

  if (offset !== 0) {
    if (raw.modeFlags.shift === SHIFT_MINUS) {
      if (raw.offset === raw.freq) {
        txAllowed = false
        txInhibitReason = 'Transmit frequency parked at 0 MHz'
      } else {
        tx = { kind: 'offset', direction: 'minus', offset }
      }
    } else if (raw.modeFlags.shift === SHIFT_PLUS) {
      tx = { kind: 'offset', direction: 'plus', offset }
    }
  }

  const rx = decodeTone(raw.codeFlags.rxCodeFlag, raw.rxCode)
  const txTone = decodeTone(raw.codeFlags.txCodeFlag, raw.txCode)
  const tone: TonePair = rx === null && txTone === null ? NO_TONE : { rx, tx: txTone, rxInverted: false }

  const isNarrow = raw.flags2.bandwidth > 0
  const powerLevel =
    raw.flags2.txPower === POWER_HIGH
      ? UVK5_SCHEMA.rf.powerLevels[2]!
      : raw.flags2.txPower === POWER_MEDIUM
        ? UVK5_SCHEMA.rf.powerLevels[1]!
        : UVK5_SCHEMA.rf.powerLevels[0]!

  const isSpecial = i >= NAMED_CHANNEL_COUNT
  const name = isSpecial
    ? (egzumerVfoChannelNames(build.wideRx)[i - NAMED_CHANNEL_COUNT] ?? '')
    : UVK5_NAME.read(mem, nameAddr(i)).name.trimEnd()

  const attr = isSpecial ? null : UVK5_ATTRIBUTES.read(mem, attrAddr(i)).attr

  return {
    index: i + 1,
    name,
    rxFreq,
    tx,
    txAllowed,
    ...(txInhibitReason === undefined ? {} : { txInhibitReason }),
    tone,
    modulation: decodeModulation(raw.modeFlags.modulation),
    bandwidthHz: isNarrow ? BANDWIDTH_NARROW_HZ : BANDWIDTH_WIDE_HZ,
    power: { mW: powerLevel.mW, label: powerLevel.label },
    tuningStep: hz(stepHzAt(raw.step)) as Hz,
    // Unchanged from stock: this radio has no skip flag at all, so scan
    // behaviour is scanlist membership and nothing else.
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

/**
 * The `modulation` nibble as a demodulator.
 *
 * Values above 2 are not ones the firmware produces. CHIRP logs them and falls
 * back to FM, which is what happens here too - with one deliberate difference:
 * CHIRP also discards the bandwidth bit in that case, and this does not, so an
 * unrecognised record still round-trips the narrow flag it was found with
 * rather than being rewritten as wide.
 */
function decodeModulation(nibble: number): Modulation {
  if (nibble === MODULATION_AM) return 'AM'
  if (nibble === MODULATION_USB) return 'USB'
  return 'FM'
}

/**
 * The nibble to store for a demodulator, given what the record already holds.
 *
 * `current` is consulted for the same reason the step index is: three of the
 * sixteen values this nibble can hold have a meaning, and every other value
 * decodes as FM. Writing the canonical 0 back over one of the thirteen would
 * change a byte on a record this build has already admitted it does not
 * understand, and break the round trip for it.
 */
function encodeModulation(m: Modulation, current: number, index: number): number {
  if (decodeModulation(current) === m) return current
  switch (m) {
    case 'FM':
      return MODULATION_FM
    case 'AM':
      return MODULATION_AM
    case 'USB':
      return MODULATION_USB
    default:
      throw new DriverError(
        `Channel ${index}: this radio can store FM, AM or USB, not ${m}. ` +
          'Change the modulation before writing it to a radio.',
      )
  }
}

/** Blank a slot: 0xFF through the record and the name, attributes marked free. */
export function eraseEgzumerChannel(mem: Uint8Array, slot: number): void {
  const addr = channelAddr(slot)
  mem.fill(ERASE_FILL, addr, addr + EGZUMER_CHANNEL.size)
  if (slot < NAMED_CHANNEL_COUNT) {
    const n = nameAddr(slot)
    mem.fill(ERASE_FILL, n, n + NAME_SIZE)
    UVK5_ATTRIBUTES.write(mem, attrAddr(slot), { attr: { ...FREE_ATTR } })
  }
}

export function encodeEgzumerChannel(mem: Uint8Array, slot: number, ch: Channel): void {
  const addr = channelAddr(slot)

  // A previously-erased record is all ones. Zero it first so the bits this
  // struct does not name do not start life set - the same rule stock follows,
  // and what CHIRP does for a fresh memory.
  if (isErasedRecord(mem, addr, EGZUMER_CHANNEL.size)) mem.fill(0x00, addr, addr + EGZUMER_CHANNEL.size)

  const { shift, offset } = encodeShift(ch)
  const tx = encodeToneField(ch.tone.tx, `Channel ${ch.index} transmit tone`)
  const rx = encodeToneField(ch.tone.rx, `Channel ${ch.index} receive tone`)
  const e = ch.extras.uvk5
  const currentModulation = EGZUMER_CHANNEL.read(mem, addr).modeFlags.modulation

  EGZUMER_CHANNEL.write(mem, addr, {
    freq: ch.rxFreq,
    offset,
    rxCode: rx.code,
    txCode: tx.code,
    codeFlags: { txCodeFlag: tx.flag, rxCodeFlag: rx.flag },
    modeFlags: { modulation: encodeModulation(ch.modulation, currentModulation, ch.index), shift },
    flags2: {
      bandwidth: ch.bandwidthHz <= BANDWIDTH_NARROW_HZ ? 1 : 0,
      txPower: encodePowerRaw(ch),
      bclo: e?.busyChannelLockout ? 1 : 0,
      freqReverse: e?.freqReverse ? 1 : 0,
    },
    dtmfFlags: { dtmfPttId: e?.dtmfPttId ?? 0, dtmfDecode: e?.dtmfDecode ? 1 : 0 },
    step: encodeEgzumerStepIndex(ch),
    scrambler: e?.scrambler ?? 0,
  })

  if (slot >= NAMED_CHANNEL_COUNT) return

  UVK5_NAME.write(mem, nameAddr(slot), { name: ch.name.slice(0, UVK5_SCHEMA.memory.nameLength) })
  UVK5_ATTRIBUTES.write(mem, attrAddr(slot), {
    attr: {
      isScanlist1: e?.scanList1 ? 1 : 0,
      isScanlist2: e?.scanList2 ? 1 : 0,
      compander: e?.compander ?? 0,
      isFree: 0,
      band: egzumerBandForFreq(ch.rxFreq),
    },
  })
}

// ---------------------------------------------------------------- settings --

/**
 * The bit fields, and the flat keys each one contributes.
 *
 * A codeplug's `settings` is a flat record because the schema that renders it
 * is a flat list of controls, so the three packed bytes have to be spread on
 * the way out and gathered on the way back. Listing the members here rather
 * than deriving them keeps the two directions provably symmetric: every name
 * below is read and written by the same table.
 *
 * `displayFlags.unused` is deliberately absent. The struct still names that bit
 * so the byte is fully declared, but surfacing a reserved bit as a setting
 * would put a key called "unused" in every saved codeplug for no purpose - and
 * leaving it out of the patch is not a risk, because the struct's setter is
 * read-modify-write per slice and preserves what it is not given.
 */
const BIT_GROUPS = {
  backlightLevels: ['backlightMin', 'backlightMax'],
  menuKey: ['keyMLongpressAction', 'buttonBeep'],
  displayFlags: ['backlightOnTxRx', 'amFix', 'micBar', 'batteryText', 'liveDtmfDecoder'],
} as const

type BitGroupName = keyof typeof BIT_GROUPS

const BIT_MEMBER_PARENT = new Map<string, BitGroupName>(
  (Object.entries(BIT_GROUPS) as [BitGroupName, readonly string[]][]).flatMap(([parent, members]) =>
    members.map((m) => [m, parent] as [string, BitGroupName]),
  ),
)

/** Keys of the settings struct that are plain scalars, not packed bit fields. */
const SCALAR_KEYS = Object.keys(EGZUMER_SETTINGS.layout).filter((k) => !(k in BIT_GROUPS))

/** The settings key for FM preset `i`, counted from zero; the label is 1-based. */
export const fmPresetKey = (i: number) => `fmPreset${i + 1}`

/**
 * Everything the settings window holds, flattened into codeplug settings.
 *
 * The FM broadcast presets come along because they are the other half of what
 * this layout puts in the 0x0E40-0x0F48 stretch, and the build flags because
 * they explain the rest of the decode - a bug report that says "wide receive
 * was off" is worth a great deal more than one that does not.
 */
export function decodeEgzumerSettings(mem: Uint8Array, build: BuildOptions): Record<string, unknown> {
  const raw = EGZUMER_SETTINGS.read(mem, EGZUMER_SETTINGS_BASE) as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const key of SCALAR_KEYS) out[key] = raw[key]
  for (const [parent, members] of Object.entries(BIT_GROUPS) as [BitGroupName, readonly string[]][]) {
    const packed = raw[parent] as Record<string, number>
    for (const m of members) out[m] = packed[m]
  }

  for (let i = 0; i < FM_PRESET_COUNT; i++) out[fmPresetKey(i)] = u16le.get(mem, fmPresetAddr(i))

  out.buildWideRx = build.wideRx ? 1 : 0
  out.buildFmRadio = build.fmRadio ? 1 : 0
  out.buildNoaa = build.noaa ? 1 : 0
  out.buildDtmfCalling = build.dtmfCalling ? 1 : 0
  out.buildSpectrum = build.spectrum ? 1 : 0
  out.buildAmFix = build.amFix ? 1 : 0

  return out
}

/**
 * Patch changed settings back into the programmable region.
 *
 * Only what differs is written, and only keys the struct names. Everything
 * else - the runs inside the window no field claims, and the build flags,
 * which live in the read-only calibration region and are reported rather than
 * offered - is left exactly as the radio had it.
 */
export function encodeEgzumerSettings(mem: Uint8Array, settings: Record<string, unknown>): void {
  const current = EGZUMER_SETTINGS.read(mem, EGZUMER_SETTINGS_BASE) as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = {}

  for (const key of SCALAR_KEYS) {
    const next = settings[key]
    if (next === undefined) continue
    if (typeof next !== typeof current[key]) continue
    if (next === current[key]) continue
    patch[key] = next
  }

  for (const [member, parent] of BIT_MEMBER_PARENT) {
    const next = settings[member]
    if (typeof next !== 'number') continue
    const packed = current[parent] as Record<string, number>
    if (packed[member] === next) continue
    patch[parent] = { ...(patch[parent] as Record<string, number> | undefined), [member]: next }
  }

  if (Object.keys(patch).length > 0) EGZUMER_SETTINGS.write(mem, EGZUMER_SETTINGS_BASE, patch)

  for (let i = 0; i < FM_PRESET_COUNT; i++) {
    const next = settings[fmPresetKey(i)]
    if (typeof next !== 'number' || !Number.isInteger(next) || next < 0 || next > 0xffff) continue
    if (u16le.get(mem, fmPresetAddr(i)) === next) continue
    u16le.set(mem, fmPresetAddr(i), next)
  }
}

/**
 * Write a whole codeplug into a copy of the programmable region.
 *
 * `mem` is the bytes that came off the radio, patched in place - never a fresh
 * buffer. That is what keeps the DTMF contact list, the seven attribute entries
 * above slot 199, the calibration and every byte this build has never looked at
 * exactly as they were found.
 */
export function encodeEgzumerInto(mem: Uint8Array, doc: Codeplug): void {
  for (let slot = 0; slot < CHANNEL_COUNT; slot++) {
    const ch = doc.channels.get(slot + 1)
    if (ch) {
      encodeEgzumerChannel(mem, slot, ch)
      continue
    }
    // A slot that is already empty is left alone. Normalising it would rewrite
    // bytes nobody asked to change - this radio ships with scanlist bits set in
    // unused attribute slots - and erasing is for a channel actually deleted.
    if (!isErasedRecord(mem, channelAddr(slot), EGZUMER_CHANNEL.size)) eraseEgzumerChannel(mem, slot)
  }
  encodeEgzumerSettings(mem, doc.settings)
}
