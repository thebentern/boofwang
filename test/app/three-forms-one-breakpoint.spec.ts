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
  'components/connect/ConnectedCard.vue': read('../../app/components/connect/ConnectedCard.vue'),
}

const FORM = read('../../app/composables/useFormFactor.ts')

describe('one form-factor rule, in one file', () => {
  it('no component measures the viewport for itself', () => {
    /*
     * This used to assert that all six agreed on 640, which they did - and all
     * six were wrong the same way. A phone reports 448x997 upright and 1199x539
     * on its side, because the WebView rescales rather than changing device, so
     * width alone handed a six-inch screen the twelve-column table the moment
     * somebody rotated it.
     *
     * The rule now lives in one composable that keys on the shorter edge inside
     * a shell. What this asserts is that nobody reintroduces a local copy.
     */
    for (const [name, src] of Object.entries(FILES)) {
      expect(src, `${name} measures the viewport itself instead of using useFormFactor`).not.toMatch(
        /window\.innerWidth/,
      )
      expect(src, `${name} does not use the shared form factor`).toMatch(/useFormFactor\(\)/)
    }
  })

  it('asks the shorter edge whether it is a phone, and the width which band', () => {
    /*
     * Two different questions and they need different measurements. A phone
     * turned sideways is still a phone, which only its shorter edge knows. But
     * an 11-inch iPad is 834 upright and 1194 on its side and wants the middle
     * band in one and the full table in the other - so above the phone
     * boundary, width decides. Using the shorter edge for both demoted that
     * iPad to the middle band with 1194 points of width doing nothing.
     */
    expect(FORM).toMatch(/const shorter = inShell \? Math\.min\(width, el\.clientHeight\) : width/)
    expect(FORM).toMatch(/phone\.value = shorter < PHONE_BELOW/)
    expect(FORM).toMatch(/medium\.value = !phone\.value && width < DESKTOP_FROM/)
    // The window's own width property is not the layout width in this WebView:
    // measured on a Pixel it said 801 where clientWidth and visualViewport both
    // said 448.
    expect(FORM, 'measuring the window property again').not.toMatch(/window\.inner/)
    expect(FORM).toMatch(/shellProvidesTransports/)
  })

  it('listens for rotation, not only for resize', () => {
    // Android does not always fire resize before the WebView settles on its new
    // scale, and iOS is worse about it.
    expect(FORM).toMatch(/addEventListener\('orientationchange'/)
  })

  it('has exactly two boundaries, named once', () => {
    expect(FORM).toMatch(/const PHONE_BELOW = 640/)
    expect(FORM).toMatch(/const DESKTOP_FROM = 1024/)
    const numbers = [...FORM.matchAll(/\b(?:640|1024)\b/g)]
    expect(numbers.length, 'the boundaries are repeated instead of referenced').toBeLessThanOrEqual(4)
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
