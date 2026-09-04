// SPDX-License-Identifier: GPL-3.0-or-later
import type { RadioDriver } from '../../radio/driver.js'
import { createUv5rFamilyDriver, type Uv5rFamilyModel, type Uv5rFamilyOptions } from '../uv82/driver.js'
import { classifyBasetype, MAGIC_UV5G } from './protocol.js'
import { UV5G_SCHEMA } from './schema.js'

/**
 * The whole driver is the uv82 module's, on purpose.
 *
 * CHIRP's `RadioddityUV5GRadio` is a bare subclass of `BaofengUV5R` - same
 * memory map, same block protocol, same quirks - and this mirrors that
 * relationship rather than re-deriving it. Anything this radio did differently
 * on the wire would belong in `Uv5rFamilyModel`, not in a copy of the driver.
 */
const UV5G_MODEL: Uv5rFamilyModel = {
  id: 'uv5g',
  label: 'UV-5G',
  magics: [MAGIC_UV5G],
  schema: UV5G_SCHEMA,
  classify: classifyBasetype,
}

export function createUv5gDriver(options: Uv5rFamilyOptions = {}): RadioDriver {
  return createUv5rFamilyDriver(UV5G_MODEL, options)
}
