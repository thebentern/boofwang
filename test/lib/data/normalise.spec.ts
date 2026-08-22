// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  isStorableColorCode,
  parseAccess,
  parseMHzField,
  parseMode,
  txSpecFor,
} from '#core/data/normalise.js'
import { hz } from '#core/model/units.js'

/**
 * Every literal in this file was observed in a live response from hearham or
 * BrandMeister on 2026-08-22. None of them is invented, and none of them is a
 * hypothetical edge case - which is the point. The malformed values are the
 * ones a reasonable implementation gets wrong.
 */

describe('parseAccess', () => {
  it('reads an ordinary CTCSS tone', () => {
    expect(parseAccess('100.0').tone).toEqual({ kind: 'ctcss', deciHz: 1000 })
    expect(parseAccess('88.5').tone).toEqual({ kind: 'ctcss', deciHz: 885 })
  })

  it('reads a tone written without its decimal', () => {
    // 2,061 records write `100` where 11,860 write `100.0`.
    expect(parseAccess('100').tone).toEqual({ kind: 'ctcss', deciHz: 1000 })
  })

  it('treats blank and whitespace-only fields as no tone, without complaint', () => {
    for (const raw of ['', ' ', '\u00a0']) {
      const got = parseAccess(raw)
      expect(got.tone).toBeNull()
      expect(got.issues).toEqual([])
    }
  })

  it('does not read a colour code as a tone', () => {
    // 5,600+ records put a DMR colour code in the field named `encode`.
    const got = parseAccess('CC1')
    expect(got.tone).toBeNull()
    expect(got.colorCode).toBe(1)
  })

  it('recovers both a tone and a colour code from a compound field', () => {
    const got = parseAccess('100.0/CC7/NAC 293')
    expect(got.tone).toEqual({ kind: 'ctcss', deciHz: 1000 })
    expect(got.colorCode).toBe(7)
  })

  it('ignores network access codes and DCS rather than misreading them', () => {
    const got = parseAccess('123.0/RAN1/NAC293/C/CAN0')
    expect(got.tone).toEqual({ kind: 'ctcss', deciHz: 1230 })
    expect(got.issues).toEqual([])
  })

  it('drops both tones when a field names two and does not say which is which', () => {
    // '88.5/71.9' and '71.9/127.3' are both live. Picking the first is right
    // half the time, and the other half the radio cannot open the repeater.
    for (const raw of ['88.5/71.9', '71.9/127.3', '77.0/156.7']) {
      const got = parseAccess(raw)
      expect(got.tone).toBeNull()
      expect(got.issues.join(' ')).toContain('more than one tone')
    }
  })

  it('rejects the malformed numbers that Number() would silently accept', () => {
    // Number('.0') is 0, Number('100.') is 100, Number('0000.') is 0. A
    // zero-hertz tone is not a tone.
    for (const raw of ['.0', '.123', '100.', '$145', 'A']) {
      expect(parseAccess(raw).tone, raw).toBeNull()
    }
  })

  it('reads a tone written with two decimal places', () => {
    // Roughly a hundred records write 103.50 where the rest write 103.5.
    expect(parseAccess('103.50').tone).toEqual({ kind: 'ctcss', deciHz: 1035 })
    expect(parseAccess('88.50').tone).toEqual({ kind: 'ctcss', deciHz: 885 })
    expect(parseAccess('100.00').tone).toEqual({ kind: 'ctcss', deciHz: 1000 })
  })

  it('treats an explicit zero as no tone rather than as a broken one', () => {
    // 1,320 records write some spelling of zero, meaning the repeater is open.
    // Reporting each as unreadable buried the issues that mattered.
    for (const raw of ['0', '0.0', '0.00', '000.0', '0000.']) {
      const got = parseAccess(raw)
      expect(got.tone, raw).toBeNull()
      expect(got.issues, raw).toEqual([])
    }
  })

  it('reads a DCS code written either way round', () => {
    expect(parseAccess('DCS023').tone).toEqual({ kind: 'dtcs', code: 23, polarity: 'N' })
    expect(parseAccess('D023').tone).toEqual({ kind: 'dtcs', code: 23, polarity: 'N' })
  })

  it('drops a field naming both a tone and a DCS code', () => {
    // '77.0/D454' is live. It says the repeater needs both of two different
    // things and does not say which direction either belongs to, so it gets the
    // same treatment as two CTCSS tones.
    const got = parseAccess('77.0/D454')
    expect(got.tone).toBeNull()
    expect(got.issues.join(' ')).toContain('more than one tone')
  })

  it('drops a DCS code that is not standard, and says so', () => {
    // Same reasoning as the CSV importer: a wrong DCS code keeps the squelch
    // shut, and the nearest code is simply a different code.
    const got = parseAccess('DCS999')
    expect(got.tone).toBeNull()
    expect(got.issues.join(' ')).toContain('not a standard code')
  })

  it('rejects a value outside the CTCSS band', () => {
    // '1\u00a0750.0' is a European 1750 Hz tone burst, not CTCSS. Stripping
    // non-breaking space must not turn it into a four-digit tone that passes.
    expect(parseAccess('1\u00a0750.0').tone).toBeNull()
  })

  it('snaps a near-miss to the nearest standard tone and says so', () => {
    const got = parseAccess('107.2')
    expect(got.tone).toEqual({ kind: 'ctcss', deciHz: 1072 })
    expect(got.issues).toEqual([])

    const off = parseAccess('100.1')
    expect(off.tone).toEqual({ kind: 'ctcss', deciHz: 1000 })
    expect(off.issues.join(' ')).toContain('not a standard CTCSS tone')
  })
})

