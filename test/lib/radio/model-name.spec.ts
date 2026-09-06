// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { modelName } from '#core/radio/model-name.js'
import { RADIO_IDS, SCHEMAS } from '#core/radio/registry.js'

describe('modelName', () => {
  // The table in model-name.ts exists only because reaching the registry from
  // driver messages would close an import cycle. This is what keeps it honest.
  it('agrees with every schema the registry builds', () => {
    for (const id of RADIO_IDS) {
      expect(modelName(id), id).toBe(SCHEMAS[id]?.model)
    }
  })

  it('returns an unknown id as it came, rather than nothing', () => {
    expect(modelName('uv99')).toBe('uv99')
  })
})
