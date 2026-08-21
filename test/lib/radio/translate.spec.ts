// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { hz, mW } from '#core/model/units.js'
import { SCHEMAS } from '#core/radio/registry.js'
import { acceptTranslation, clampChannel, translateChannels } from '#core/radio/translate.js'
import type { Channel } from '#core/model/channel.js'
import type { RadioSchema } from '#core/radio/schema.js'

/**
 * Moving channels between models.
 *
 * The point of the pipeline is that most of these have a plausible-looking
 * wrong answer, so each rule is provoked deliberately and the test says which
 * wrong answer it is guarding against.
 */
const UVK5 = SCHEMAS.uvk5!
const UV82 = SCHEMAS.uv82!
const DM32 = SCHEMAS.dm32uv!
const MINI = SCHEMAS.uv5rmini!

function channel(over: Partial<Channel> = {}): Channel {
  return {
    index: 1,
    name: 'RPT',
    rxFreq: hz(146_940_000),
    tx: { kind: 'simplex' },
    txAllowed: true,
    tone: { rx: null, tx: null, rxInverted: false },
    modulation: 'FM',
    bandwidthHz: 25_000,
    power: { mW: mW(5000) },
    tuningStep: hz(5_000),
    skip: 'none',
    comment: '',
    extras: {},
    ...over,
  } as Channel
}
const ruleIds = (r: { changes: readonly { rule: string }[] }) => r.changes.map((c) => c.rule)

describe('a channel the target cannot receive', () => {
  it('is refused rather than moved somewhere it would fit', () => {
    // 220 MHz means nothing on a radio that stops at 174, and putting it
    // elsewhere would invent a channel nobody asked for.
    const out = clampChannel(channel({ rxFreq: hz(223_500_000) }), UV82)
    expect(out.channel).toBeNull()
    expect(out.refusal?.rule).toBe('rx-band')
  })
})

describe('a channel that would transmit where it must not', () => {
  it('arrives receive-only when transmit lands outside every band', () => {
    const out = clampChannel(channel({ tx: { kind: 'split', txFreq: hz(27_185_000) } }), UV82)
    expect(out.channel?.txAllowed).toBe(false)
    expect(ruleIds(out)).toContain('tx-band')
  })

  it('arrives receive-only when transmit lands in a receive-only band', () => {
    const air = UVK5.rf.bands.find((b) => !b.txAllowed)
    if (!air) return
    const middle = Math.round((air.loHz + air.hiHz) / 2)
    const out = clampChannel(channel({ rxFreq: hz(middle) }), UVK5)
    expect(out.channel?.txAllowed).toBe(false)
    expect(out.changes.find((c) => c.rule === 'tx-band')?.why).toContain('receive-only')
  })

  it('is refused outright when the radio cannot be told not to transmit', () => {
    // The failure the flag exists for. There is no adjustment that makes a
    // receive-only channel safe on a radio with no inhibit, so it does not go.
    const noInhibit = { ...UV82, rf: { ...UV82.rf, txInhibit: false } } as RadioSchema
    const out = clampChannel(channel({ txAllowed: false }), noInhibit)
    expect(out.channel).toBeNull()
    expect(out.refusal?.rule).toBe('tx-inhibit')
    expect(out.refusal?.why).toContain('transmit-capable')
  })

  it('lets an ordinary receive-only channel through where the radio can enforce it', () => {
    const out = clampChannel(channel({ txAllowed: false }), UV82)
    expect(out.channel?.txAllowed).toBe(false)
    expect(out.refusal).toBeNull()
  })
})

describe('names', () => {
  it('truncates to what the radio shows', () => {
    const out = clampChannel(channel({ name: 'LONGNAMEHERE' }), UV82)
    expect(out.channel!.name).toHaveLength(UV82.memory.nameLength)
    expect(ruleIds(out)).toContain('name')
  })

  it('drops characters the radio has no glyph for', () => {
    const out = clampChannel(channel({ name: 'W4~ABC' }), UV82)
    expect(out.channel!.name).not.toContain('~')
  })
})

