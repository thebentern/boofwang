// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { classifyBasetype, MAGICS_UV5R, MAGIC_UV5R_291, MAGIC_UV5R_ORIG } from '#core/radios/uv5r/protocol.js'
import { MAGIC_UV5G } from '#core/radios/uv5g/protocol.js'
import { MAGIC_UV82 } from '#core/radios/uv82/protocol.js'
import { BASETYPE_F8HP, BASETYPE_KT980HP, BASETYPE_UV5R } from '#core/radios/uv82/layout.js'

/**
 * The two things about this radio that are its own: which magics it answers,
 * and what it will and will not conclude from a firmware string.
 *
 * Everything else - the memory map, the block protocol, the tone encoding - is
 * shared with the UV-82 and the UV-5G and is tested against their hardware
 * captures. This file is where the UV-5R's own decisions are pinned, and every
 * one of them is a decision about when *not* to write.
 */

describe('the magics', () => {
  it('are `UV5R_MODEL_291` and `UV5R_MODEL_ORIG`, in CHIRP’s order', () => {
    expect([...MAGIC_UV5R_291]).toEqual([0x50, 0xbb, 0xff, 0x20, 0x12, 0x07, 0x25])
    expect([...MAGIC_UV5R_ORIG]).toEqual([0x50, 0xbb, 0xff, 0x01, 0x25, 0x98, 0x4d])
    // `_idents = [UV5R_MODEL_291, UV5R_MODEL_ORIG]`. Current firmware first,
    // so the radio almost everyone has answers on the first try.
    expect(MAGICS_UV5R.map((m) => [...m])).toEqual([[...MAGIC_UV5R_291], [...MAGIC_UV5R_ORIG]])
  })

  it('differs from the UV-5G’s by a single byte', () => {
    // 0x07 here, 0x06 there, in position five. This is why CHIRP keeps the
    // UV-5G's magic in an IDENT_BLACKLIST that its UV-5R driver probes for
    // after every real magic has failed: the two radios are one byte and one
    // shelf apart, and reading either as the other would decode a GMRS band
    // plan onto a ham radio or the reverse.
    const differing = [...MAGIC_UV5R_291].filter((b, i) => b !== MAGIC_UV5G[i])
    expect(differing).toEqual([0x07])
    expect([...MAGIC_UV5R_291]).not.toEqual([...MAGIC_UV82])
  })
})

describe('the firmware classifier', () => {
  it('recognizes a plain UV-5R', () => {
    expect(classifyBasetype('BFB297')).toEqual({ model: 'UV-5R', triPower: false })
    expect(classifyBasetype('BTS20')).toEqual({ model: 'UV-5R', triPower: false })
    expect(classifyBasetype('D5R2')).toEqual({ model: 'UV-5R', triPower: false })
  })

  it('matches by containment, not by prefix', () => {
    // CHIRP's own test is `any(type in rid ...)`. The UV-5G bench unit is the
    // standing proof that prefix matching is wrong for this family: it reports
    // HN5RV011, which starts with none of the basetypes.
    expect(BASETYPE_UV5R).toContain('BFS')
    expect(classifyBasetype('XXBFS99')).toEqual({ model: 'UV-5R', triPower: false })
  })

  it('names the tri-power radios that answer this same magic, and refuses to write them', () => {
    // `UV5R_MODEL_291` is `_idents` for BaofengBFF8HPRadio and IntekKT980Radio
    // as well as for the plain radio. They are identified rather than rejected
    // so the user is told which radio they have, and `triPower` is what stops
    // a Low channel being written back at 8 W.
    expect(classifyBasetype('BFP3V3 F')).toEqual({ model: 'BF-F8HP', triPower: true })
    expect(classifyBasetype('N5R3')).toEqual({ model: 'BF-F8HP', triPower: true })
    expect(classifyBasetype('BFP3V3 B')).toEqual({ model: 'KT-980HP', triPower: true })
  })

  it('reads the one ambiguous string as the two-power radio, and leaves the check to the write', () => {
    /*
     * `N5RV` is in BASETYPE_UV5R and in BASETYPE_F8HP both, and both radios
     * answer the same magic. So a radio reporting it is a 4 W UV-5R or an 8 W
     * BF-F8HP and nothing on the wire says which.
     *
     * This used to return null, so every radio reporting it was read-only. The
     * first UV-5R anyone plugged in reported exactly that, which made the rule
     * expensive rather than theoretical: a radio whose case says UV-5R could
     * not be written at all.
     *
     * Declining was a proxy for the safety property, not the property itself.
     * What matters is whether this build's power table fits the radio's bytes,
     * and `writeImage` asks the radio that directly - it decodes and re-encodes
     * what the radio just sent and refuses if a byte moves. `lowPower` is two
     * bits, so a tri-power Mid channel holds a value this table has no entry
     * for and cannot survive the round trip. The guess is made here and checked
     * there, against bytes rather than a string.
     */
    expect(BASETYPE_UV5R).toContain('N5RV')
    expect(BASETYPE_F8HP).toContain('N5RV')
    expect(classifyBasetype('N5RV')).toEqual({ model: 'UV-5R', triPower: false })
    expect(classifyBasetype('HN5RV011')).toEqual({ model: 'UV-5R', triPower: false })
    // The string a real radio reported, which is why any of this matters.
    expect(classifyBasetype('HN5RV011!!!')).toEqual({ model: 'UV-5R', triPower: false })
  })

  it('refuses the original pre-BFB291 radios rather than guessing their aux handling', () => {
    // CHIRP uploads a different set of auxiliary ranges to these and refuses
    // an image whose era does not match the radio's. None of that has been
    // exercised here, so they are read and backed up and never written.
    expect(classifyBasetype('BFB290')).toMatchObject({ model: null })
    expect(classifyBasetype('BFB291')).toEqual({ model: 'UV-5R', triPower: false })
  })

  it('refuses a BFB string whose number cannot be read, rather than waving it through', () => {
    // The UV-5G's adversarial review found this failing open. Same shape here.
    expect(classifyBasetype('BFB29')).toMatchObject({ model: null })
    expect(classifyBasetype('BFB')).toMatchObject({ model: null })
  })

  it('refuses what it does not recognize at all', () => {
    expect(classifyBasetype('GARBAGE')).toMatchObject({ model: null })
    expect(classifyBasetype('')).toMatchObject({ model: null })
    // A UV-82 basetype behind this magic is not a thing that happens - the
    // UV-82HP answers UV5R_MODEL_UV82 - so it is not recognized here either.
    expect(classifyBasetype('US2S2')).toMatchObject({ model: null })
  })

  it('keeps every tri-power string it knows about accounted for', () => {
    // A string in the tri-power tables must never come back as two-power. The
    // whole list is walked rather than three examples of it, because a new
    // entry transcribed into the table without a thought is exactly how a
    // tri-power radio would end up being written two-power.
    for (const s of [...BASETYPE_F8HP, ...BASETYPE_KT980HP]) {
      // N5RV is the exception and the only one: it is in the two-power table
      // as well, so it cannot be settled from the string at all. It is claimed
      // as two-power here and checked against the radio's own bytes before any
      // write - see the ambiguity test above. Every string that appears ONLY in
      // a tri-power table must still come back tri-power.
      if (BASETYPE_UV5R.includes(s)) continue
      const got = classifyBasetype(s)
      expect(got.model === null || got.triPower, `${s} must not classify as two-power`).toBe(true)
    }
  })
})
