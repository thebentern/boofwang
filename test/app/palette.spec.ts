// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The palette, checked as numbers rather than trusted as taste.
 *
 * Colour is the one part of an interface that can be adjusted by eye, in a
 * moment, by anyone - which is exactly why a contrast floor written down once
 * stops holding. This reads the shipped stylesheet, not a copy of the intended
 * values, so a hex edited in `main.css` is what gets measured.
 *
 * The floors are WCAG 2.1 AA: 4.5:1 for text, 3:1 for a graphic or an interface
 * boundary that carries meaning. They matter more here than on most sites - the
 * people programming these radios skew older, and this is the project that
 * already went and made its type larger for the same reason.
 *
 * Two of these assertions are not about contrast at all. One keeps the accent
 * and the danger colour far enough apart in *hue* to be told apart, which
 * luminance contrast cannot see and which two warm oranges will happily fail.
 * The other keeps hairlines at the weight they were tuned to, because a border
 * that quietly gains contrast turns a calm table into a grid.
 */

const CSS = readFileSync(fileURLToPath(new URL('../../app/assets/css/main.css', import.meta.url)), 'utf8')

/** The five colours the palette is, spelled as the source spells them. */
const PALETTE = {
  slateDeep: '#202C39',
  slate: '#283845',
  sage: '#B8B08D',
  wheat: '#F2D492',
  apricot: '#F29559',
} as const

// ------------------------------------------------------------------ colour --

const bytes = (hex: string) => {
  const h = hex.replace('#', '').slice(0, 6)
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16))
}
const channel = (c: number) => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = (hex: string) => {
  const [r, g, b] = bytes(hex).map(channel) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG 2.1 contrast ratio, 1 to 21. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const hue = (hex: string) => {
  const [r, g, b] = bytes(hex).map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}
/** Shortest way round the wheel, so 350 and 10 are 20 apart rather than 340. */
const hueGap = (a: string, b: string) => {
  const d = Math.abs(hue(a) - hue(b))
  return Math.min(d, 360 - d)
}

// ------------------------------------------------------- reading the sheet --

function tokensOf(startPattern: RegExp): Record<string, string> {
  const at = CSS.search(startPattern)
  expect(at, `no theme block matching ${startPattern}`).toBeGreaterThan(-1)
  const end = CSS.indexOf('\n}', at)
  const body = CSS.slice(at, end)
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6,8})\s*;/g)].map((m) => [m[1]!, m[2]!]),
  )
}

