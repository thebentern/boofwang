// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { ranges } from '#core/text/ranges.js'

describe('ranges', () => {
  it('shortens a run of three or more', () => {
    expect(ranges([1, 2, 3])).toBe('1 to 3')
    expect(ranges(Array.from({ length: 14 }, (_, i) => i + 1))).toBe('1 to 14')
  })

  it('lists anything shorter one by one', () => {
    expect(ranges([5])).toBe('5')
    expect(ranges([42, 43])).toBe('42 and 43')
    expect(ranges([3, 17])).toBe('3 and 17')
  })

  it('mixes runs and strays in one list', () => {
    expect(ranges([12, 15, 20, 21, 22])).toBe('12, 15, and 20 to 22')
    expect(ranges([32, 34, 35, 36, 38])).toBe('32, 34 to 36, and 38')
  })

  it('says nothing for nothing', () => {
    expect(ranges([])).toBe('')
  })
})
