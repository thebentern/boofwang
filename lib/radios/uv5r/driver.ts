// SPDX-License-Identifier: GPL-3.0-or-later
import type { RadioDriver } from '../../radio/driver.js'
import { createUv5rFamilyDriver, type Uv5rFamilyModel, type Uv5rFamilyOptions } from '../uv82/driver.js'
import { classifyBasetype, MAGICS_UV5R } from './protocol.js'
import { UV5R_SCHEMA } from './schema.js'

/**
 * The whole driver is the uv82 module's, on purpose.
 *
 * The inheritance runs the other way round from how it reads here: CHIRP's
 * `BaofengUV5R` is the base class and `BaofengUV82Radio` is the subclass, so
 * what `createUv5rFamilyDriver` implements is this radio's protocol and this
 * radio's memory map. The UV-82 got there first in boofwang, which is why the
 * shared code lives under `uv82/`. Nothing about that is a claim that the
 * UV-82's behavior was assumed for this radio - the layout being shared is
 * upstream's own structure, not an inference.
 *
 * Anything this radio did differently on the wire would belong in
 * `Uv5rFamilyModel`, not in a copy of the driver. Two magics is such a thing,
 * and that is where it went.
 */
const UV5R_MODEL: Uv5rFamilyModel = {
  id: 'uv5r',
  label: 'UV-5R',
  magics: MAGICS_UV5R,
  schema: UV5R_SCHEMA,
  classify: classifyBasetype,
}

export function createUv5rDriver(options: Uv5rFamilyOptions = {}): RadioDriver {
  return createUv5rFamilyDriver(UV5R_MODEL, options)
}
