// SPDX-License-Identifier: GPL-3.0-or-later
import type { Channel } from '../../model/channel.js'
import type { Codeplug } from '../../model/codeplug.js'
import { CTCSS_DECIHZ, DTCS_CODES, type ToneSpec } from '../../model/tones.js'
import { DriverError } from '../../radio/driver.js'
import {
  ATTR_BASE,
  BANDWIDTH_NARROW_HZ,
  CHANNEL_COUNT,
  NAMED_CHANNEL_COUNT,
  NAME_SIZE,
  SHIFT_MINUS,
  SHIFT_NONE,
  SHIFT_PLUS,
  TONE_CTCSS,
  TONE_DTCS_N,
  TONE_DTCS_R,
  TONE_NONE,
  TUNING_STEPS_HZ,
  UVK5_ATTRIBUTES,
  UVK5_CHANNEL,
  UVK5_NAME,
  attrAddr,
  bandForFreq,
  channelAddr,
  nameAddr,
} from './layout.js'
import { UVK5_SCHEMA } from './schema.js'

/**
 * Turning a channel back into sixteen bytes.
 *
 * The rules here follow `set_memory` in CHIRP's `uvk5.py`, with one deliberate
 * difference. CHIRP zeroes a record and then restores a handful of bits through
 * `SAVE_MASK_0A`..`0F`; boofwang patches the record in place instead, so every
 * bit it does not model is preserved rather than reconstructed from a mask.
 * That is strictly more conservative, and it is what makes
 * `encode(decode(img), img)` byte-identical.
 *
 * The exception is a slot that was empty. An erased record is 0xFF throughout,
 * so preserving unmodelled bits would leave reserved fields set to ones. Those
 * records are zeroed first, exactly as CHIRP does.
 */

const ERASE_FILL = 0xff

/** `is_free = 1`, `band = 7`: how CHIRP marks an attribute slot unused. */
const FREE_ATTR = { isScanlist1: 0, isScanlist2: 0, compander: 0, isFree: 1, band: 0x7 } as const

export function isErasedRecord(mem: Uint8Array, addr: number, size = UVK5_CHANNEL.size): boolean {
  for (let i = 0; i < size; i++) if (mem[addr + i] !== ERASE_FILL) return false
  return true
}

export interface ToneFieldPair {
  flag: number
  code: number
}

/**
 * A tone as the radio stores it: a two-bit mode flag plus an index.
 *
 * An unsupported tone must not be silently dropped to "no tone" - a channel
 * that opens on any signal is a different channel from one that opens on 88.5
 * Hz, and quietly substituting one for the other is how someone ends up unable
 * to hear a repeater they think they are monitoring.
 */
export function encodeToneField(t: ToneSpec | null, where: string): ToneFieldPair {
  if (t === null) return { flag: TONE_NONE, code: 0 }
  if (t.kind === 'ctcss') {
    const idx = CTCSS_DECIHZ.indexOf(t.deciHz)
    if (idx < 0) {
      throw new DriverError(
        `${where}: ${(t.deciHz / 10).toFixed(1)} Hz is not one of the 50 CTCSS tones this radio supports.`,
      )
    }
    return { flag: TONE_CTCSS, code: idx }
  }
  const idx = DTCS_CODES.indexOf(t.code)
  if (idx < 0) {
    throw new DriverError(`${where}: DTCS code ${String(t.code).padStart(3, '0')} is not one this radio supports.`)
  }
  return { flag: t.polarity === 'R' ? TONE_DTCS_R : TONE_DTCS_N, code: idx }
}

/** Nearest supported tuning step, preferring the index the channel arrived with. */
export function encodeStepIndex(ch: Channel): number {
  const exact = TUNING_STEPS_HZ.indexOf(ch.tuningStep as (typeof TUNING_STEPS_HZ)[number])
  if (exact >= 0) return exact
  const stored = ch.extras.uvk5?.stepIndex
  if (stored !== undefined && stored >= 0 && stored < TUNING_STEPS_HZ.length) return stored
  let best = 0
  let bestDelta = Number.POSITIVE_INFINITY
  for (let i = 0; i < TUNING_STEPS_HZ.length; i++) {
    const d = Math.abs(TUNING_STEPS_HZ[i]! - ch.tuningStep)
    if (d < bestDelta) {
      best = i
      bestDelta = d
    }
  }
  return best
}

export function encodePowerRaw(ch: Channel): number {
  const levels = UVK5_SCHEMA.rf.powerLevels
  const byLabel = levels.find((l) => l.label === ch.power.label)
  if (byLabel) return byLabel.raw
  // Highest level at or below what was asked for; never silently more power.
  let chosen = levels[0]!
  for (const l of levels) if (l.mW <= ch.power.mW && l.mW >= chosen.mW) chosen = l
  return chosen.raw
}

interface ShiftFields {
  shift: number
  offset: number
}