describe('tones', () => {
  it('moves CTCSS to the nearest the radio has, because a tenth of a hertz still opens squelch', () => {
    const missing = 1001
    expect(UV82.rf.ctcssDeciHz).not.toContain(missing)
    const out = clampChannel(channel({ tone: { rx: null, tx: { kind: 'ctcss', deciHz: missing }, rxInverted: false } }), UV82)
    const tx = out.channel!.tone.tx!
    expect(tx.kind).toBe('ctcss')
    expect(UV82.rf.ctcssDeciHz).toContain((tx as { deciHz: number }).deciHz)
  })

  it('drops a DCS code the radio lacks instead of approximating it', () => {
    /*
     * The one the issue singles out. The UV-17 Pro family carries 105 codes
     * because it appends 645; the standard table has 104. A near code is a
     * DIFFERENT code, and programming it holds the squelch shut - worse than no
     * tone at all, and silent.
     */
    expect(MINI.rf.dtcsCodes).toContain(645)
    expect(UVK5.rf.dtcsCodes).not.toContain(645)

    const out = clampChannel(channel({ tone: { rx: null, tx: { kind: 'dtcs', code: 645, polarity: 'N' }, rxInverted: false } }), UVK5)
    expect(out.channel!.tone.tx).toBeNull()
    expect(out.changes.find((c) => c.rule === 'tone')!.after).toBe('none')
    expect(out.changes.find((c) => c.rule === 'tone')!.why).toContain('squelch shut')
  })

  it('leaves a code the radio does have exactly alone', () => {
    const shared = UVK5.rf.dtcsCodes.find((c) => MINI.rf.dtcsCodes.includes(c))!
    const out = clampChannel(channel({ tone: { rx: null, tx: { kind: 'dtcs', code: shared, polarity: 'R' }, rxInverted: false } }), MINI)
    expect(out.channel!.tone.tx).toEqual({ kind: 'dtcs', code: shared, polarity: 'R' })
    expect(ruleIds(out)).not.toContain('tone')
  })
})

describe('bandwidth and power', () => {
  it('snaps bandwidth down, never up', () => {
    const out = clampChannel(channel({ bandwidthHz: 20_000 }), UV82)
    expect(out.channel!.bandwidthHz).toBe(12_500)
    expect(out.changes.find((c) => c.rule === 'bandwidth')!.why).toContain('narrowband')
  })

  it('takes the closest power without going over', () => {
    // 8 W onto a radio whose levels are 1.5/3/5 W must land on 5, not 8.
    const out = clampChannel(channel({ power: { mW: mW(8000) } }), UVK5)
    expect(out.channel!.power.mW).toBe(5000)
    expect(out.channel!.power.mW).toBeLessThan(8000)
  })
})

describe('what survives the trip', () => {
  it('keeps the per-radio block, so copying back is lossless', () => {
    const extras = { uvk5: { compander: 2 }, vendor: { odd: 'thing' } } as unknown as Channel['extras']
    const out = clampChannel(channel({ extras }), DM32)
    expect(out.channel!.extras).toEqual(extras)
  })

  it('does not mutate the channel it was given', () => {
    const original = channel({ name: 'LONGNAMEHERE', bandwidthHz: 20_000 })
    const before = JSON.stringify(original)
    clampChannel(original, UV82)
    expect(JSON.stringify(original)).toBe(before)
  })
})

describe('a bank at a time', () => {
  it('reports what changed, what was refused, and what has nowhere to go', () => {
    const result = translateChannels({
      channels: [
        channel({ index: 1, name: 'LONGNAMEHERE' }),
        channel({ index: 2, rxFreq: hz(223_500_000) }),
        channel({ index: 3 }),
      ],
      target: UV82,
      carries: { talkGroups: 6, contacts: 147, radioIds: 1 },
    })

    expect(result.refusals.map((r) => r.index)).toEqual([2])
    expect(result.changes.some((c) => c.index === 1 && c.rule === 'name')).toBe(true)
    expect(result.rows.filter((r) => r.channel !== null)).toHaveLength(2)
    // An analog radio has no concept of any of these, and the caller is told
    // rather than left to notice.
    expect(result.dropped.join(' ')).toMatch(/talk group/)
    expect(result.dropped.join(' ')).toMatch(/contact/)
  })

  it('says nothing is dropped when the target has the features', () => {
    const result = translateChannels({
      channels: [channel()],
      target: DM32,
      carries: { talkGroups: 6, contacts: 147, radioIds: 1 },
    })
    expect(result.dropped).toEqual([])
  })
})

describe('accepting', () => {
  // A power level the UV-82 actually has, so each row provokes exactly one
  // rule and "refuse this rule" can be told apart from "refuse that one".
  const uv82Power = { mW: mW(UV82.rf.powerLevels[0]!.mW) }
  const result = () =>
    translateChannels({
      channels: [
        channel({ index: 1, name: 'LONGNAMEHERE', power: uv82Power }),
        channel({ index: 2, bandwidthHz: 20_000, power: uv82Power }),
      ],
      target: UV82,
    })

  it('takes everything when nothing is filtered', () => {
    expect(acceptTranslation(result(), {}).map((c) => c.index)).toEqual([1, 2])
  })

  it('takes only the rows chosen', () => {
    expect(acceptTranslation(result(), { rows: new Set([2]) }).map((c) => c.index)).toEqual([2])
  })

  it('drops a row whose rule was refused, rather than committing half of it', () => {
    // Refusing the name rule must not quietly write the untruncated name: the
    // row depended on that change, so the row does not go.
    const taken = acceptTranslation(result(), { rules: new Set(['bandwidth']) })
    expect(taken.map((c) => c.index)).toEqual([2])
  })

  it('never returns a channel that was refused outright', () => {
    const refused = translateChannels({ channels: [channel({ rxFreq: hz(223_500_000) })], target: UV82 })
    expect(acceptTranslation(refused, {})).toEqual([])
  })
})
