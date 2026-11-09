// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Channel } from '#core/model/channel.js'
import { hz, mW } from '#core/model/units.js'
import { SCHEMAS } from '#core/radio/registry.js'
import { validateChannel } from '#core/validate/rules.js'

/**
 * Where a rule is about the license, the interface states it and lets the
 * person go on.
 *
 * boofwang states a regulatory rule and its citation, and the operator - who
 * holds the license - decides; `lib/validate/rules.ts` gives the reasoning.
 * Three places broke that the same way, a rule feeding a `disabled`:
 *
 * - The channel editor refused Apply on any channel holding a key on a band
 *   where encryption is prohibited, so the TAC 1-14 channels a CPS had
 *   encrypted on GMRS could not even be renamed.
 * - It refused Apply on a channel that may transmit in a band the radio's plan
 *   marks receive-only, too - long after the validator had made that rule a
 *   warning, and while the table's inline edit let the same frequency through.
 * - The monitor export dropped encrypted channels on prohibited bands, which
 *   left the keys page's export button disabled on the radio it was built for.
 *
 * A source check, for the reason `ui-features.spec.ts` gives: there is no Vue
 * harness in this suite, and each defect was one expression reaching for the
 * wrong thing. What the monitor files hold is tested properly, in
 * `test/lib/io/monitor-profile.spec.ts`, and the rule the editor borrows is
 * run for real below.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const EDITOR = read('../../app/components/ChannelEditor.vue')
const KEYS = read('../../app/pages/keys.vue')

describe('the channel editor', () => {
  const canSave = /const canSave = computed\(\(\) => ([^\n]*)\)\n/.exec(EDITOR)?.[1]
  const rxError = /const rxError = computed\(\(\) => \{([\s\S]*?)\n\}\)/.exec(EDITOR)?.[1]
  const alert = /<UAlert\s[^>]*v-if="encKeyId !== 0 && legality"[^>]*>/.exec(EDITOR)?.[0]
  const bandRule = /d\.ruleId === '([^']+)'/.exec(EDITOR)?.[1]

  it('finds the expressions it is meant to check', () => {
    expect(canSave, 'ChannelEditor.vue no longer declares canSave on one line').toBeDefined()
    expect(rxError, 'ChannelEditor.vue no longer declares rxError where this looks').toBeDefined()
    expect(alert, 'the encryption alert is no longer where this looks for it').toBeDefined()
    expect(bandRule, 'the editor no longer picks its transmit warning by rule id').toBeDefined()
  })

  it('never lets the encryption rule decide whether Apply works', () => {
    expect(canSave).not.toMatch(/legal|encrypt|blocked/i)
  })

  it('never lets a receive-only band decide it either', () => {
    // The receive field's error is for what the radio cannot do: a frequency
    // that does not parse, or one outside every band. Whether the channel may
    // transmit there is not its business.
    expect(rxError).not.toMatch(/txAllowed/)
  })

  it('still states the encryption rule and its citation', () => {
    expect(EDITOR).toMatch(/encryptionLegality\(/)
    expect(EDITOR).toContain('{{ legality.reason }}')
    expect(EDITOR).toContain('{{ legality.cfr }}')
  })

  it('does not color the encryption notice as an error, which would say it blocks', () => {
    expect(alert).not.toMatch(/error/)
  })

  it('shows the band warning under the transmit switch, which is what silences it', () => {
    expect(EDITOR).toMatch(/v-else-if="txWarning"/)
  })

  it('takes that warning from a rule the validator emits, as a warning', () => {
    // The editor picks the diagnostic by id, so a renamed rule would leave it
    // silent rather than broken. Run the rule on a channel that transmits in
    // a receive-only band, with the bands handed over the way the editor does.
    const schema = SCHEMAS.uv5rmini!
    const air: Channel = {
      index: 1,
      name: 'AIR',
      rxFreq: hz(121_500_000),
      tx: { kind: 'simplex' },
      txAllowed: true,
      tone: { rx: null, tx: null, rxInverted: false },
      modulation: 'FM',
      bandwidthHz: 25_000,
      power: { mW: mW(5000), label: 'High' },
      tuningStep: hz(5000),
      skip: 'none',
      comment: '',
      extras: {},
    }
    const bands = [{ loHz: hz(108_000_000), hiHz: hz(136_000_000), label: 'test air', txAllowed: false }]
    const found = validateChannel(air, schema, { bands }).filter((d) => d.ruleId === bandRule)
    expect(found.map((d) => d.severity)).toEqual(['warning'])
  })
})

describe('the monitor keys export', () => {
  const button = /<RiskAction[^>]*label="Export monitor keys"[^>]*\/>/.exec(KEYS)?.[0]

  it('finds the button it is meant to check', () => {
    expect(button, 'keys.vue no longer has an Export monitor keys action').toBeDefined()
  })

  it('is never disabled', () => {
    expect(button).not.toMatch(/disabled/)
  })

  it('opens its confirmation whatever the file would hold', () => {
    // The confirmation used to open only when there was a key to save. Kept
    // that way, an enabled button would be one that does nothing when tapped.
    expect(KEYS).toMatch(/<div v-if="confirmingKeys"[\s>]/)
  })
})