const THEMES = {
  dark: tokensOf(/^:root \{/m),
  light: tokensOf(/^:root\.light,/m),
}

describe('the palette is the one that was chosen', () => {
  it('uses all five colours literally, not approximations of them', () => {
    for (const [name, hex] of Object.entries(PALETTE)) {
      expect(CSS.includes(hex), `${name} ${hex} is not in the stylesheet`).toBe(true)
    }
  })

  it('uses both slates as the surface ramp they already are', () => {
    // The palette hands over two darks one step apart. Using them as the page
    // and the card it carries is the whole reason this scheme needed no
    // invented background.
    expect(THEMES.dark.bg).toBe(PALETTE.slateDeep)
    expect(THEMES.dark.pn).toBe(PALETTE.slate)
  })

  it('reads on paper in the palette’s own darkest', () => {
    expect(THEMES.light.tx).toBe(PALETTE.slateDeep)
  })

  it('spends the three brights on accent, not on risk', () => {
    // Semantic colours have to stay free to mean something. These three carry
    // identity; ok/cn/dg/in carry consequence, and they are not the same job.
    expect(THEMES.dark.ac).toBe(PALETTE.apricot)
    expect(THEMES.dark.ac2).toBe(PALETTE.wheat)
    expect(THEMES.dark.ac3).toBe(PALETTE.sage)
  })
})

describe.each(Object.entries(THEMES))('%s theme contrast', (theme, T) => {
  const pair = (fg: string, bg: string) => contrast(T[fg]!, T[bg]!)

  it('has every token the interface asks it for', () => {
    for (const k of ['bg', 'pn', 'pn2', 'pn3', 'ln', 'ln2', 'tx', 'mu', 'fn', 'ac', 'acTx', 'ac2', 'ac3', 'ok', 'okT', 'cn', 'dg', 'in', 'sd', 'sdT']) {
      expect(T[k], `${theme} is missing --${k}`).toBeDefined()
    }
  })

  it('reads at AA on every surface, in all three emphases', () => {
    for (const surface of ['bg', 'pn', 'pn3']) {
      expect(pair('tx', surface), `tx on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    for (const level of ['mu', 'fn']) {
      expect(pair(level, 'pn'), `${level} on pn`).toBeGreaterThanOrEqual(4.5)
      expect(pair(level, 'bg'), `${level} on bg`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the accent legible as a mark and as words', () => {
    // #F29559 clears both bars on the dark slate, which is unusual for a bright
    // accent and is why the logo, links and the focus ring can share a colour.
    // `--acTx` still exists as its own token because the light theme has to
    // darken it to #B4551F to stay readable on paper-white.
    expect(pair('ac', 'pn'), 'accent as a mark').toBeGreaterThanOrEqual(3)
    expect(pair('acTx', 'pn'), 'accent as text on a card').toBeGreaterThanOrEqual(4.5)
    expect(pair('acTx', 'bg'), 'accent as text on the page').toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the two secondary brights readable', () => {
    expect(pair('ac2', 'pn')).toBeGreaterThanOrEqual(4.5)
    expect(pair('ac3', 'pn')).toBeGreaterThanOrEqual(4.5)
  })

  it('puts readable text on both solid buttons', () => {
    // The safe action shipped white on green at 2.85:1 for the life of the
    // button. `--okT` is why it does not any more.
    expect(pair('sdT', 'sd'), 'neutral solid').toBeGreaterThanOrEqual(4.5)
    expect(pair('okT', 'ok'), 'safe solid').toBeGreaterThanOrEqual(4.5)
  })

  it('keeps every semantic hue readable', () => {
    for (const k of ['ok', 'cn', 'dg', 'in']) {
      expect(pair(k, 'pn'), `${k} on pn`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps danger far enough from the accent in hue to tell apart', () => {
    // Luminance contrast is blind to this: two orange-reds of the same
    // lightness score perfectly against each other and are indistinguishable.
    // "Brand" and "this could break your radio" must not be the same colour.
    expect(hueGap(T.ac!, T.dg!), 'accent vs danger').toBeGreaterThanOrEqual(25)
  })

  it('keeps hairlines at the weight they were tuned to', () => {
    // Borders are decoration here, not state, so they sit below the 3:1 an
    // interface boundary would need - deliberately, and the ceiling is the
    // point: a hairline that gains contrast turns a calm table into a grid.
    expect(pair('ln', 'pn'), 'hairline').toBeGreaterThan(1.1)
    expect(pair('ln', 'pn'), 'hairline').toBeLessThan(1.6)
    expect(pair('ln2', 'pn'), 'border').toBeGreaterThan(1.4)
    expect(pair('ln2', 'pn'), 'border').toBeLessThan(2.4)
  })

  it('separates each surface step from the one below it', () => {
    // Not a WCAG rule, a legibility one: a raised panel that measures the same
    // as the page is not raised, and the shadowless design has nothing else to
    // say so with.
    const steps = ['bg', 'pn', 'pn2', 'pn3'] as const
    for (let i = 1; i < steps.length; i++) {
      const lo = luminance(T[steps[i - 1]!]!)
      const hi = luminance(T[steps[i]!]!)
      expect(hi, `${steps[i]} should differ from ${steps[i - 1]}`).not.toBeCloseTo(lo, 4)
    }
  })
})

describe('print', () => {
  const paper = tokensOf(/@media print \{\s*:root,/m)

  it('drops the accent to ink rather than printing a terracotta rule', () => {
    // A mono laser renders it as a grey nobody can tell from a hairline.
    expect(paper.ac).toBe('#000000')
    expect(paper.acTx).toBe('#000000')
  })

  it('still puts readable text on the safe button', () => {
    expect(contrast(paper.okT!, paper.ok!)).toBeGreaterThanOrEqual(4.5)
  })
})