describe('parseMode', () => {
  it('reads the clean values', () => {
    expect(parseMode('FM').modulation).toBe('FM')
    expect(parseMode('DMR').modulation).toBe('DMR')
    expect(parseMode('P25').modulation).toBe('P25')
  })

  it('reads every spelling of D-STAR in the live data', () => {
    for (const raw of ['D-STAR', 'D-star', 'DSTAR', 'D-STAR    ']) {
      expect(parseMode(raw).modulation, raw).toBe('DSTAR')
    }
  })

  it('ignores trailing whitespace, which 250-odd records carry', () => {
    expect(parseMode('DMR    ').modulation).toBe('DMR')
    expect(parseMode('YSF/FM ').modulation).toBe('FM')
  })

  it('takes the first mode named and leaves the downgrade to clampChannel', () => {
    // DMR/FM is a mixed-mode repeater. Recording it as FM here would make the
    // per-radio decision once, globally, and silently.
    expect(parseMode('DMR/FM').modulation).toBe('DMR')
    expect(parseMode('P25/FM').modulation).toBe('P25')
    expect(parseMode('D-STAR/FM').modulation).toBe('DSTAR')
  })

  it('finds the first mode in a run concatenated without separators', () => {
    expect(parseMode('D-STARDMR    ').modulation).toBe('DSTAR')
    expect(parseMode('P25YSFD-STARNXDNDMR/FM ').modulation).toBe('P25')
    expect(parseMode('YSFD-STAR/FM ').modulation).toBe('DSTAR')
  })

  it('does not match FM inside NFM, and carries the narrow bandwidth out', () => {
    const got = parseMode('NFM')
    expect(got.modulation).toBe('FM')
    expect(got.bandwidthHz).toBe(12_500)
    expect(parseMode('FM').bandwidthHz).toBe(25_000)
  })

  it('falls to FM when the only mode boofwang knows is the analogue half', () => {
    expect(parseMode('YSF/FM').modulation).toBe('FM')
    expect(parseMode('FM+YSF').modulation).toBe('FM')
    expect(parseMode('M17/FM ').modulation).toBe('FM')
  })

  it('refuses a mode no supported radio can use, rather than guessing FM', () => {
    for (const raw of ['YSF', 'NXDN', 'AX25', 'ATV', 'TV', 'YSF    ']) {
      const got = parseMode(raw)
      expect(got.modulation, raw).toBeNull()
      expect(got.issue, raw).toBeTruthy()
    }
  })
})

describe('parseMHzField', () => {
  it('reads BrandMeister decimal strings', () => {
    expect(parseMHzField('439.3750')).toBe(hz(439_375_000))
    expect(parseMHzField('431.7750')).toBe(hz(431_775_000))
  })

  it('rejects the zero and blank transmit fields four records carry', () => {
    for (const raw of ['0', '0.0000', '', ' ', null, undefined]) {
      expect(parseMHzField(raw), String(raw)).toBeNull()
    }
  })

  it('rejects malformed decimals rather than rounding them', () => {
    for (const raw of ['.0', '100.', '$145', 'A', '12.3.4']) {
      expect(parseMHzField(raw), raw).toBeNull()
    }
  })
})

describe('txSpecFor', () => {
  it('produces an offset for an ordinary repeater pair', () => {
    // Repeater transmits on 439.375 and listens on 431.775: a -7.6 MHz shift.
    expect(txSpecFor(hz(439_375_000), hz(431_775_000))).toEqual({
      kind: 'offset',
      direction: 'minus',
      offset: hz(7_600_000),
    })
  })

  it('produces a plus offset when the input is above the output', () => {
    expect(txSpecFor(hz(145_270_000), hz(145_870_000))).toEqual({
      kind: 'offset',
      direction: 'plus',
      offset: hz(600_000),
    })
  })

  it('is simplex when there is no input or it matches the output', () => {
    // 3,236 hearham records publish a zero offset.
    expect(txSpecFor(hz(145_500_000), null)).toEqual({ kind: 'simplex' })
    expect(txSpecFor(hz(145_500_000), hz(145_500_000))).toEqual({ kind: 'simplex' })
  })
})

describe('isStorableColorCode', () => {
  it('accepts the DMR range', () => {
    expect(isStorableColorCode(0)).toBe(true)
    expect(isStorableColorCode(15)).toBe(true)
  })

  it('rejects the out-of-range codes live BrandMeister data carries', () => {
    // 16 and 17 both appear. The DM-32UV stores this in four bits, so 17 would
    // become 1: a channel that reads correctly and cannot key the repeater.
    expect(isStorableColorCode(16)).toBe(false)
    expect(isStorableColorCode(17)).toBe(false)
  })

  it('rejects anything that is not a whole number', () => {
    for (const cc of [-1, 1.5, '1', null, undefined, NaN]) {
      expect(isStorableColorCode(cc), String(cc)).toBe(false)
    }
  })
})
