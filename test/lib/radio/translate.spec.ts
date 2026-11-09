// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { hz, mW } from '#core/model/units.js'
import { SCHEMAS } from '#core/radio/registry.js'
import {
  acceptTranslation,
  clampChannel,
  groupClamps,
  translateChannels,
  type ClampChange,
  type ClampRule,
} from '#core/radio/translate.js'
import { txFrequency, type Channel } from '#core/model/channel.js'
import { encodeShift } from '#core/radios/uvk5/encode.js'
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

describe('a split onto a radio that stores only a shift', () => {
  // The UV-K5 lists no split among its duplexes and its encoder refuses one,
  // so a CSV row with Duplex=split used to stage as a channel nothing could
  // write. CHIRP's `_import_duplex` is the rule followed, thresholds and all.
  const split = (rx: number, tx: number) => channel({ rxFreq: hz(rx), tx: { kind: 'split', txFreq: hz(tx) } })
  const shiftOf = (out: ReturnType<typeof clampChannel>) => out.changes.find((c) => c.rule === 'shift')

  it('becomes the shift that reaches the same transmit frequency', () => {
    const out = clampChannel(split(146_520_000, 147_120_000), UVK5)
    expect(out.channel?.tx).toEqual({ kind: 'offset', direction: 'plus', offset: hz(600_000) })
    expect(txFrequency(out.channel!)).toBe(147_120_000)
    expect(shiftOf(out)).toMatchObject({ field: 'tx', before: 'split to 147.12000 MHz', after: 'plus 0.60000 MHz' })
  })

  it('becomes a minus shift below the receive frequency, and simplex on it', () => {
    expect(clampChannel(split(146_940_000, 146_340_000), UVK5).channel?.tx).toEqual({
      kind: 'offset',
      direction: 'minus',
      offset: hz(600_000),
    })
    expect(clampChannel(split(146_520_000, 146_520_000), UVK5).channel?.tx).toEqual({ kind: 'simplex' })
  })

  it('is something the UV-K5 encoder will write, where the split was not', () => {
    const before = split(146_520_000, 147_120_000)
    expect(() => encodeShift(before)).toThrow(/split/)
    expect(() => encodeShift(clampChannel(before, UVK5).channel!)).not.toThrow()
  })

  it('arrives receive-only when it is wider than a shift is held to', () => {
    // 2 m to 70 cm. CHIRP refuses this one. Stopping transmit is rule 2's
    // adjustment, and it keeps the channel to listen on.
    const out = clampChannel(split(146_520_000, 446_000_000), UVK5)
    expect(out.refusal).toBeNull()
    expect(out.channel?.txAllowed).toBe(false)
    expect(out.channel?.tx).toEqual({ kind: 'split', txFreq: hz(446_000_000) })
    expect(shiftOf(out)).toMatchObject({ field: 'txAllowed', before: 'transmits', after: 'receive-only' })
    expect(shiftOf(out)?.why).toContain('15 MHz')
  })

  it('holds a shift to 15 MHz up to 500 MHz and 50 MHz above, as CHIRP does', () => {
    // One wide band, so only the limit decides. Exactly the limit converts and
    // a hertz more does not; 500 MHz itself belongs to the lower range.
    const band = { loHz: hz(100_000_000), hiHz: hz(1_000_000_000), label: 'wide', txAllowed: true }
    const wide = { ...UVK5, rf: { ...UVK5.rf, bands: [band] } } as RadioSchema
    const transmits = (rx: number, tx: number) => clampChannel(split(rx, tx), wide).channel?.txAllowed
    expect(transmits(400_000_000, 415_000_000)).toBe(true)
    expect(transmits(400_000_000, 415_000_001)).toBe(false)
    expect(transmits(500_000_000, 485_000_000)).toBe(true)
    expect(transmits(500_000_000, 484_999_999)).toBe(false)
    expect(transmits(600_000_000, 650_000_000)).toBe(true)
    expect(transmits(600_000_000, 650_000_001)).toBe(false)
  })

  it('leaves a split alone on a radio that stores one', () => {
    const out = clampChannel(split(146_520_000, 147_120_000), UV82)
    expect(out.channel?.tx).toEqual({ kind: 'split', txFreq: hz(147_120_000) })
    expect(ruleIds(out)).not.toContain('shift')
  })

  it('says a conversion and a receive-only arrival apart', () => {
    // Both are the shift rule. Summarized by rule alone, as the copy dialog
    // does, whichever came first stood for both and the receive-only one -
    // the one that matters - could vanish behind a routine conversion.
    const groups = groupClamps([
      ...clampChannel({ ...split(146_520_000, 147_120_000), index: 18 }, UVK5).changes,
      ...clampChannel({ ...split(146_520_000, 446_000_000), index: 19 }, UVK5).changes,
    ])
    expect(groups.map((g) => [g.label, g.field, g.slots, g.sample.after])).toEqual([
      ['Shift', 'tx', [18], 'plus 0.60000 MHz'],
      ['Shift', 'txAllowed', [19], 'receive-only'],
    ])
  })

  it('leaves the split of a receive-only channel alone', () => {
    // Its transmit side is not what the UV-K5 is told. Turning transmit back
    // on is the editor's business, and the editor says what this radio holds.
    const out = clampChannel({ ...split(146_520_000, 147_120_000), txAllowed: false }, UVK5)
    expect(out.channel?.tx).toEqual({ kind: 'split', txFreq: hz(147_120_000) })
    expect(ruleIds(out)).not.toContain('shift')
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

describe('a DMR channel arriving on a radio that has no DMR', () => {
  const dmrChannel = () =>
    channel({
      modulation: 'DMR',
      bandwidthHz: 12_500,
      extras: { vendor: { colorCode: '7', timeSlot: '2', txContact: '3', scanList: '1' } },
    })

  it('drops the digital settings rather than leaving them on an FM channel', () => {
    // The modulation rule already said "everything DMR specific about the
    // channel does not carry over". That has to be true of the bytes too: an
    // FM channel still carrying a color code is inert on the UV-82 that
    // cannot read it, and read back as real the moment that codeplug is
    // transplanted onto a radio that can.
    const out = clampChannel(dmrChannel(), UV82)
    expect(out.channel?.modulation).toBe('FM')
    expect(out.channel?.extras.vendor?.colorCode).toBeUndefined()
    expect(out.channel?.extras.vendor?.timeSlot).toBeUndefined()
    expect(out.channel?.extras.vendor?.txContact).toBeUndefined()
  })

  it('keeps the vendor keys that are not about being digital', () => {
    const out = clampChannel(dmrChannel(), UV82)
    expect(out.channel?.extras.vendor?.scanList).toBe('1')
  })

  it('says what it dropped rather than doing it quietly', () => {
    const out = clampChannel(dmrChannel(), UV82)
    const said = out.changes.filter((c) => c.rule === 'modulation')
    expect(said.length).toBeGreaterThanOrEqual(2)
    expect(said.map((c) => c.before).join(' ')).toContain('colorCode')
  })

  it('removes the vendor bag entirely when nothing survives', () => {
    const only = channel({
      modulation: 'DMR',
      extras: { vendor: { colorCode: '7' } },
    })
    const out = clampChannel(only, UV82)
    expect(out.channel?.extras.vendor).toBeUndefined()
  })

  it('leaves a DMR channel alone on a radio that has DMR', () => {
    const out = clampChannel(dmrChannel(), DM32)
    expect(out.channel?.modulation).toBe('DMR')
    expect(out.channel?.extras.vendor?.colorCode).toBe('7')
    expect(out.channel?.extras.vendor?.timeSlot).toBe('2')
  })

  it('still carries extras untouched when the modulation is supported', () => {
    // The regression guard for the change above. `extras` travels untouched
    // everywhere else in translate.ts, and a same-radio copy must keep doing
    // so - per-radio blocks included.
    const fm = channel({ extras: { vendor: { colorCode: '7', anything: 'x' } } })
    const out = clampChannel(fm, UV82)
    expect(out.channel?.extras.vendor).toEqual({ colorCode: '7', anything: 'x' })
  })
})

describe('what the clamp did, said once per kind of change', () => {
  const change = (index: number, rule: ClampRule, field: string): ClampChange => ({
    index,
    rule,
    field,
    before: 'before',
    after: 'after',
    why: `why for ${index}`,
  })
  const groups = groupClamps([
    change(5, 'name', 'name'),
    change(3, 'shift', 'txAllowed'),
    change(2, 'name', 'name'),
    change(4, 'shift', 'tx'),
    change(2, 'power', 'power'),
  ])

  it('gathers by rule and field, in the order the rules run', () => {
    // Within a rule, fields keep the order they were first met in.
    expect(groups.map((g) => [g.label, g.field, g.slots])).toEqual([
      ['Shift', 'txAllowed', [3]],
      ['Shift', 'tx', [4]],
      ['Name', 'name', [2, 5]],
      ['Power', 'power', [2]],
    ])
  })

  it('keeps the first one met as the sample, whose why it shows', () => {
    // Slot 5 came first, so its why is the one shown, labeled with its slot.
    expect(groups[2]!.sample.why).toBe('why for 5')
  })

  it('gathers refusals the same way', () => {
    const refused = [223_500_000, 224_000_000].map(
      (rx, i) => clampChannel(channel({ index: 10 + i, rxFreq: hz(rx) }), UV82).refusal!,
    )
    expect(groupClamps(refused).map((g) => [g.label, g.slots])).toEqual([['Receive frequency', [10, 11]]])
  })
})
