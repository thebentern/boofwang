// SPDX-License-Identifier: GPL-3.0-or-later
import type { RadioId } from '../model/codeplug.js'
import { createDm32uvDriver } from '../radios/dm32uv/driver.js'
import { createUv82Driver } from '../radios/uv82/driver.js'
import { createUv5rMiniDriver } from '../radios/uv5rmini/driver.js'
import { createUvk5Driver } from '../radios/uvk5/driver.js'
import type { RadioDriver } from './driver.js'
import type { RadioSchema } from './schema.js'

/**
 * Every radio boofwang knows about.
 *
 * Adding one should mean a new folder under `lib/radios/` and a line here -
 * nothing under `app/`. If a new radio forces a UI change, the RadioSchema is
 * missing something, and that is the thing to fix.
 */

export const DRIVER_FACTORIES: Record<RadioId, (() => RadioDriver) | null> = {
  // Writing is enabled. The encoder round-trips a real radio's EEPROM byte for
  // byte, the write path survived an adversarial review, and every block is
  // read back and compared before the next is sent - but see
  // docs/protocols/uvk5.md for exactly which parts have been exercised against
  // hardware and which have not.
  uvk5: () => createUvk5Driver({ enableWrite: true }),
  // Writing is enabled and deliberately narrow: only the channel records and
  // the name table, sent as the 16-byte blocks that differ from the image the
  // radio was read from. The two windows CHIRP has always skipped fall outside
  // both, so a diff-driven write cannot reach them. See docs/protocols/uv82.md.
  uv82: () => createUv82Driver({ enableWrite: true }),
  // Writing is enabled, and deliberately narrow: only the encryption key slots
  // in logical block 0x10. This radio's pages move between sessions and 22 of
  // its 59 allocated blocks have no documented meaning, so every other byte is
  // read, preserved and never sent back. See docs/protocols/dm32uv.md.
  dm32uv: () => createDm32uvDriver({ enableWrite: true }),
  // A UV-17 Pro family radio despite the name: 115200 baud, obfuscated 64-byte
  // blocks. Writing sends the WHOLE image every time - this radio erases a
  // flash page before programming and writes back only the block it was handed,
  // so a sparse write wipes everything sharing that page. It erased 19 channels
  // on a real radio before that was understood. See docs/protocols/uv5rmini.md.
  uv5rmini: () => createUv5rMiniDriver({ enableWrite: true }),
}

export const SCHEMAS: Record<RadioId, RadioSchema | null> = {
  // The schema the UI renders must match what the driver enforces.
  uvk5: createUvk5Driver({ enableWrite: true }).schema,
  uv82: createUv82Driver({ enableWrite: true }).schema,
  dm32uv: createDm32uvDriver({ enableWrite: true }).schema,
  uv5rmini: createUv5rMiniDriver({ enableWrite: true }).schema,
}

export const RADIO_IDS: readonly RadioId[] = ['uvk5', 'uv82', 'uv5rmini', 'dm32uv']

export function createDriver(id: RadioId): RadioDriver {
  const factory = DRIVER_FACTORIES[id]
  if (!factory) throw new Error(`No driver is implemented for ${id} yet`)
  return factory()
}

export function isImplemented(id: RadioId): boolean {
  return DRIVER_FACTORIES[id] !== null
}

export const IMPLEMENTED_DRIVERS: readonly RadioId[] = RADIO_IDS.filter(isImplemented)

/**
 * Drivers ordered by how well a connected USB device matches them.
 *
 * A hint for ordering the port picker, never an identification: the CH340 in a
 * typical programming cable is in countless unrelated devices, so the handshake
 * is what actually decides.
 */
export function rankByUsb(info: { usbVendorId?: number; usbProductId?: number }): RadioDriver[] {
  const rank = { likely: 0, possible: 1, no: 2 } as const
  return IMPLEMENTED_DRIVERS.map(createDriver)
    .map((d) => ({ d, r: rank[d.match(info)] }))
    .filter((x) => x.r < 2)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.d)
}
