// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Firmware identification.
 *
 * The UV-K5 has a large custom-firmware ecosystem, and the variants do not all
 * share an EEPROM layout - egzumer moves the calibration boundary, for one. So
 * the firmware string reported at hello decides which layout applies, and an
 * unrecognised string means the layout is unknown.
 *
 * Unknown firmware is **read-only, never unreadable**. Refusing to talk to it
 * would be worse than useless: a backup is exactly what someone with an
 * unsupported firmware needs, and the image they send back is how the variant
 * gets supported. What is withheld is writing, because writing a layout we have
 * guessed at is how radios get bricked.
 *
 * Approved prefixes are from `k5_approve_firmware` in CHIRP's uvk5.py.
 */

export interface VariantInfo {
  readonly layout: string
  readonly label: string
  /** First address of the calibration region: never written by a normal upload. */
  readonly calStart: number
  readonly canWrite: boolean
  readonly note?: string
}

interface VariantRule {
  readonly prefixes: readonly string[]
  readonly info: VariantInfo
}

const STOCK: VariantInfo = {
  layout: 'stock',
  label: 'Stock firmware',
  calStart: 0x1d00,
  canWrite: true,
}

export const VARIANT_RULES: readonly VariantRule[] = [
  {
    // The original OEM firmwares, plus 1.02.x which OEM shipped in late 2025,
    // plus the widely-used "oneofeleven" user builds.
    prefixes: ['k5_2.01.', 'app_2.01.', '2.01.', '3.00.', '4.00.', 'k5_4.00.', '5.00.', '7.00.', '1o11', '1.02.'],
    info: STOCK,
  },
  {
    prefixes: ['EGZUMER '],
    info: {
      layout: 'egzumer',
      label: 'egzumer custom firmware',
      calStart: 0x1e00,
      canWrite: false,
      note:
        'The egzumer layout is decoded - channels, names and settings all read - but nothing has ever ' +
        'been written to a radio running it, so writing stays off until one has been.',
    },
  },
]

export const UNKNOWN_VARIANT: VariantInfo = {
  layout: 'unknown',
  label: 'Unrecognised firmware',
  calStart: 0x1d00,
  canWrite: false,
  note:
    'This firmware is not recognised, so its memory layout cannot be assumed. ' +
    'The radio can still be read and backed up, and sending that backup in is how support gets added.',
}

export function classifyFirmware(firmware: string): VariantInfo {
  for (const rule of VARIANT_RULES) {
    if (rule.prefixes.some((p) => firmware.startsWith(p))) return rule.info
  }
  return UNKNOWN_VARIANT
}

/**
 * The variant an already-read image belongs to, by the layout name stamped on
 * it rather than by a firmware string.
 *
 * A stored image is the case that needs this: a `.bwp` records the layout, and
 * a file opened from disk may carry no firmware string at all, so
 * `classifyFirmware` has nothing to work from. Where the layout is not one this
 * build knows, the stock geometry is the safe answer - it is the smaller
 * programmable region of the two, so nothing decides to write past a boundary
 * on the strength of a guess.
 */
export function variantForLayout(layout: string): VariantInfo {
  for (const rule of VARIANT_RULES) {
    if (rule.info.layout === layout) return rule.info
  }
  return UNKNOWN_VARIANT
}

/** Whether an image read from `imageVariant` may be written to `connectedVariant`. */
export function variantsCompatible(imageVariant: string, connectedVariant: string): boolean {
  if (imageVariant === connectedVariant) return true
  const a = classifyFirmware(imageVariant)
  const b = classifyFirmware(connectedVariant)
  return a.layout === b.layout && a.layout !== 'unknown'
}