/**
 * Where the radio should transmit.
 *
 * The UV-K5 has no transmit-inhibit bit. CHIRP achieves the effect by setting a
 * minus shift whose offset equals the receive frequency, so the computed
 * transmit frequency is 0 MHz. That takes precedence over any repeater shift
 * the channel also carries, which is precisely why `txAllowed` is a separate
 * flag: an encoder cannot express the shift and forget the inhibit.
 */
export function encodeShift(ch: Channel): ShiftFields {
  if (!ch.txAllowed) return { shift: SHIFT_MINUS, offset: ch.rxFreq }
  switch (ch.tx.kind) {
    case 'simplex':
      return { shift: SHIFT_NONE, offset: 0 }
    case 'offset':
      return { shift: ch.tx.direction === 'plus' ? SHIFT_PLUS : SHIFT_MINUS, offset: ch.tx.offset }
    case 'split':
      throw new DriverError(
        `Channel ${ch.index}: this radio cannot store an independent transmit frequency (split). ` +
          'Use a plus or minus offset, or mark the channel receive-only.',
      )
  }
}

/** Blank a slot: 0xFF through the record and the name, attributes marked free. */
export function eraseChannel(mem: Uint8Array, slot: number): void {
  const addr = channelAddr(slot)
  mem.fill(ERASE_FILL, addr, addr + UVK5_CHANNEL.size)
  if (slot < NAMED_CHANNEL_COUNT) {
    const n = nameAddr(slot)
    mem.fill(ERASE_FILL, n, n + NAME_SIZE)
    UVK5_ATTRIBUTES.write(mem, attrAddr(slot), { attr: { ...FREE_ATTR } })
  }
}

export function encodeChannel(mem: Uint8Array, slot: number, ch: Channel): void {
  const addr = channelAddr(slot)

  // A previously-erased record is all ones. Zero it so unmodelled bits do not
  // start life set, matching what CHIRP does for a fresh memory.
  if (isErasedRecord(mem, addr)) mem.fill(0x00, addr, addr + UVK5_CHANNEL.size)

  const { shift, offset } = encodeShift(ch)
  const tx = encodeToneField(ch.tone.tx, `Channel ${ch.index} transmit tone`)
  const rx = encodeToneField(ch.tone.rx, `Channel ${ch.index} receive tone`)
  const e = ch.extras.uvk5

  UVK5_CHANNEL.write(mem, addr, {
    freq: ch.rxFreq,
    offset,
    rxCode: rx.code,
    txCode: tx.code,
    codeFlags: { txCodeFlag: tx.flag, rxCodeFlag: rx.flag },
    flags1: { enableAm: ch.modulation === 'AM' ? 1 : 0, shift },
    flags2: {
      bandwidth: ch.bandwidthHz <= BANDWIDTH_NARROW_HZ ? 1 : 0,
      txPower: encodePowerRaw(ch),
      bclo: e?.busyChannelLockout ? 1 : 0,
      freqReverse: e?.freqReverse ? 1 : 0,
    },
    dtmfFlags: { dtmfPttId: e?.dtmfPttId ?? 0, dtmfDecode: e?.dtmfDecode ? 1 : 0 },
    step: encodeStepIndex(ch),
    scrambler: e?.scrambler ?? 0,
  })

  // Slots past 199 are the VFO presets: no name storage and no attribute byte.
  if (slot >= NAMED_CHANNEL_COUNT) return

  UVK5_NAME.write(mem, nameAddr(slot), { name: ch.name.slice(0, UVK5_SCHEMA.memory.nameLength) })
  UVK5_ATTRIBUTES.write(mem, attrAddr(slot), {
    attr: {
      isScanlist1: e?.scanList1 ? 1 : 0,
      isScanlist2: e?.scanList2 ? 1 : 0,
      compander: e?.compander ?? 0,
      isFree: 0,
      band: bandForFreq(ch.rxFreq),
    },
  })
}

/**
 * Write a whole codeplug into the programmable region of an existing image.
 *
 * `mem` is expected to be a copy of the bytes read from the radio, not a fresh
 * buffer. Everything outside the channel, name and attribute tables is left
 * exactly as the radio had it - settings, DTMF contacts, the boot logo, and
 * every byte this codebase has never decoded.
 */
export function encodeInto(mem: Uint8Array, doc: Codeplug): void {
  for (let slot = 0; slot < CHANNEL_COUNT; slot++) {
    const ch = doc.channels.get(slot + 1)
    if (ch) {
      encodeChannel(mem, slot, ch)
      continue
    }
    // A slot that is already empty is left exactly as the radio had it.
    // Normalising it would rewrite bytes nobody asked to change: this radio
    // ships with scanlist bits set in the attribute byte of unused slots, and
    // "tidying" those breaks the round-trip invariant for no benefit. Erasing
    // is for a channel the user actually deleted.
    if (!isErasedRecord(mem, channelAddr(slot))) eraseChannel(mem, slot)
  }
}

export { ATTR_BASE }
