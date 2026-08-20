// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { SCHEMAS } from '#core/radio/registry.js'
import { VARIANTS } from '#core/radios/uv5rmini/protocol.js'

/**
 * A driver labels a channel's power from the table of whatever radio actually
 * answered. The schema carries the union of both variants, so its labels do not
 * always match. Anything resolving a level has to key on the value.
 *
 * Editing any High-power channel on a UV-5R Mini used to throw because of this:
 * the label "High" matched nothing in a table that says "High (5 W)", the
 * fallback named an id no schema defines, and a non-null assertion turned that
 * into an exception inside the save handler.
 */
describe('power levels a driver can produce', () => {
  it('are all findable in the schema by value', () => {
    const schema = SCHEMAS.uv5rmini!
    for (const variant of VARIANTS) {
      for (const level of variant.power) {
        const found = schema.rf.powerLevels.find((l) => l.mW === level.mW)
        expect(found, `${variant.label} ${level.label} (${level.mW} mW)`).toBeTruthy()
      }
    }
  })

  it('covers every radio, not just the one that had the bug', () => {
    for (const [id, schema] of Object.entries(SCHEMAS)) {
      if (!schema) continue
      const ids = new Set(schema.rf.powerLevels.map((l) => l.id))
      expect(ids.size, `${id} has duplicate power ids`).toBe(schema.rf.powerLevels.length)
      expect(schema.rf.powerLevels.length, `${id} declares no power levels`).toBeGreaterThan(0)
    }
  })
})
