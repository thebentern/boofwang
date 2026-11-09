// SPDX-License-Identifier: GPL-3.0-or-later
import type { RadioDriver } from '../../radio/driver.js'
import { createWp970iFamilyDriver, type Wp970iFamilyModel, type Wp970iFamilyOptions } from '../uv9r/driver.js'
import { IDENT_UV9G, MAGIC_UV9G } from './protocol.js'
import { UV9G_SCHEMA } from './schema.js'

/**
 * The whole driver is the uv9r module's, on purpose.
 *
 * CHIRP's `UV9G` and `UV9R` are sibling subclasses of `WP970I`, one memory map
 * and one protocol between them, and this mirrors that rather than deriving it
 * again. Anything this radio did differently on the wire would belong in
 * `Wp970iFamilyModel`, not in a copy of the driver.
 */
const UV9G_MODEL: Wp970iFamilyModel = {
  id: 'uv9g',
  label: 'UV-9G',
  magics: [MAGIC_UV9G],
  schema: UV9G_SCHEMA,
  knownIdents: [IDENT_UV9G],
}

export function createUv9gDriver(options: Wp970iFamilyOptions = {}): RadioDriver {
  return createWp970iFamilyDriver(UV9G_MODEL, options)
}
