// SPDX-License-Identifier: GPL-3.0-or-later
import type { RadioId } from '../model/codeplug.js'

/**
 * The name a person knows a radio by, for a sentence that would otherwise
 * carry its id: "came from a UV-82", not "came from a uv82".
 *
 * This is a table rather than a lookup over `SCHEMAS` because of who needs it.
 * `registry.ts` builds `SCHEMAS` by calling every driver factory at load time,
 * and the messages that want a model name live in `driver.ts` and inside the
 * drivers - so reaching for the registry from here would close a cycle that
 * trips on an uninitialized binding depending on which module a test imports
 * first. `test/lib/radio/model-name.spec.ts` holds this table to the schemas
 * so the two cannot drift.
 */
const MODEL_NAMES: Record<RadioId, string> = {
  uvk5: 'UV-K5',
  uv82: 'UV-82',
  uv5g: 'UV-5G',
  uv5r: 'UV-5R',
  uv5rmini: 'UV-5R Mini',
  dm32uv: 'DM-32UV',
}

/**
 * Takes any string, because the id often arrives from a file header or a
 * CSV comment rather than from this build; an id this build does not know is
 * returned as it came, which is still more useful than nothing.
 */
export function modelName(id: RadioId | string): string {
  return (MODEL_NAMES as Record<string, string | undefined>)[id] ?? id
}
