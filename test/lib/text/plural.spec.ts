// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { plural } from '#core/text/plural.js'

describe('plural', () => {
  it('adds an s except for exactly one', () => {
    expect(plural(0, 'channel')).toBe('channels')
    expect(plural(1, 'channel')).toBe('channel')
    expect(plural(2, 'channel')).toBe('channels')
  })

  it('takes an irregular form', () => {
    expect(plural(1, 'It', 'They')).toBe('It')
    expect(plural(3, 'is', 'are')).toBe('are')
  })
})
