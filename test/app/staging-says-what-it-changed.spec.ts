// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Staging says what this radio makes of the channels, before it stages them.
 *
 * It used to clamp only as it wrote, and report only refusals, in a toast,
 * afterwards. A name cut short, a power level lowered, a tone dropped, a
 * channel made receive-only: all applied without a word. The reason the clamp
 * gave for that last one was stored on the channel and shown nowhere either.
 *
 * A source check, for the reason `ui-features.spec.ts` gives: there is no Vue
 * harness in this suite. What the clamp does, and how its changes group, is
 * tested properly in `test/lib/radio/translate.spec.ts`.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const PRESETS = read('../../app/pages/presets.vue')
const EDITOR = read('../../app/components/ChannelEditor.vue')

describe('the presets plan', () => {
  it('clamps every placement with the call staging makes', () => {
    // Twice: once in the plan and once in `stage`. One without the other is a
    // plan describing something the button does not do.
    expect(PRESETS.match(/presetToClampedChannel\(/g) ?? []).toHaveLength(2)
  })

  it('says what was adjusted and what was left out, once per kind', () => {
    expect(PRESETS).toMatch(/groupClamps\(/)
    expect(PRESETS).toMatch(/v-for="g in plan\.adjusted"/)
    expect(PRESETS).toMatch(/v-for="g in plan\.leftOut"/)
  })

  it('marks a refused row rather than calling it an add, and does not count it', () => {
    expect(PRESETS).toMatch(/kind: 'out'/)
    expect(PRESETS).toMatch(/placements\.length - plan\.value\.refused/)
  })
})

describe('the channel editor', () => {
  it('says why a channel is receive-only, when it arrived with a reason', () => {
    expect(EDITOR).toMatch(/props\.channel\.txInhibitReason/)
    expect(EDITOR).toMatch(/v-if="!txAllowed && arrivedReason"/)
  })

  it('keeps that reason through an edit rather than overwriting it', () => {
    expect(EDITOR).toMatch(/props\.channel\.txAllowed \? undefined : props\.channel\.txInhibitReason/)
  })
})
