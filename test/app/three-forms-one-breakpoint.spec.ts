// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * That the mobile work agrees with itself about where a phone ends.
 *
 * Six components now change shape by width - the layout's tab bar, the status
 * bar, the channel table's rows and toolbar, the channel editor, the write
 * screen's confirmation and the diff footer - and each measures the viewport
 * for itself. That is the right call per component (a modal cannot ask its
 * parent, and `sm:` in a class does not help a virtualiser that needs a row
 * height in pixels), and it is exactly the arrangement that drifts: one of them
 * reads 768 six months from now and a phone gets a tab bar with a desktop
 * table under it.
 *
 * So the number is asserted rather than trusted. 640 is Tailwind's `sm`, which
 * the rest of the interface already uses, and 1024 is `lg`.
 */
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

const FILES = {
  'layouts/default.vue': read('../../app/layouts/default.vue'),
  'components/AppStatusBar.vue': read('../../app/components/AppStatusBar.vue'),
  'components/ChannelTable.vue': read('../../app/components/ChannelTable.vue'),
  'components/ChannelEditor.vue': read('../../app/components/ChannelEditor.vue'),
  'components/DiffList.vue': read('../../app/components/DiffList.vue'),
  'pages/write.vue': read('../../app/pages/write.vue'),
  'pages/channels.vue': read('../../app/pages/channels.vue'),
}

describe('one phone breakpoint, written down once per file', () => {
  it('every component that measures a viewport uses 640 or 1024, and nothing else', () => {
    /*
     * Two legitimate numbers: 640 is where a phone ends and 1024 is where the
     * middle band does. Everything else is drift, and the failure it produces
     * is a tab bar over a desktop table.
     */
    for (const [name, src] of Object.entries(FILES)) {
      const widths = [...src.matchAll(/innerWidth\s*[<>]=?\s*(\d+)/g)].map((m) => m[1])
      expect(widths.length, `${name} no longer measures the viewport`).toBeGreaterThan(0)
      for (const w of widths) expect(['640', '1024'], `${name} measures against ${w}`).toContain(w)
    }
  })

  it('nobody invented a second one', () => {
    // A stray 768 or 480 anywhere in these files is the drift this guards.
    for (const [name, src] of Object.entries(FILES)) {
      expect(src, `${name} has a competing breakpoint`).not.toMatch(/innerWidth\s*[<>]=?\s*(?!640\b|1024\b)\d+/)
    }
  })

  it('the middle band is bounded by 640 and 1024, not by a third number', () => {
    // Only two files know about the middle band: the status bar and the table.
    for (const name of ['components/AppStatusBar.vue', 'components/ChannelTable.vue']) {
      const src = FILES[name as keyof typeof FILES]
      expect(src, `${name} does not define a middle band`).toMatch(/innerWidth\s*>=\s*640/)
      expect(src, `${name} does not close the middle band at 1024`).toMatch(/innerWidth\s*<\s*1024/)
    }
  })
})

/**
 * The row forms, which the virtualiser has to be told about in pixels.
 *
 * `sm:` cannot express this: the virtualiser caches a row height per item and
 * renders absolutely positioned rows, so a height that only exists in CSS
 * would leave every row overlapping. All three heights are constants and the
 * cache is dropped when the form changes - both were defects found on a phone
 * rather than in review.
 */
describe('the channel table has three row forms', () => {
  const TABLE = FILES['components/ChannelTable.vue']

  it('names a height for each', () => {
    expect(TABLE).toMatch(/const ROW_HEIGHT = 30/)
    expect(TABLE).toMatch(/const PHONE_ROW_HEIGHT = 78/)
    expect(TABLE).toMatch(/const MEDIUM_ROW_HEIGHT = 52/)
  })

  it('re-measures when the form changes, or rows keep their first estimate', () => {
    expect(TABLE).toMatch(/watch\(rowHeight, \(\) => virtualizer\.value\.measure\(\)\)/)
  })

  it('drops the min-width floor wherever the row is a card', () => {
    // Left on, it made the body wider than the viewport and put the slot
    // number off the right edge, present in the DOM and unreachable.
    expect(TABLE).toMatch(/if \(narrow\.value \|\| medium\.value\) return 0/)
  })

  it('keeps printing on the table form at every width', () => {
    // A sheet of paper is not a phone, and the card drops the columns that a
    // printed channel list is for.
    expect(TABLE).toMatch(/if \(printing\.value\) return ROW_HEIGHT/)
    expect(TABLE).toMatch(/v-if="\(narrow \|\| medium\) && !printing"/)
  })
})
