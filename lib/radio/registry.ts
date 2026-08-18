// SPDX-License-Identifier: GPL-3.0-or-later
import type { RadioId } from '../model/codeplug.js'
import { createUvk5Driver } from '../radios/uvk5/driver.js'
import { UVK5_SCHEMA } from '../radios/uvk5/schema.js'
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
  uvk5: createUvk5Driver,
  // Planned. Listed so the UI can show them honestly as unimplemented rather
  // than pretending they do not exist.
  uv5rmini: null,
  dm32uv: null,
}

export const SCHEMAS: Record<RadioId, RadioSchema | null> = {
  uvk5: UVK5_SCHEMA,
  uv5rmini: null,
  dm32uv: null,
}

export const RADIO_IDS: readonly RadioId[] = ['uvk5', 'uv5rmini', 'dm32uv']

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
